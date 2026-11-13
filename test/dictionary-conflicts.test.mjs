import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createDictionary, prepareAsset, readManifest } from 'compression-dictionary-toolkit';
import { fixture, put, source } from './helpers.mjs';

for (const dictionaryPolicy of ['stable', 'rolling'])
    test(`separate stores cannot change a published family's match (${dictionaryPolicy})`, async (t) => {
        const f = await fixture(t);
        const input = await put(f.root, 'input.js', source());
        const first = await prepareAsset({ ...f, input, key: 'app', url: '/a.js', dictionaryPolicy });
        const storeDir = path.join(f.root, 'second-store');
        await createDictionary({ input, storeDir, key: 'app', match: '/b.js' });
        const manifestPath = path.join(f.outDir, '.cdt/manifest.json');
        const registryPath = path.join(storeDir, 'registry.json');
        const manifestBefore = await readFile(manifestPath);
        const registryBefore = await readFile(registryPath);
        const filesBefore = (await readdir(f.outDir, { recursive: true })).sort();
        const storeFilesBefore = (await readdir(storeDir, { recursive: true })).sort();

        await assert.rejects(
            () => prepareAsset({ ...f, input, storeDir, key: 'app', url: '/b.js', dictionaryPolicy }),
            /match for app has changed.*new key/
        );
        assert.deepEqual(await readFile(manifestPath), manifestBefore);
        assert.deepEqual(await readFile(registryPath), registryBefore);
        assert.deepEqual((await readdir(f.outDir, { recursive: true })).sort(), filesBefore);
        assert.deepEqual((await readdir(storeDir, { recursive: true })).sort(), storeFilesBefore);
        assert.deepEqual(await readFile(path.join(f.outDir, first.representations.identity.file)), source());

        // A distinct family resolves the conflict, and the failed call must release its locks.
        const second = await prepareAsset({ ...f, input, storeDir, key: 'other', url: '/b.js', dictionaryPolicy });
        const manifest = await readManifest(f.outDir);
        assert.equal(manifest.dictionaries[first.dictionaryUrl].match, '/a.js');
        assert.equal(manifest.dictionaries[second.dictionaryUrl].match, '/b.js');
        assert.notEqual(second.dictionaryUrl, first.dictionaryUrl);
        assert.equal(Object.keys(manifest.assets).length, 2);
    });

test('concurrent stores reject conflicting family policies while retaining the winning asset', async (t) => {
    const f = await fixture(t);
    const input = await put(f.root, 'input.js', source());
    const results = await Promise.allSettled(
        ['a', 'b'].map((name) =>
            prepareAsset({
                ...f,
                input,
                storeDir: path.join(f.root, `store-${name}`),
                key: 'app',
                url: `/${name}.js`,
            })
        )
    );
    const successful = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    assert.equal(successful.length, 1);
    assert.equal(rejected.length, 1);
    assert.match(rejected[0].reason.message, /match for app has changed.*new key/);
    const asset = successful[0].value;
    const manifest = await readManifest(f.outDir);
    assert.deepEqual(Object.keys(manifest.assets), [asset.url]);
    assert.deepEqual(Object.keys(manifest.dictionaries), [asset.dictionaryUrl]);
    assert.equal(manifest.dictionaries[asset.dictionaryUrl].match, asset.url);
});

test('separate stores can share a dictionary when the family policy is identical', async (t) => {
    const f = await fixture(t);
    const input = await put(f.root, 'input.js', source());
    const assets = await Promise.all(
        ['a', 'b'].map((name) =>
            prepareAsset({
                ...f,
                input,
                storeDir: path.join(f.root, `store-${name}`),
                key: 'app',
                url: `/assets/${name}.js`,
                match: '/assets/*.js',
            })
        )
    );
    assert.equal(assets[0].dictionaryUrl, assets[1].dictionaryUrl);
    const manifest = await readManifest(f.outDir);
    assert.equal(Object.keys(manifest.assets).length, 2);
    assert.equal(Object.keys(manifest.dictionaries).length, 1);
    assert.equal(manifest.dictionaries[assets[0].dictionaryUrl].match, '/assets/*.js');
});
