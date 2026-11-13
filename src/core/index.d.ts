import type { Asset, Manifest, Representation } from '../shared/types.js';
export type { Asset, Manifest, Representation, PublishedDictionary, EdgeManifest } from '../shared/types.js';
export interface DictionaryOptions {
    input: string;
    storeDir?: string;
    key: string;
    match: string;
}
export interface Dictionary extends Representation {
    createdAt: string;
    key: string;
    match: string;
    path: string;
    availableDictionary: string;
}
export interface PrepareAssetOptions extends Omit<DictionaryOptions, 'match'> {
    outDir?: string;
    url: string;
    match?: string;
    historyLimit?: number;
    level?: number;
    dictionaryPolicy?: 'stable' | 'rolling';
    /** asset: reuse downloaded files (default); separate: fetch a dedicated base. */
    dictionaryDelivery?: 'asset' | 'separate';
    dictionaryEpoch?: string;
    dictionaryInput?: string;
    zstdBinary?: string;
    brotliBinary?: string;
    brotliQuality?: number;
    dictionaryBase?: string;
    cacheControl?: string;
}
export interface PrepareAssetsOptions {
    /** Concurrent assets, 1–16. Default: half the available CPUs, clamped to 1–4. */
    concurrency?: number;
}
export interface CodecOptions {
    hash?: string;
    level?: number;
    zstdBinary?: string;
}
export interface DcbCodecOptions {
    hash?: string;
    quality?: number;
    brotliBinary?: string;
}
export function createDictionary(options: DictionaryOptions): Promise<Dictionary>;
export function validateStoreDirectory(options: { outDir: string; storeDir: string }): Promise<void>;
export function prepareAsset(options: PrepareAssetOptions): Promise<Asset>;
export function prepareAssets(assets: PrepareAssetOptions[], options?: PrepareAssetsOptions): Promise<Asset[]>;
export function initializeManifest(outDir?: string): Promise<void>;
export function removePreparedAsset(options: { outDir?: string; url: string }): Promise<boolean>;
export function readManifest(outDir?: string): Promise<Manifest>;
export function compressDcz(input: Uint8Array, dictionaryPath: string, options?: CodecOptions): Promise<Buffer>;
export function decompressDcz(input: Uint8Array, dictionaryPath: string, options?: CodecOptions): Promise<Buffer>;
export function compressDcb(input: Uint8Array, dictionaryPath: string, options?: DcbCodecOptions): Promise<Buffer>;
export function decompressDcb(input: Uint8Array, dictionaryPath: string, options?: DcbCodecOptions): Promise<Buffer>;
export function digestHeader(hash: string): string;
export function matches(pattern: string, pathname: string): boolean;
export const DCZ_MAGIC: Buffer;
export const DCB_MAGIC: Buffer;
export function exportRelease(options: {
    outDir?: string;
    targetDir?: string;
    releaseId: string;
    base?: string;
}): Promise<{ manifestPath: string; objects: number; releaseId: string }>;
