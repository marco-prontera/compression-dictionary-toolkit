import { parseArgs } from 'node:util';
import { readManifest } from 'compression-dictionary-toolkit';
const {
    values: { version },
} = parseArgs({ options: { version: { type: 'string', default: 'v4' } } });
if (!['v1', 'v2', 'v3', 'v4'].includes(version)) throw new Error('Unknown version');
const manifest = await readManifest(new URL(`../playground/product/dist/${version}`, import.meta.url).pathname);
const rows = [];
for (const asset of Object.values(manifest.assets)) {
    for (const [dict, variant] of Object.entries(asset.dcz))
        rows.push({
            asset: asset.url,
            dictionary: dict.slice(0, 12),
            active: dict === asset.dictionaryHash,
            current: dict === asset.hash,
            original: asset.bytes,
            br: asset.representations.br.bytes,
            gzip: asset.representations.gzip.bytes,
            dcz: variant.bytes,
            dcb: asset.dcb[dict]?.bytes ?? 'not generated',
            smallestDictionaryEncoding: asset.dcb[dict] && asset.dcb[dict].bytes < variant.bytes ? 'dcb' : 'dcz',
            savingVsBr: `${(100 * (1 - Math.min(variant.bytes, asset.dcb[dict]?.bytes ?? Infinity) / asset.representations.br.bytes)).toFixed(1)}%`,
        });
}
console.table(rows);
