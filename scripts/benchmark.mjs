import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { availableParallelism } from 'node:os';
import { performance } from 'node:perf_hooks';
import * as core from 'compression-dictionary-toolkit';
import sharedDictionary from 'compression-dictionary-toolkit/vite';
import { build } from 'vite';

const limits = process.argv.slice(2).length ? process.argv.slice(2).map(Number) : [1, 4];
if (limits.some((limit) => !Number.isInteger(limit) || limit < 1 || limit > 16)) {
    throw new Error('Pass concurrency limits from 1 to 16, for example: npm run benchmark -- 1 4');
}
const parent = path.resolve('test-results');
await mkdir(parent, { recursive: true });
const root = await mkdtemp(path.join(parent, 'benchmark-'));
const records = Array.from({ length: 2500 }, (_, i) => ({
    id: i,
    token: createHash('sha256').update(String(i)).digest('hex'),
    label: 'Catalog item ' + i,
}));
const input = {};
let sourceBytes = 0;
try {
    for (let index = 0; index < 8; index++) {
        const name = 'entry-' + index;
        const content =
            'window.catalog' + index + '=' + JSON.stringify(records.map((row) => ({ ...row, group: index }))) + ';';
        input[name] = path.join(root, name + '.js');
        await writeFile(input[name], content);
        sourceBytes += Buffer.byteLength(content);
    }
    const results = [];
    for (const concurrency of limits) {
        for (const mode of ['core', 'vite']) {
            const times = [];
            for (let run = 0; run < 4; run++) {
                const directory = path.join(root, mode + '-' + concurrency + '-' + run);
                const outDir = path.join(directory, 'dist');
                const storeDir = path.join(directory, 'store');
                const start = performance.now();
                if (mode === 'core') {
                    const assets = Object.entries(input).map(([name, file]) => ({
                        input: file,
                        outDir,
                        storeDir,
                        key: name,
                        url: '/' + name + '.js',
                    }));
                    await core.prepareAssets(assets, { concurrency });
                } else {
                    await build({
                        root,
                        configFile: false,
                        logLevel: 'silent',
                        plugins: [sharedDictionary({ storeDir, concurrency })],
                        build: { outDir, emptyOutDir: true, rolldownOptions: { input } },
                    });
                }
                const elapsed = performance.now() - start;
                const manifest = await core.readManifest(outDir);
                if (Object.keys(manifest.assets).length !== 8) throw new Error('Missing benchmark assets');
                if (run > 0) times.push(Math.round(elapsed));
                await rm(directory, { recursive: true, force: true });
            }
            const medianMs = [...times].sort((a, b) => a - b)[1];
            const result = { mode, concurrency, samplesMs: times, medianMs };
            results.push(result);
            console.log(JSON.stringify(result));
        }
    }
    console.log(
        JSON.stringify({
            node: process.versions.node,
            availableParallelism: availableParallelism(),
            assets: 8,
            sourceBytes,
            warmups: 1,
            runs: 3,
            results,
        })
    );
} finally {
    await rm(root, { recursive: true, force: true });
}
