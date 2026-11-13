import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { prepareAssets, digestHeader, decompressDcb } from 'compression-dictionary-toolkit';
import { createPlaygroundServer } from '../playground/server.mjs';
import { createDictionaryServer } from 'compression-dictionary-toolkit/server';
import { fixture, source, stylesheet, put, listen, request } from './helpers.mjs';

async function productFixture(t) {
    const f = await fixture(t);
    const productRoot = path.join(f.root, 'product');
    const assets = new Map();
    for (const version of ['v1', 'v2', 'v3', 'v4']) {
        const outDir = path.join(productRoot, version);
        const prepared = await prepareAssets(
            await Promise.all(
                [
                    ['js', source],
                    ['css', stylesheet],
                ].map(async ([extension, content]) => ({
                    outDir,
                    storeDir: f.storeDir,
                    input: await put(
                        outDir,
                        `assets/product-${version}.${extension}`,
                        content(Number(version.slice(1)))
                    ),
                    key: `product-${extension}`,
                    url: `/product/assets/product-${version}.${extension}`,
                    match: `/product/assets/product-*.${extension}`,
                }))
            )
        );
        assets.set(version, prepared);
    }
    return { ...f, productRoot, assets };
}

test('playground switches prepared releases without changing old URLs and isolates ordinary delivery', async (t) => {
    const f = await productFixture(t);
    const port = await listen(t, await createPlaygroundServer({ productRoot: f.productRoot }));
    const origin = `http://127.0.0.1:${port}`;
    const change = (version, requestOrigin = origin) =>
        fetch(`${origin}/api/version`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Origin': requestOrigin },
            body: JSON.stringify({ version }),
        });
    assert.equal((await fetch(`${origin}/api/state`).then((r) => r.json())).activeVersion, 'v1');
    const first = f.assets.get('v1')[0];
    const cold = await request(port, first.url, { 'accept-encoding': 'br,dcb,dcz' });
    assert.equal(cold.headers['content-encoding'], 'br');
    assert.ok(cold.headers['use-as-dictionary']);
    for (const version of ['v2', 'v3']) assert.equal((await change(version)).status, 200);
    const preview = await fetch(`${origin}/preview?run=example`).then((r) => r.text());
    assert.ok(preview.includes('data-version="v3"'));
    const latest = f.assets.get('v3')[0];
    const headers = { 'accept-encoding': 'br,dcb', 'available-dictionary': digestHeader(first.hash) };
    const shared = await request(port, latest.url, headers);
    assert.equal(shared.headers['content-encoding'], 'dcb');
    assert.match(shared.headers['server-timing'], /encoding;desc="dcb"/);
    assert.ok(shared.headers['server-timing'].includes(first.hash));
    assert.deepEqual(
        await decompressDcb(shared.body, path.join(f.storeDir, 'dictionaries', `${first.hash}.dict`)),
        source(3)
    );
    const baseline = await request(port, `/baseline${latest.url}`, headers);
    assert.equal(baseline.headers['content-encoding'], 'br');
    assert.equal(baseline.headers['use-as-dictionary'], undefined);
    assert.equal(baseline.headers.link, undefined);
    assert.ok(!baseline.headers['server-timing'].includes('dictionary;'));
    assert.equal((await change('v4')).status, 200);
    assert.equal((await request(port, first.url)).status, 200);
    const fourth = await request(port, f.assets.get('v4')[0].url, headers);
    assert.equal(fourth.headers['content-encoding'], 'br');
    assert.equal((await change('../outside')).status, 400);
    assert.equal((await change('v1', 'https://other.example')).status, 403);
    assert.equal((await fetch(`${origin}/api/state`).then((r) => r.json())).activeVersion, 'v4');
    assert.equal((await fetch(`${origin}/preview?mode=invalid`)).status, 400);
});

test('server timing is opt-in and its elapsed duration is nonnegative', async (t) => {
    const f = await fixture(t);
    await put(f.outDir, 'index.html', '<h1>Timing</h1>');
    const { initializeManifest } = await import('compression-dictionary-toolkit');
    await initializeManifest(f.outDir);
    for (const serverTiming of [false, true]) {
        const port = await listen(t, createDictionaryServer({ root: f.outDir, serverTiming }));
        const result = await request(port, '/');
        if (serverTiming)
            assert.match(result.headers['server-timing'], /^asset;dur=\d+\.\d+, encoding;desc="identity"$/);
        else assert.equal(result.headers['server-timing'], undefined);
    }
});
