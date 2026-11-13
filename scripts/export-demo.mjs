import { parseArgs } from 'node:util';
import { exportRelease } from 'compression-dictionary-toolkit';

const {
    values: { version },
} = parseArgs({ options: { version: { type: 'string', default: 'v4' } } });
if (!['v1', 'v2', 'v3', 'v4'].includes(version)) throw new Error('Unknown version');
console.log(
    await exportRelease({
        outDir: `playground/product/dist/${version}`,
        targetDir: 'release',
        releaseId: `demo-${version}`,
        base: '/product/',
    })
);
