import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { prepareAsset, readManifest, decompressDcb, decompressDcz, digestHeader } from 'compression-dictionary-toolkit';
import { selectRepresentation } from 'compression-dictionary-toolkit/server';
import { fixture, source, put } from './helpers.mjs';

test('three updates reuse one base even after recreating dist', async (t) => {
    const f = await fixture(t);
    let first;
    for (let version = 1; version <= 4; version++) {
        await rm(f.outDir, { recursive: true, force: true });
        await mkdir(f.outDir);
        const input = await put(f.outDir, `app-${version}.js`, source(version));
        const asset = await prepareAsset({
            ...f,
            dictionaryPolicy: 'stable',
            input,
            url: `/app-${version}.js`,
            match: '/app-*.js',
            key: 'app',
        });
        first ??= asset;
        assert.equal(asset.dictionaryHash, first.hash);
        assert.equal(asset.dictionaryUrl, first.dictionaryUrl);
        for (const [encoding, decode] of [
            ['dcb', decompressDcb],
            ['dcz', decompressDcz],
        ]) {
            assert.deepEqual(Object.keys(asset[encoding]), [first.hash]);
            const encoded = await readFile(path.join(f.outDir, asset[encoding][first.hash].file));
            assert.deepEqual(
                await decode(encoded, path.join(f.storeDir, `dictionaries/${first.hash}.dict`)),
                source(version)
            );
        }
        assert.equal(Object.keys((await readManifest(f.outDir)).dictionaries).length, 1);
    }
    assert.equal((await readdir(path.join(f.storeDir, 'dictionaries'))).length, 1);
});

test('explicit rotation falls back with one base and retains compatibility with two', async (t) => {
    const f = await fixture(t);
    const options = {
        ...f,
        dictionaryPolicy: 'stable',
        key: 'app',
        url: '/app.js',
    };
    const input = await put(f.outDir, 'app.js', source());
    const first = await prepareAsset({
        ...options,
        input,
        dictionaryEpoch: 'base-1',
    });
    await put(f.outDir, 'app.js', source(2));
    const second = await prepareAsset({
        ...options,
        input,
        dictionaryEpoch: 'base-2',
    });
    assert.notEqual(second.dictionaryHash, first.dictionaryHash);
    const headers = {
        'accept-encoding': 'br,dcb,dcz',
        'available-dictionary': digestHeader(first.dictionaryHash),
    };
    assert.equal(selectRepresentation(second, headers, true).encoding, 'br');
    assert.equal(Object.keys((await readManifest(f.outDir)).dictionaries).length, 1);
    const bridge = await prepareAsset({
        ...options,
        input,
        dictionaryEpoch: 'base-2',
        historyLimit: 2,
    });
    assert.ok(['dcb', 'dcz'].includes(selectRepresentation(bridge, headers, true).encoding));
    assert.equal(Object.keys(bridge.dcb).length, 2);
    const rollback = await prepareAsset({
        ...options,
        input,
        dictionaryEpoch: 'base-1',
    });
    assert.equal(rollback.dictionaryHash, first.dictionaryHash);
});

test('a fixed base is reproducible without a store and immutable within its epoch', async (t) => {
    const f = await fixture(t);
    const dictionaryInput = await put(f.root, 'base.js', source());
    const input = await put(f.outDir, 'app.js', source(2));
    const options = {
        ...f,
        dictionaryPolicy: 'stable',
        input,
        dictionaryInput,
        key: 'app',
        url: '/app.js',
    };
    const first = await prepareAsset(options);
    await rm(f.storeDir, { recursive: true });
    const restored = await prepareAsset(options);
    assert.equal(restored.dictionaryHash, first.dictionaryHash);
    await put(f.root, 'base.js', source(3));
    await assert.rejects(() => prepareAsset(options), /dictionaryInput.*changed/);
    await assert.rejects(() => prepareAsset({ ...options, dictionaryPolicy: 'unknown' }), /dictionaryPolicy/);
    await assert.rejects(() => prepareAsset({ ...options, dictionaryPolicy: 'rolling' }), /requires/);
});
