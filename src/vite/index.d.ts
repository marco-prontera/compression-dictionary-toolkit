import type { Plugin } from 'vite';
export interface SharedDictionaryOptions {
    /** Concurrent assets, 1–16. Default: half the available CPUs, clamped to 1–4. */
    concurrency?: number;
    storeDir?: string;
    historyLimit?: number;
    level?: number;
    zstdBinary?: string;
    brotliBinary?: string;
    brotliQuality?: number;
    dictionaryPolicy?: 'stable' | 'rolling';
    dictionaryDelivery?: 'asset' | 'separate';
    dictionaryEpoch?: string;
    dictionaryBase?: string;
    cacheControl?: string;
    exclude?: (fileName: string) => boolean;
    resolveAsset?: (asset: {
        fileName: string;
        url: string;
        item: unknown;
        defaults: { key: string; match: string };
    }) => { key: string; match: string; dictionaryInput?: string } | false | undefined;
}
export function sharedDictionary(options?: SharedDictionaryOptions): Plugin;
export default sharedDictionary;
