import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { brotliDecompressSync } from 'node:zlib';
import {
    prepareAsset,
    readManifest,
    exportRelease,
    digestHeader,
    decompressDcb,
    decompressDcz,
} from 'compression-dictionary-toolkit';
import { createDictionaryServer, selectRepresentation } from 'compression-dictionary-toolkit/server';
import { createEdgeHandler } from 'compression-dictionary-toolkit/edge';
import { fixture, source, put, listen, request } from './helpers.mjs';

test('ordinary asset responses bootstrap dictionaries and a v1 client skips directly to v3 on Node and edge', async (t) => {
    const f = await fixture(t);
    const versions = [];
    for (const version of [1, 2, 3]) {
        versions.push(
            await prepareAsset({
                ...f,
                input: await put(f.outDir, `app-v${version}.js`, source(version)),
                url: `/app-v${version}.js`,
                key: 'app',
                match: '/app-*.js',
            })
        );
    }
    const [first, , latest] = versions;
    assert.equal(latest.dictionaryDelivery, 'asset');
    assert.equal(latest.dictionaryPolicy, 'rolling');
    assert.equal(latest.dictionaryHash, latest.hash);
    assert.equal(Object.keys(latest.dcb).length, 3);
    const port = await listen(t, createDictionaryServer({ root: f.outDir, allowInsecureLocalhost: true }));
    const targetDir = path.join(f.root, 'release');
    await exportRelease({ outDir: f.outDir, targetDir, releaseId: 'v3' });
    const edge = createEdgeHandler({
        manifest: JSON.parse(await readFile(path.join(targetDir, 'edge-manifest.json'))),
        loadObject: (file) => readFile(path.join(targetDir, file)),
    });
    const transports = [
        (url, headers) => request(port, url, headers),
        async (url, headers) => {
            const response = await edge(new Request(`https://example.test${url}`, { headers }));
            return {
                status: response.status,
                headers: Object.fromEntries(response.headers),
                body: Buffer.from(await response.arrayBuffer()),
            };
        },
    ];
    for (const get of transports) {
        // A new visitor downloads only the requested JS; its decoded bytes are the base.
        for (const asset of [first, latest]) {
            const cold = await get(asset.url, { 'accept-encoding': 'br,dcb,dcz' });
            assert.equal(cold.headers['content-encoding'], 'br');
            assert.equal(cold.headers.link, undefined);
            assert.equal(cold.headers['use-as-dictionary'], `match="/app-*.js", id="app-${asset.hash}", type=raw`);
            assert.match(cold.headers['cache-control'], /max-age=31536000/);
            assert.equal(cold.status, 200);
            assert.deepEqual(brotliDecompressSync(cold.body), source(asset === first ? 1 : 3));
        }
        for (const [encoding, decode] of [
            ['dcb', decompressDcb],
            ['dcz', decompressDcz],
        ]) {
            const next = await get(latest.url, {
                'accept-encoding': `${encoding},br`,
                'available-dictionary': digestHeader(first.hash),
            });
            assert.equal(next.headers['content-encoding'], encoding);
            assert.equal(next.headers.link, undefined);
            // Compression uses v1, but the decoded response advertises v3 as the next base.
            assert.ok(next.headers['use-as-dictionary'].includes(`id="app-${latest.hash}"`));
            assert.deepEqual(
                await decode(next.body, path.join(f.storeDir, 'dictionaries', `${first.hash}.dict`)),
                source(3)
            );
        }
    }
});

test('the existing byte selection sends the complete file when dictionary compression costs more', async (t) => {
    const f = await fixture(t);
    const options = { ...f, key: 'app', match: '/app-*.js' };
    const first = await prepareAsset({
        ...options,
        input: await put(f.outDir, 'app-v1.js', source()),
        url: '/app-v1.js',
    });
    const next = await prepareAsset({
        ...options,
        input: await put(f.outDir, 'app-v2.js', 'window.answer=42;'),
        url: '/app-v2.js',
    });
    const headers = {
        'accept-encoding': 'br,gzip,dcb,dcz',
        'available-dictionary': digestHeader(first.hash),
    };
    const selected = selectRepresentation(next, headers, true);
    assert.equal(selected.encoding, 'identity');
    assert.ok(selected.bytes < next.dcb[first.hash].bytes);
    assert.ok(selected.bytes < next.dcz[first.hash].bytes);
    const port = await listen(t, createDictionaryServer({ root: f.outDir, allowInsecureLocalhost: true }));
    const response = await request(port, next.url, headers);
    assert.equal(response.headers['content-encoding'], undefined);
    assert.equal(response.body.toString(), 'window.answer=42;');
    assert.ok(response.headers['use-as-dictionary'].includes(next.hash));
});

test('separate delivery keeps stable bases and revalidating asset cache policies available', async (t) => {
    const f = await fixture(t);
    let first;
    for (const version of [1, 2]) {
        const asset = await prepareAsset({
            ...f,
            input: await put(f.outDir, 'app.js', source(version)),
            url: '/app.js',
            key: 'app',
            dictionaryDelivery: 'separate',
        });
        first ??= asset;
        assert.equal(asset.dictionaryPolicy, 'stable');
        assert.equal(asset.dictionaryHash, first.hash);
        assert.equal(asset.cacheControl, 'public, max-age=0, must-revalidate');
    }
    const port = await listen(t, createDictionaryServer({ root: f.outDir, allowInsecureLocalhost: true }));
    const response = await request(port, '/app.js');
    assert.equal(response.headers['use-as-dictionary'], undefined);
    assert.equal(response.headers.link, `<${first.dictionaryUrl}>; rel="compression-dictionary"`);
});

test('asset delivery rejects incompatible dictionary and cache options before publication', async (t) => {
    const f = await fixture(t);
    const input = await put(f.outDir, 'app-v1.js', source());
    const options = {
        ...f,
        input,
        url: '/app-v1.js',
        key: 'app',
        dictionaryDelivery: 'asset',
    };
    for (const override of [
        { dictionaryDelivery: 'unknown' },
        { dictionaryPolicy: 'stable' },
        { dictionaryInput: input },
        { cacheControl: 'no-store' },
        { cacheControl: 'max-age=3600, no-cache' },
        { cacheControl: 'max-age=0, must-revalidate' },
        { cacheControl: 'max-age=0, stale-while-revalidate=60, must-revalidate' },
        { cacheControl: 'max-age=60, max-age=3600' },
    ])
        await assert.rejects(() => prepareAsset({ ...options, ...override }), /dictionary|Cache-Control|cacheControl/i);
    await assert.rejects(() => readManifest(f.outDir), /ENOENT/);
    await prepareAsset({
        ...options,
        cacheControl: 'max-age=0, stale-while-revalidate=60',
    });
    const file = path.join(f.outDir, '.cdt/manifest.json');
    const manifest = JSON.parse(await readFile(file));
    manifest.assets[options.url].dictionaryPolicy = 'stable';
    await writeFile(file, JSON.stringify(manifest));
    await assert.rejects(() => readManifest(f.outDir), /assetDictionary/);
});
