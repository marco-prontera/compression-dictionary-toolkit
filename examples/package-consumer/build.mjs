import { build } from 'vite';
import sharedDictionary from 'compression-dictionary-toolkit/vite';
import { readManifest } from 'compression-dictionary-toolkit';
import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { results, versions, store, releaseDirectory } from './project.mjs';

export async function buildReleases() {
    // Only this consumer's generated fixtures are replaced.
    await rm(store, { recursive: true, force: true });
    const input = path.join(results, 'input');
    await mkdir(input, { recursive: true });
    await writeFile(
        path.join(input, 'index.html'),
        '<!doctype html><html><head><meta charset="utf-8"><title>Installed npm package</title></head><body><h1>Package consumer</h1><p id="version"></p><script type="module" src="/product.js"></script></body></html>'
    );
    const manifests = {};
    for (const version of versions) {
        const catalog = Array.from({ length: 400 }, (_, id) => ({
            id,
            sku: createHash('sha256').update(String(id)).digest('hex'),
            price: id === 7 ? Number(version.slice(1)) : id,
        }));
        await writeFile(
            path.join(input, 'product.js'),
            "import './product.css';\nglobalThis.consumerProduct = " +
                JSON.stringify({ version, catalog }) +
                ";\ndocument.querySelector('#version').textContent = globalThis.consumerProduct.version;\n"
        );
        await writeFile(
            path.join(input, 'product.css'),
            ':root{--product-version:"' +
                version +
                '"}\n' +
                Array.from(
                    { length: 250 },
                    (_, id) =>
                        '.swatch-' +
                        id +
                        '{color:#' +
                        createHash('sha256').update(String(id)).digest('hex').slice(0, 6) +
                        ';padding:' +
                        (id % 17) +
                        'px}'
                ).join('\n')
        );
        await build({
            root: input,
            configFile: false,
            logLevel: 'silent',
            plugins: [sharedDictionary({ storeDir: store, historyLimit: 3, concurrency: 2 })],
            build: { outDir: releaseDirectory(version), emptyOutDir: true, target: 'es2022' },
        });
        manifests[version] = await readManifest(releaseDirectory(version));
    }
    console.log('Built v1–v4 using the installed npm plugin');
    return manifests;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildReleases();
