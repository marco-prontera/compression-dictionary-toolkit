import path from 'node:path';
import { resolveConcurrency, runConcurrent } from './tasks.js';
import { loadManifest, validateManifest } from './manifest.js';
import { promisify } from 'node:util';
import { brotliCompress, gzip, constants } from 'node:zlib';
import { compressDcz, compressDcb } from './codec.js';
import {
    confinedPath,
    digestHeader,
    emptyManifest,
    isPathInsideDirectory,
    matches,
    MAX_DICTIONARY,
    posix,
    readBoundedFile,
    readJSON,
    resolveDirectory,
    sha256,
    validateKey,
    validateDictionaryCacheControl,
    validatePath,
    validateStoreDirectory,
    withAssetLocks,
    withOutputLock,
    withStoreLock,
    writeFileAtomically,
    writeJSON,
} from './utils.js';

export { compressDcz, decompressDcz, DCZ_MAGIC, compressDcb, decompressDcb, DCB_MAGIC } from './codec.js';
export { digestHeader, matches, validateStoreDirectory } from './utils.js';
export { readManifest } from './manifest.js';
export { exportRelease } from './release.js';
const brotli = promisify(brotliCompress);
const gz = promisify(gzip);

async function inputBytes(input) {
    if (!/\.(?:[cm]?js|css)$/i.test(input)) throw new Error('Only .js, .mjs, .cjs, and .css files are supported');
    return readBoundedFile(
        input,
        MAX_DICTIONARY,
        `Input is empty or too large (${MAX_DICTIONARY}-byte limit): ${input}`
    );
}

function validateFamilyMatch(key, match, previous) {
    if (previous && previous.match !== match)
        throw new Error(
            `The match for ${key} has changed: use a new key to preserve the policy of existing dictionaries`
        );
}

async function register(bytes, options, registry) {
    const { storeDir, key, match } = options;
    validateKey(key);
    validatePath(match, true);
    const previous = Object.hasOwn(registry.groups, key) ? registry.groups[key] : undefined;
    validateFamilyMatch(key, match, previous);
    const hash = sha256(bytes);
    const file = `dictionaries/${hash}.dict`;
    const dictionaryPath = path.join(storeDir, file);
    await writeFileAtomically(dictionaryPath, bytes, storeDir);
    const entry = previous?.history.find((item) => item.hash === hash) ?? {
        hash,
        bytes: bytes.length,
        file,
        createdAt: new Date().toISOString(),
    };
    const history = [entry, ...(previous?.history ?? []).filter((item) => item.hash !== hash)];
    registry.groups[key] = { ...previous, match, history };
    return {
        ...entry,
        key,
        match,
        path: dictionaryPath,
        availableDictionary: digestHeader(hash),
    };
}

async function loadRegistry(storeDir) {
    return readJSON(path.join(storeDir, 'registry.json'), { schemaVersion: 1, groups: {} }, storeDir);
}

function pruneDictionaries(manifest) {
    const referenced = new Set(
        Object.values(manifest.assets).flatMap((item) => [
            item.dictionaryUrl,
            ...Object.values(item.dcb ?? {}).map((variant) => variant.dictionaryUrl),
            ...Object.values(item.dcz ?? {}).map((variant) => variant.dictionaryUrl),
        ])
    );
    for (const url of Object.keys(manifest.dictionaries)) if (!referenced.has(url)) delete manifest.dictionaries[url];
}

async function selectDictionary(
    bytes,
    { storeDir, key, match, dictionaryPolicy, dictionaryEpoch, dictionaryInput },
    registry
) {
    if (dictionaryPolicy === 'rolling') return register(bytes, { storeDir, key, match }, registry);
    const group = Object.hasOwn(registry.groups, key) ? registry.groups[key] : undefined;
    const epochs = group?.epochs ?? {};
    const existingHash = Object.hasOwn(epochs, dictionaryEpoch) ? epochs[dictionaryEpoch] : undefined;
    let seed = dictionaryInput ? await inputBytes(dictionaryInput) : bytes;
    if (existingHash) {
        const existing = group.history.find((entry) => entry.hash === existingHash);
        if (!existing) throw new Error(`Base ${dictionaryEpoch} is missing from history: restore the store`);
        const stored = await readBoundedFile(await confinedPath(storeDir, path.join(storeDir, existing.file)));
        if (sha256(stored) !== existingHash) throw new Error('Corrupted stable dictionary');
        if (dictionaryInput && sha256(seed) !== existingHash) {
            throw new Error('dictionaryInput has changed: increment dictionaryEpoch to rotate the base');
        }
        seed = stored;
    }
    const dictionary = await register(seed, { storeDir, key, match }, registry);
    registry.groups[key].epochs = {
        ...epochs,
        [dictionaryEpoch]: dictionary.hash,
    };
    return dictionary;
}

