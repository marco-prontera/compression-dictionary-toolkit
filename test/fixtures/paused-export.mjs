import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { once } from 'node:events';
import path from 'node:path';
import { exportRelease } from 'compression-dictionary-toolkit';

const options = JSON.parse(process.argv[2]);
const manifestPath = path.join(await fs.realpath(options.targetDir), 'edge-manifest.json');
const rename = fs.rename;

// Pause between real metadata writes so the parent can attempt a competing export.
fs.rename = async (...args) => {
    await rename(...args);
    if (args[1] === manifestPath) {
        const resume = once(process, 'message');
        process.send('manifest-written');
        await resume;
    }
};
syncBuiltinESMExports();

try {
    await exportRelease(options);
} finally {
    fs.rename = rename;
    syncBuiltinESMExports();
    process.disconnect();
}
