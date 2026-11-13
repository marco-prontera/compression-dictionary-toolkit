import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { once } from 'node:events';
import path from 'node:path';
import { prepareAsset } from 'compression-dictionary-toolkit';

const options = JSON.parse(process.argv[2]);
const manifestPath = path.join(options.outDir, '.cdt/manifest.json');
const open = fs.open;

// Pause a real preparation after it reads the manifest, while its locks must be held.
// IPC lets the parent exercise a competing call without relying on encoder speed or sleeps.
fs.open = async (file, ...args) => {
    const handle = await open(file, ...args);
    if (file === manifestPath) {
        const close = handle.close.bind(handle);
        handle.close = async () => {
            await close();
            const resume = once(process, 'message');
            process.send('manifest-read');
            await resume;
        };
    }
    return handle;
};
syncBuiltinESMExports();

try {
    await prepareAsset(options);
} finally {
    fs.open = open;
    syncBuiltinESMExports();
    process.disconnect();
}
