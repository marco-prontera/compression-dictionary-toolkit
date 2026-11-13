import path from 'node:path';
import { constants } from 'node:fs';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import {
    initializeManifest,
    prepareAssets,
    readManifest,
    removePreparedAsset,
    validateStoreDirectory,
} from '../core/index.js';

async function resolveAssetPath(rootDirectory, fileName) {
    const [directoryPath, filePath] = await Promise.all([
        realpath(rootDirectory),
        realpath(path.join(rootDirectory, fileName)),
    ]);
    const relativePath = path.relative(directoryPath, filePath);
    const [firstSegment] = relativePath.split(path.sep);

    if (path.isAbsolute(relativePath) || firstSegment === '..') {
        throw new Error(`Asset file is outside its configured directory: ${fileName}`);
    }

    return filePath;
}

async function assetHash(file) {
    const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
        const info = await handle.stat();
        if (!info.isFile()) throw new Error(`Expected a regular asset file: ${file}`);
        const hash = createHash('sha256');
        let bytes = 0;
        for await (const chunk of handle.createReadStream({ autoClose: false })) {
            bytes += chunk.length;
            if (bytes > info.size) throw new Error(`Asset changed during read: ${file}`);
            hash.update(chunk);
        }
        if (bytes !== info.size) throw new Error(`Asset changed during read: ${file}`);
        return hash.digest('hex');
    } finally {
        await handle.close();
    }
}

async function invalidateCopiedAssets(outDir, publicDir) {
    let manifest;
    try {
        manifest = await readManifest(outDir);
    } catch (error) {
        if (error.code === 'ENOENT') return;
        throw error;
    }
    for (const asset of Object.values(manifest.assets)) {
        const copied = await resolveAssetPath(publicDir, asset.file)
            .then((file) => stat(file))
            .catch((error) => {
                if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return;
                throw error;
            });
        if (!copied?.isFile()) continue;
        // Public files bypass writeBundle. Compare final output bytes to preserve unchanged preparations.
        if ((await assetHash(await resolveAssetPath(outDir, asset.file))) !== asset.hash)
            await removePreparedAsset({ outDir, url: asset.url });
    }
}

