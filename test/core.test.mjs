import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import {
    createDictionary,
    prepareAsset,
    readManifest,
    compressDcz,
    decompressDcz,
    DCZ_MAGIC,
    compressDcb,
    decompressDcb,
    DCB_MAGIC,
    digestHeader,
} from 'compression-dictionary-toolkit';
import { fixture, source, put } from './helpers.mjs';

test('a file produces identical persistent raw dictionary bytes addressed by SHA-256', async (t) => {
    const f = await fixture(t);
    const input = await put(f.outDir, 'app.js', source());
    const dictionary = await createDictionary({ input, storeDir: f.storeDir, key: 'app', match: '/app*.js' });
    assert.deepEqual(await readFile(dictionary.path), source());
    assert.equal(dictionary.availableDictionary, digestHeader(dictionary.hash));
    assert.equal(
        (await createDictionary({ input, storeDir: f.storeDir, key: 'app', match: '/app*.js' })).hash,
        dictionary.hash
    );
    const registry = JSON.parse(await readFile(path.join(f.storeDir, 'registry.json')));
    assert.equal(registry.groups.app.history.length, 1);
});

test('dcz has correct magic and hash, uses the old dictionary, and restores every byte', async (t) => {
    const f = await fixture(t);
    const input = await put(f.outDir, 'app.js', source());
    const dictionary = await createDictionary({ input, storeDir: f.storeDir, key: 'app', match: '/app.js' });
    const encoded = await compressDcz(source(2), dictionary.path);
    assert.deepEqual(encoded.subarray(0, 8), DCZ_MAGIC);
    assert.equal(encoded.subarray(8, 40).toString('hex'), dictionary.hash);
    assert.deepEqual(await decompressDcz(encoded, dictionary.path), source(2));
    assert.ok(encoded.length < source(2).length / 50);
    const wrong = await put(f.outDir, 'wrong.js', source(3));
    await assert.rejects(() => decompressDcz(encoded, wrong), /hash mismatch/);
    await assert.rejects(() => decompressDcz(encoded.subarray(1), dictionary.path), /header/);
    const corrupt = Buffer.from(encoded);
    corrupt[corrupt.length - 1] ^= 0xff;
    await assert.rejects(() => decompressDcz(corrupt, dictionary.path), /zstd/);
});

test('dcb uses real Shared Brotli, a 36-byte header, and the same raw dictionary as dcz', async (t) => {
    const f = await fixture(t);
    const dictionary = await createDictionary({
        input: await put(f.outDir, 'app.js', source()),
        storeDir: f.storeDir,
        key: 'app',
        match: '/app.js',
    });
    const encoded = await compressDcb(source(2), dictionary.path);
    const zstd = await compressDcz(source(2), dictionary.path);
    assert.deepEqual(encoded.subarray(0, 4), DCB_MAGIC);
    assert.deepEqual(encoded.subarray(4, 36), zstd.subarray(8, 40));
    assert.deepEqual(await decompressDcb(encoded, dictionary.path), source(2));
    assert.ok(encoded.length < source(2).length / 50);
    // An ordinary Brotli decoder has no external dictionary and cannot decode these bytes.
    assert.throws(() => brotliDecompressSync(encoded.subarray(36)));
    const wrong = await put(f.outDir, 'wrong.js', source(3));
    await assert.rejects(() => decompressDcb(encoded, wrong), /hash mismatch/);
    await assert.rejects(() => decompressDcb(encoded.subarray(1), dictionary.path), /Invalid dcb header/);
    await assert.rejects(() => decompressDcb(encoded.subarray(0, 37), dictionary.path), /brotli/);
    await assert.rejects(() => compressDcb(source(), dictionary.path, { hash: '0'.repeat(64) }), /Hash/);
    await assert.rejects(() => compressDcb(source(), dictionary.path, { quality: 12 }), /quality/);
    await assert.rejects(
        () => compressDcb(source(), dictionary.path, { brotliBinary: path.join(f.root, 'missing-brotli') }),
        /Install Brotli/
    );
});

for (const extension of ['js', 'css'])
    test(`history survives cleaning dist and renaming the asset (${extension})`, async (t) => {
        const f = await fixture(t);
        const bytes = extension === 'js' ? source() : Buffer.from('.test{color:red;padding:10px}\n'.repeat(500));
        const firstInput = await put(f.outDir, `app-old.${extension}`, bytes);
        const options = { ...f, key: 'app', match: `/app-*.${extension}` };
        const first = await prepareAsset({ ...options, input: firstInput, url: `/app-old.${extension}` });
        await rm(f.outDir, { recursive: true });
        await mkdir(f.outDir);
        const next = Buffer.concat([
            bytes,
            Buffer.from(extension === 'js' ? '\nwindow.updated=true;' : '\n.updated{color:blue}'),
        ]);
        const input = await put(f.outDir, `app-new.${extension}`, next);
        const second = await prepareAsset({ ...options, input, url: `/app-new.${extension}` });
        assert.ok(second.dcz[first.hash]);
        assert.ok(second.dcb[first.hash]);
        assert.notEqual(first.hash, second.hash);
        const manifest = await readManifest(f.outDir);
        const oldDictionary = manifest.dictionaries[first.dictionaryUrl];
        assert.ok(oldDictionary);
        assert.deepEqual(
            await decompressDcz(
                await readFile(path.join(f.outDir, second.dcz[first.hash].file)),
                path.join(f.outDir, oldDictionary.file)
            ),
            next
        );
        assert.deepEqual(
            await decompressDcb(
                await readFile(path.join(f.outDir, second.dcb[first.hash].file)),
                path.join(f.outDir, oldDictionary.file)
            ),
            next
        );
        assert.equal(second.dcz[first.hash].dictionaryUrl, second.dcb[first.hash].dictionaryUrl);
        assert.deepEqual(
            brotliDecompressSync(await readFile(path.join(f.outDir, second.representations.br.file))),
            next
        );
        assert.deepEqual(gunzipSync(await readFile(path.join(f.outDir, second.representations.gzip.file))), next);
    });

