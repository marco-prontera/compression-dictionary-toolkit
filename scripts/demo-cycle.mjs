import { buildDemo } from './demo.mjs';
import { readManifest } from 'compression-dictionary-toolkit';
import assert from 'node:assert/strict';

const history = new Map();
const rows = [];
for (const version of ['v1', 'v2', 'v3', 'v4']) {
    await buildDemo(version);
    const manifest = await readManifest(`playground/product/dist/${version}`);
    assert.equal(Object.keys(manifest.assets).length, 2);
    assert.ok(Object.keys(manifest.assets).some((url) => url.endsWith('.css')));
    assert.ok(Object.keys(manifest.assets).some((url) => url.endsWith('.js')));
    for (const asset of Object.values(manifest.assets)) {
        assert.equal(asset.dictionaryDelivery, 'asset');
        assert.equal(asset.dictionaryHash, asset.hash);
        const previous = history.get(asset.key) ?? [];
        if (previous.length) {
            assert.notEqual(asset.url, previous[0].url);
            assert.notEqual(asset.hash, previous[0].hash);
        }
        const retained = [asset, ...previous].slice(0, 3);
        for (const base of retained) {
            assert.ok(asset.dcb[base.hash]);
            assert.ok(asset.dcz[base.hash]);
        }
        history.set(asset.key, retained);
        const oldest = retained.at(-1);
        rows.push({
            version,
            key: asset.key,
            base: oldest.hash.slice(0, 12),
            dcb: asset.dcb[oldest.hash].bytes,
            dcz: asset.dcz[oldest.hash].bytes,
        });
    }
}
console.table(rows);
console.log(
    'Versioned files are their own dictionaries; three recent bases remain usable. Use the playground buttons to select an active release.'
);