/** Add once to plugins; finished build outputs are processed automatically. */
export function sharedDictionary(options = {}) {
    if (
        options.concurrency !== undefined &&
        (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 16)
    ) {
        throw new Error('concurrency must be an integer between 1 and 16');
    }
    let config;
    let outDir;
    let storeDir;
    let wroteOutput = false;
    // Rolldown can call buildStart per format; retain all written outputs until closeBundle.
    const emitted = new Map();
    const workerChunks = new Map();
    return {
        name: 'compression-dictionary-toolkit/vite',
        apply: 'build',
        enforce: 'post',
        config(userConfig) {
            const workerPlugins = userConfig.worker?.plugins;
            workerChunks.clear();
            return {
                worker: {
                    plugins: () => [
                        typeof workerPlugins === 'function' ? workerPlugins() : (workerPlugins ?? []),
                        {
                            name: 'shared-dictionary-worker-metadata',
                            enforce: 'post',
                            generateBundle: {
                                order: 'post',
                                handler(output, bundle) {
                                    // Vite later exposes worker chunks as nameless assets in the main bundle.
                                    for (const [fileName, item] of Object.entries(bundle))
                                        if (item.type === 'chunk') workerChunks.set(fileName, item.name);
                                },
                            },
                        },
                    ],
                },
            };
        },
        async configResolved(resolved) {
            config = resolved;
            if (config.build.ssr) throw new Error('sharedDictionary only supports client builds');
            if (!config.base.startsWith('/') || config.base.startsWith('//') || !config.base.endsWith('/')) {
                throw new Error('sharedDictionary requires an absolute same-origin base, such as / or /app/');
            }
            outDir = path.resolve(config.root, config.build.outDir);
            storeDir = path.resolve(config.root, options.storeDir ?? '.dictionary-store');
            // Vite cleans bundler output directories before writeBundle can reject an override.
            const outputs = (config.build.rolldownOptions ?? config.build.rollupOptions)?.output;
            for (const output of Array.isArray(outputs) ? outputs : [outputs]) {
                // Cleanup resolves from the Vite root; bundler writes resolve from the process directory.
                if (
                    output?.dir &&
                    (path.resolve(config.root, output.dir) !== outDir || path.resolve(output.dir) !== outDir)
                )
                    throw new Error('Multiple output directories are not supported: use one build per outDir');
            }
            await validateStoreDirectory({ outDir, storeDir });
            if (config.publicDir && config.build.copyPublicDir) {
                const metadata = await lstat(path.join(config.publicDir, '.cdt')).catch((error) => {
                    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
                });
                if (metadata) throw new Error('publicDir must not contain the reserved .cdt path');
            }
        },
        writeBundle: {
            order: 'post',
            handler(output, bundle) {
                if (output.dir && path.resolve(output.dir) !== outDir)
                    throw new Error('Multiple output directories are not supported: use one build per outDir');
                wroteOutput = true;
                for (const [fileName, item] of Object.entries(bundle)) {
                    if (!/\.(?:[cm]?js|css)$/i.test(fileName)) continue;
                    emitted.set(fileName, item);
                }
            },
        },
        closeBundle: {
            order: 'post',
            sequential: true,
            async handler() {
                if (!wroteOutput) return;
                wroteOutput = false;
                const files = [...emitted.entries()];
                emitted.clear();
                if (config.publicDir && config.build.copyPublicDir)
                    await invalidateCopiedAssets(outDir, config.publicDir);
                if (files.length === 0) {
                    await initializeManifest(outDir);
                    return;
                }
                const assets = [];
                for (const [fileName, item] of files) {
                    const url = `${config.base}${fileName}`;
                    const input = path.join(outDir, fileName);
                    if (options.exclude?.(fileName) || (await stat(input)).size === 0) {
                        await removePreparedAsset({ outDir, url });
                        continue;
                    }
                    // Preserve logical names, including worker chunks captured before Vite emits them as assets.
                    const ext = path.posix.extname(fileName);
                    const directory = path.posix.dirname(fileName);
                    const prefix = directory === '.' ? config.base : `${config.base}${directory}/`;
                    const isChunk = item.type === 'chunk' || workerChunks.has(fileName);
                    const logicalName =
                        workerChunks.get(fileName) ??
                        (item.type === 'chunk' ? item.name : (item.names?.[0] ?? item.name));
                    // Chunk names already omit their extension; dots belong to the logical name.
                    const stem =
                        logicalName && path.posix.basename(logicalName, isChunk ? '' : path.posix.extname(logicalName));
                    const basename = path.posix.basename(fileName);
                    const group =
                        stem && basename.startsWith(`${stem}-`) && basename.endsWith(ext)
                            ? `${prefix}${stem}-*${ext}`
                            : url;
                    const short = createHash('sha256').update(group).digest('hex').slice(0, 12);
                    const defaults = {
                        key: `vite-${ext.slice(1)}-${short}`,
                        match: group,
                    };
                    const resolved = options.resolveAsset?.({
                        fileName,
                        url,
                        item,
                        defaults,
                    });
                    if (resolved === false) {
                        await removePreparedAsset({ outDir, url });
                        continue;
                    }
                    assets.push({
                        input,
                        outDir,
                        storeDir,
                        url,
                        ...defaults,
                        ...resolved,
                        historyLimit: options.historyLimit,
                        level: options.level,
                        dictionaryPolicy: options.dictionaryPolicy,
                        dictionaryDelivery: options.dictionaryDelivery,
                        dictionaryEpoch: options.dictionaryEpoch,
                        dictionaryInput: resolved?.dictionaryInput
                            ? path.resolve(config.root, resolved.dictionaryInput)
                            : undefined,
                        zstdBinary: options.zstdBinary,
                        dictionaryBase: options.dictionaryBase,
                        brotliBinary: options.brotliBinary,
                        brotliQuality: options.brotliQuality,
                        cacheControl: options.cacheControl,
                    });
                }
                await prepareAssets(assets, { concurrency: options.concurrency });
            },
        },
    };
}

export default sharedDictionary;