test('historyLimit limits variants without deleting the store', async (t) => {
    const f = await fixture(t);
    let asset;
    for (let i = 1; i <= 4; i++) {
        const input = await put(f.outDir, 'app.js', source(i));
        asset = await prepareAsset({
            ...f,
            input,
            key: 'app',
            url: '/app.js',
            dictionaryPolicy: 'rolling',
            historyLimit: 2,
        });
    }
    assert.equal(Object.keys(asset.dcz).length, 2);
    assert.equal(Object.keys(asset.dcb).length, 2);
    assert.equal(JSON.parse(await readFile(path.join(f.storeDir, 'registry.json'))).groups.app.history.length, 4);
});

test('a missing dcb encoder fails the build without publishing a partial manifest', async (t) => {
    const f = await fixture(t);
    const input = await put(f.outDir, 'app.js', source());
    await prepareAsset({ ...f, input, key: 'app', url: '/app.js' });
    const manifestPath = path.join(f.outDir, '.cdt/manifest.json');
    const registryPath = path.join(f.storeDir, 'registry.json');
    const [manifest, registry] = await Promise.all([readFile(manifestPath), readFile(registryPath)]);
    await put(f.outDir, 'app.js', source(2));
    await assert.rejects(
        () => prepareAsset({ ...f, input, key: 'app', url: '/app.js', brotliBinary: path.join(f.root, 'missing') }),
        /Install Brotli/
    );
    assert.deepEqual(await readFile(manifestPath), manifest);
    assert.deepEqual(await readFile(registryPath), registry);
    const recovered = await prepareAsset({ ...f, input, key: 'app', url: '/app.js' });
    assert.equal((await readManifest(f.outDir)).assets['/app.js'].hash, recovered.hash);
    const other = await prepareAsset({
        ...f,
        input,
        key: 'other',
        url: '/other.js',
        storeDir: path.join(f.root, 'other-store'),
    });
    assert.equal((await readManifest(f.outDir)).assets['/other.js'].hash, other.hash);
});

test('concurrent calls in one process preserve history', async (t) => {
    const f = await fixture(t);
    await Promise.all(
        [1, 2, 3].map(async (i) =>
            createDictionary({
                input: await put(f.outDir, `file${i}.js`, source(i)),
                storeDir: f.storeDir,
                key: 'app',
                match: '/file*.js',
            })
        )
    );
    assert.equal(JSON.parse(await readFile(path.join(f.storeDir, 'registry.json'))).groups.app.history.length, 3);
});

test('invalid inputs and policies produce explicit errors', async (t) => {
    const f = await fixture(t);
    const input = await put(f.outDir, 'app.js', source());
    const valid = { input, storeDir: f.storeDir, key: 'app', match: '/app.js' };
    await createDictionary(valid);
    await assert.rejects(() => createDictionary({ ...valid, match: '/other/*' }), /match.*changed/);
    await assert.rejects(() => createDictionary({ ...valid, key: '../bad' }), /key/);
    await assert.rejects(() => createDictionary({ ...valid, input: 'secret.txt' }), /supported/);
    await assert.rejects(
        () => prepareAsset({ ...valid, outDir: f.outDir, storeDir: path.join(f.outDir, 'store'), url: '/app.js' }),
        /outside/
    );
    await assert.rejects(() => prepareAsset({ ...valid, outDir: f.outDir, url: '/no-match.js' }), /include/);
    await assert.rejects(() => createDictionary({ ...valid, key: 'bad', match: '/(.*)' }), /Invalid/);
    const trained = await put(f.outDir, 'trained.js', Buffer.from([0x37, 0xa4, 0x30, 0xec, 1, 2, 3]));
    await assert.rejects(() => compressDcz(source(), trained), /trained/);
    const dictionary = await createDictionary(valid);
    await assert.rejects(
        () => compressDcz(source(), dictionary.path, { zstdBinary: path.join(f.root, 'missing-zstd') }),
        /Install Zstandard/
    );
    await writeFile(path.join(f.storeDir, 'registry.json'), '{broken');
    await assert.rejects(() => createDictionary(valid), SyntaxError);
});
