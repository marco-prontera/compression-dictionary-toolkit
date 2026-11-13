import { build } from 'vite';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readManifest } from 'compression-dictionary-toolkit';
import { releases } from './releases.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
export async function buildProduct(version) {
    const release = releases[version];
    if (!Object.hasOwn(releases, version)) throw new Error('Use v1, v2, v3, or v4');
    const generated = path.join(root, '.generated');
    await mkdir(generated, { recursive: true });
    const catalog = Array.from({ length: 650 }, (_, i) => ({
        id: i,
        sku: createHash('sha256').update(`product-${i}`).digest('hex').slice(0, 32),
        label: ['Everyday tote', 'Travel flask', 'Desk notebook'][i % 3],
        category: ['Home', 'Travel', 'Work'][i % 3],
        price: ((i * 137) % 10000) / 100 + (i === 7 ? Number(version.slice(1)) : 0),
        description: createHash('sha256').update(`description-${i}`).digest('hex'),
    }));
    await writeFile(
        path.join(generated, 'catalog.js'),
        `export const catalog = ${JSON.stringify(catalog)};\nexport const headline = ${JSON.stringify(release.label)};\n`
    );
    const palette = Array.from({ length: 450 }, (_, i) => {
        const color = createHash('sha256').update(`palette-${i}`).digest('hex').slice(0, 6);
        return `.palette-${i}{--swatch:#${color};--sample:"${color}-${i}";margin:${i % 19}px;padding:${i % 13}px}`;
    }).join('\n');
    await writeFile(
        path.join(generated, 'theme.css'),
        `:root{--product-version:"${version}";--accent:${release.accent}}\n${palette}`
    );
    process.env.PRODUCT_VERSION = version;
    await build({ configFile: path.join(root, 'vite.config.mjs') });
    const outDir = path.join(root, 'dist', version);
    const manifest = await readManifest(outDir);
    const assets = Object.values(manifest.assets).map(({ key, url, hash, bytes }) => ({ key, url, hash, bytes }));
    console.log(`Product ${version}: ${assets.length} prepared JS/CSS assets`);
    return outDir;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const { values } = parseArgs({ options: { version: { type: 'string', default: 'all' } } });
    for (const version of values.version === 'all' ? Object.keys(releases) : [values.version])
        await buildProduct(version);
}