/** Persist the exact input bytes as a raw dictionary, without needing Vite or an encoder. */
export async function createDictionary({ input, storeDir = '.dictionary-store', key, match }) {
    const bytes = await inputBytes(input);
    storeDir = path.resolve(storeDir);
    return withStoreLock(storeDir, async () => {
        const registry = await loadRegistry(storeDir);
        const result = await register(bytes, { storeDir, key, match }, registry);
        await writeJSON(path.join(storeDir, 'registry.json'), registry, storeDir);
        return result;
    });
}

/** Publish one finished asset, retaining the same locking and failure guarantees as a batch. */
export async function prepareAsset(options) {
    const [asset] = await prepareAssets([options], { concurrency: 1 });
    return asset;
}

/** Prepare a bounded batch under one store/output transaction, preserving input order. */
export async function prepareAssets(assets, { concurrency } = {}) {
    const limit = resolveConcurrency(concurrency);
    if (!Array.isArray(assets)) {
        throw new Error('assets must be an array of preparation options');
    }
    if (assets.length === 0) {
        return [];
    }

    const options = await runConcurrent(
        assets.map((asset) => () => resolveAssetOptions(asset)),
        limit
    );
    const { storeDir, outDir } = options[0];
    if (options.some((asset) => asset.storeDir !== storeDir || asset.outDir !== outDir)) {
        throw new Error('A batch must use the same resolved storeDir and outDir');
    }

    return withAssetLocks(storeDir, outDir, async () => {
        const registry = await loadRegistry(storeDir);
        const manifest = await loadManifest(outDir, emptyManifest());
        let planning = Promise.resolve();

        const tasks = options.map((assetOptions) => () => {
            // Select shared bases in input order, independently of encoder completion order.
            const planned = planning.then(() => planAsset(assetOptions, registry, manifest));
            planning = planned.then(
                () => undefined,
                () => undefined
            );
            return planned.then(encodeAsset);
        });
        const prepared = await runConcurrent(tasks, limit);
        for (const { asset, dictionaries } of prepared) {
            manifest.assets[asset.url] = asset;
            Object.assign(manifest.dictionaries, dictionaries);
        }
        pruneDictionaries(manifest);
        validateManifest(manifest);

        // Copy originals in input order only after all encoders succeed. Keep buffers bounded.
        for (const { asset, options: assetOptions } of prepared) {
            if (assetOptions.copyOriginal) {
                const identity = await confinedPath(outDir, path.join(outDir, asset.representations.identity.file));
                await writeFileAtomically(assetOptions.original, await readBoundedFile(identity), outDir);
            }
        }
        await writeJSON(path.join(storeDir, 'registry.json'), registry, storeDir);
        await writeJSON(path.join(outDir, '.cdt/manifest.json'), manifest, outDir);
        return prepared.map(({ asset }) => asset);
    });
}

