import {
    prepareAsset,
    prepareAssets,
    initializeManifest,
    removePreparedAsset,
    createDictionary,
    compressDcb,
    decompressDcb,
    exportRelease,
    validateStoreDirectory,
    type EdgeManifest,
    type Asset,
} from 'compression-dictionary-toolkit';
import { createEdgeHandler, loadCloudflareObject } from 'compression-dictionary-toolkit/edge';
import sharedDictionary from 'compression-dictionary-toolkit/vite';
import { createDictionaryServer, createRequestHandler } from 'compression-dictionary-toolkit/server';
void prepareAsset({
    input: 'app.js',
    key: 'app',
    url: '/app.js',
    brotliQuality: 9,
    brotliBinary: 'brotli',
    dictionaryDelivery: 'separate',
    dictionaryEpoch: 'base-v1',
    dictionaryInput: 'base.js',
});
const batch: Promise<Asset[]> = prepareAssets([{ input: 'app.js', key: 'app', url: '/app.js' }], { concurrency: 2 });
void batch;
void compressDcb(Buffer.from('source'), 'dict', { quality: 9 });
void decompressDcb(Buffer.from('encoded'), 'dict', { brotliBinary: 'brotli' });
void createDictionary({ input: 'app.js', key: 'app', match: '/app*.js' });
sharedDictionary({
    concurrency: 2,
    dictionaryDelivery: 'asset',
    brotliQuality: 9,
    resolveAsset: ({ defaults }) => defaults,
    exclude: (file) => file.startsWith('parts/'),
});
void validateStoreDirectory({ outDir: 'dist', storeDir: '.dictionary-store' });
void initializeManifest('dist');
const removed: Promise<boolean> = removePreparedAsset({
    outDir: 'dist',
    url: '/app.js',
});
void removed;
createDictionaryServer({
    root: async () => 'dist',
    base: '/app/',
    logger: ({ status }) => console.log(status),
});
createRequestHandler({
    root: 'dist',
    serverTiming: true,
    base: '/app/',
    dictionaryEncodings: (req) => (req.url?.includes('dcb') ? ['dcb'] : ['dcz', 'dcb']),
});
void exportRelease({
    outDir: 'dist',
    targetDir: 'release',
    releaseId: 'build-1',
});
declare const edgeManifest: EdgeManifest;
createEdgeHandler({ manifest: edgeManifest, loadObject: loadCloudflareObject });
