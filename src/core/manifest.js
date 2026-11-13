import path from 'node:path';
import {
    MAX_DICTIONARY,
    readJSON,
    validatePath,
    validateKey,
    matches,
    validateDictionaryCacheControl,
} from './utils.js';

const MAX_REPRESENTATION = 128 * 1024 * 1024;
const invalid = (field) => new Error(`Invalid manifest: ${field}`);

function record(value, field) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(field);
    return value;
}

function hash(value, field) {
    if (typeof value !== 'string' || value.length !== 64 || !/^[a-f0-9]+$/.test(value)) throw invalid(field);
}

function file(value, field, prefix = '') {
    if (
        typeof value !== 'string' ||
        !value ||
        path.win32.isAbsolute(value) ||
        value.split('/').some((part) => !part || part === '.' || part === '..') ||
        // eslint-disable-next-line no-control-regex -- Metadata paths must not contain controls or Windows separators.
        /[\\\x00-\x1f\x7f]/.test(value) ||
        !value.startsWith(prefix) ||
        value === prefix
    )
        throw invalid(field);
}

function representation(value, field, prefix, maxBytes) {
    record(value, field);
    hash(value.hash, `${field}.hash`);
    file(value.file, `${field}.file`, prefix);
    if (!Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > maxBytes)
        throw invalid(`${field}.bytes`);
}

/** Validate every stored path and integrity record before consumers perform file operations. */
export function validateManifest(manifest) {
    record(manifest, 'root');
    record(manifest.assets, 'assets');
    record(manifest.dictionaries, 'dictionaries');
    for (const [url, dictionary] of Object.entries(manifest.dictionaries)) {
        validatePath(url);
        representation(dictionary, `dictionaries[${url}]`, '.cdt/dictionaries/', MAX_DICTIONARY);
    }
    for (const [url, asset] of Object.entries(manifest.assets)) {
        validatePath(url);
        const field = `assets[${url}]`;
        record(asset, field);
        if (asset.url !== url) throw invalid(`${field}.url`);
        file(asset.file, `${field}.file`);
        hash(asset.hash, `${field}.hash`);
        record(asset.representations, `${field}.representations`);
        for (const encoding of ['identity', 'br', 'gzip'])
            representation(
                asset.representations[encoding],
                `${field}.representations.${encoding}`,
                '.cdt/variants/',
                encoding === 'identity' ? MAX_DICTIONARY : MAX_REPRESENTATION
            );
        if (Object.keys(asset.representations).some((encoding) => !['identity', 'br', 'gzip'].includes(encoding)))
            throw invalid(`${field}.representations`);
        if (asset.hash !== asset.representations.identity.hash || asset.bytes !== asset.representations.identity.bytes)
            throw invalid(`${field}.identity`);
        const dictionary = Object.hasOwn(manifest.dictionaries, asset.dictionaryUrl)
            ? manifest.dictionaries[asset.dictionaryUrl]
            : undefined;
        if (!dictionary || (asset.dictionaryHash !== undefined && asset.dictionaryHash !== dictionary.hash))
            throw invalid(`${field}.dictionaryUrl`);
        if (asset.dictionaryDelivery !== undefined && !['asset', 'separate'].includes(asset.dictionaryDelivery)) {
            throw invalid(`${field}.dictionaryDelivery`);
        }
        if (asset.dictionaryDelivery === 'asset') {
            validateKey(asset.key);
            validatePath(dictionary.match, true);
            validateDictionaryCacheControl(asset.cacheControl);
            if (
                asset.dictionaryPolicy !== 'rolling' ||
                dictionary.key !== asset.key ||
                dictionary.hash !== asset.hash ||
                dictionary.bytes !== asset.bytes ||
                dictionary.id !== `${asset.key}-${asset.hash}` ||
                !matches(dictionary.match, url)
            ) {
                throw invalid(`${field}.assetDictionary`);
            }
        }
        for (const encoding of ['dcb', 'dcz']) {
            // Older manifests may omit dcb; their integrity records remain mandatory.
            for (const [dictionaryHash, variant] of Object.entries(
                record(asset[encoding] ?? {}, `${field}.${encoding}`)
            )) {
                hash(dictionaryHash, `${field}.${encoding} dictionary hash`);
                representation(
                    variant,
                    `${field}.${encoding}[${dictionaryHash}]`,
                    '.cdt/variants/',
                    MAX_REPRESENTATION
                );
                if (manifest.dictionaries[variant.dictionaryUrl]?.hash !== dictionaryHash)
                    throw invalid(`${field}.${encoding} dictionary reference`);
            }
        }
    }
    return manifest;
}

export async function loadManifest(outDir, fallback) {
    const manifest = await readJSON(path.join(outDir, '.cdt/manifest.json'), fallback, outDir);
    return manifest === null && fallback === null ? null : validateManifest(manifest);
}

export async function readManifest(outDir = 'dist') {
    const manifest = await loadManifest(path.resolve(outDir));
    // Old releases with only dcz remain readable; rebuilding adds the new dcb variants.
    for (const asset of Object.values(manifest.assets)) {
        asset.dcb ??= {};
        asset.dictionaryHash ??= manifest.dictionaries[asset.dictionaryUrl]?.hash;
        asset.dictionaryPolicy ??= 'rolling';
        asset.dictionaryDelivery ??= 'separate';
    }
    return manifest;
}