async function resolveAssetOptions({
    input,
    outDir = 'dist',
    storeDir = '.dictionary-store',
    url,
    key,
    match = url,
    dictionaryPolicy,
    dictionaryDelivery,
    dictionaryEpoch = 'v1',
    dictionaryInput,
    historyLimit,
    level = 10,
    zstdBinary,
    brotliQuality = 9,
    brotliBinary,
    dictionaryBase = '/__dictionaries/',
    cacheControl,
}) {
    dictionaryDelivery ??= dictionaryPolicy === 'stable' || dictionaryInput !== undefined ? 'separate' : 'asset';
    dictionaryPolicy ??= dictionaryDelivery === 'asset' ? 'rolling' : 'stable';
    historyLimit ??= dictionaryPolicy === 'stable' ? 1 : 3;
    cacheControl ??=
        dictionaryDelivery === 'asset' ? 'public, max-age=31536000, immutable' : 'public, max-age=0, must-revalidate';
    if (!['asset', 'separate'].includes(dictionaryDelivery)) {
        throw new Error('dictionaryDelivery must be asset or separate');
    }
    if (dictionaryDelivery === 'asset' && dictionaryPolicy !== 'rolling') {
        throw new Error('Asset dictionaries require dictionaryPolicy rolling');
    }
    if (dictionaryDelivery === 'asset') {
        validateDictionaryCacheControl(cacheControl);
    }
    validatePath(url);
    validatePath(match, true);
    validateKey(key);
    if (!['stable', 'rolling'].includes(dictionaryPolicy))
        throw new Error('dictionaryPolicy must be stable or rolling');
    validateKey(dictionaryEpoch);
    if (dictionaryPolicy === 'rolling' && dictionaryInput)
        throw new Error('dictionaryInput requires dictionaryPolicy stable');
    validatePath(dictionaryBase);
    if (!dictionaryBase.endsWith('/')) throw new Error('dictionaryBase must end with /');
    if (!matches(match, url)) throw new Error('match must include the current URL');
    if (!Number.isInteger(historyLimit) || historyLimit < 1 || historyLimit > 20)
        throw new Error('historyLimit must be between 1 and 20 (including the current dictionary)');
    if (/[\r\n]/.test(cacheControl)) throw new Error('Invalid Cache-Control');
    outDir = path.resolve(outDir);
    storeDir = path.resolve(storeDir);
    await validateStoreDirectory({ outDir, storeDir });
    const source = path.resolve(input);
    const copyOriginal = !isPathInsideDirectory(outDir, source);
    const original = copyOriginal ? path.join(outDir, url.slice(1)) : source;
    // Originals must never share the toolkit's metadata/immutable-object namespace.
    // Reserve the spelling case-insensitively, including before it exists on macOS/Windows.
    if (path.relative(outDir, original).split(path.sep)[0].toLowerCase() === '.cdt')
        throw new Error('Original assets cannot use the reserved .cdt directory');
    const [metadataDirectory, originalPath] = await Promise.all([
        resolveDirectory(path.join(outDir, '.cdt')),
        resolveDirectory(original),
    ]);
    if (isPathInsideDirectory(metadataDirectory, originalPath)) {
        throw new Error('Original assets cannot use the reserved .cdt directory');
    }
    return {
        input,
        outDir,
        storeDir,
        url,
        key,
        match,
        dictionaryPolicy,
        dictionaryDelivery,
        dictionaryEpoch,
        dictionaryInput,
        historyLimit,
        level,
        zstdBinary,
        brotliQuality,
        brotliBinary,
        dictionaryBase,
        cacheControl,
        original,
        copyOriginal,
    };
}

async function planAsset(options, registry, manifest) {
    const { input, key, match, historyLimit } = options;
    for (const published of Object.values(manifest.dictionaries)) {
        if (published.key === key) {
            validateFamilyMatch(key, match, published);
        }
    }
    const bytes = await inputBytes(input);
    const dictionary = await selectDictionary(bytes, options, registry);
    return {
        options,
        bytes,
        dictionary,
        history: registry.groups[key].history.slice(0, historyLimit),
    };
}

async function encodeAsset({ options, bytes, dictionary, history }) {
    const {
        input,
        outDir,
        storeDir,
        url,
        key,
        match,
        dictionaryPolicy,
        dictionaryDelivery,
        dictionaryEpoch,
        level,
        zstdBinary,
        brotliQuality,
        brotliBinary,
        dictionaryBase,
        cacheControl,
        original,
    } = options;
    const hash = sha256(bytes);
    const prefix = `.cdt/variants/${hash}`;
    const compressed = await runConcurrent(
        [() => brotli(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 9 } }), () => gz(bytes, { level: 9 })],
        2
    );
    const representations = {};
    for (const [encoding, data] of [
        ['identity', bytes],
        ['br', compressed[0]],
        ['gzip', compressed[1]],
    ]) {
        // Native codec upgrades can change the compressed bytes for an identical input.
        const wireHash = sha256(data);
        const file = encoding === 'identity' ? `${prefix}/identity` : `${prefix}/${wireHash}.${encoding}`;
        await writeFileAtomically(path.join(outDir, file), data, outDir);
        representations[encoding] = { file, bytes: data.length, hash: wireHash };
    }
    const dcz = {};
    const dcb = {};
    let dictionaryUrl;
    const dictionaries = {};
    for (const entry of history) {
        const dictPath = await confinedPath(storeDir, path.join(storeDir, entry.file));
        const raw = await readBoundedFile(dictPath);
        if (sha256(raw) !== entry.hash) throw new Error(`Corrupted dictionary: ${dictPath}`);
        const publicUrl = `${dictionaryBase}${key}/${entry.hash}.dict`;
        const file = `.cdt/dictionaries/${entry.hash}.dict`;
        await writeFileAtomically(path.join(outDir, file), raw, outDir);
        dictionaries[publicUrl] = {
            hash: entry.hash,
            key,
            match,
            file,
            bytes: raw.length,
            id: `${key}-${entry.hash}`,
            cacheControl: 'public, max-age=31536000, immutable',
        };
        if (entry.hash === dictionary.hash) dictionaryUrl = publicUrl;
        const encodedVariants = await runConcurrent(
            [
                () => compressDcz(bytes, dictPath, { hash: entry.hash, level, zstdBinary }),
                () =>
                    compressDcb(bytes, dictPath, {
                        hash: entry.hash,
                        quality: brotliQuality,
                        brotliBinary,
                    }),
            ],
            2
        );
        for (const [index, encoding] of ['dcz', 'dcb'].entries()) {
            const encoded = encodedVariants[index];
            // Include the wire hash so changing encoder settings never overwrites an active variant.
            const wireHash = sha256(encoded);
            const variantFile = `${prefix}/${entry.hash}-${wireHash}.${encoding}`;
            await writeFileAtomically(path.join(outDir, variantFile), encoded, outDir);
            (encoding === 'dcz' ? dcz : dcb)[entry.hash] = {
                file: variantFile,
                bytes: encoded.length,
                hash: wireHash,
                dictionaryUrl: publicUrl,
            };
        }
    }
    const asset = {
        key,
        url,
        file: posix(path.relative(outDir, original)),
        hash,
        bytes: bytes.length,
        contentType: /\.css$/i.test(input) ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8',
        cacheControl,
        dictionaryUrl,
        dictionaryHash: dictionary.hash,
        dictionaryPolicy,
        dictionaryDelivery,
        ...(dictionaryPolicy === 'stable' ? { dictionaryEpoch } : {}),
        representations,
        dcz,
        dcb,
    };
    return { asset, dictionaries, options };
}

/** Initialize an all-static output without replacing any existing manifest. */
export async function initializeManifest(outDir = 'dist') {
    outDir = path.resolve(outDir);
    return withOutputLock(outDir, async () => {
        const manifestPath = path.join(outDir, '.cdt/manifest.json');
        if (!(await loadManifest(outDir, null))) await writeJSON(manifestPath, emptyManifest(), outDir);
    });
}

/** Stop negotiating an asset, preserving original files, immutable objects, and stored history. */
export async function removePreparedAsset({ outDir = 'dist', url }) {
    validatePath(url);
    outDir = path.resolve(outDir);
    return withOutputLock(outDir, async () => {
        const manifestPath = path.join(outDir, '.cdt/manifest.json');
        const previous = await loadManifest(outDir, null);
        const manifest = previous ?? emptyManifest();
        const existed = Object.hasOwn(manifest.assets, url);
        if (previous && !existed) return false;
        delete manifest.assets[url];
        pruneDictionaries(manifest);
        // An all-static build still needs a manifest for the serving and export APIs.
        await writeJSON(manifestPath, manifest, outDir);
        return existed;
    });
}
