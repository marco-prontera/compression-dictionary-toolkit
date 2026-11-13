import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { DCB_MAGIC, decompressDcb, exportRelease, prepareAsset, readManifest } from 'compression-dictionary-toolkit';
import { fixture, put } from './helpers.mjs';
import { buildVite } from './vite-helpers.mjs';
import sharedDictionary from 'compression-dictionary-toolkit/vite';

test('export rejects a representation without an integrity hash before exporting hidden bytes', async (t) => {
    const f = await fixture(t);
    const input = await put(f.outDir, 'app.js', 'window.app = "public";');
    await prepareAsset({ ...f, input, key: 'app', url: '/app.js' });
    await put(f.outDir, '.env', 'FAKE_SECRET=fixture-only');
    const targetDir = path.join(f.root, 'release');
    const previous = await exportRelease({
        outDir: f.outDir,
        targetDir,
        releaseId: 'valid',
    });
    const before = await readFile(previous.manifestPath);
    const files = await readdir(targetDir, { recursive: true });
    const manifest = await readManifest(f.outDir);
    const identity = manifest.assets['/app.js'].representations.identity;
    identity.file = '.env';
    delete identity.hash;
    await writeFile(path.join(f.outDir, '.cdt/manifest.json'), JSON.stringify(manifest));
    await assert.rejects(
        () => exportRelease({ outDir: f.outDir, targetDir, releaseId: 'invalid' }),
        /Invalid manifest/
    );
    assert.deepEqual(await readFile(previous.manifestPath), before);
    assert.deepEqual(await readdir(targetDir, { recursive: true }), files);
});

test('dcb decoding rejects the Brotli large-window extension before invoking the decoder', async (t) => {
    const f = await fixture(t);
    const dictionary = await put(f.root, 'base.dict', 'public base dictionary');
    const input = await put(f.root, 'input.txt', 'public data public data public data');
    const { stdout } = await promisify(execFile)(
        process.env.BROTLI_BIN ?? 'brotli',
        ['-c', '-q', '4', '--large_window=30', '-D', dictionary, input],
        { encoding: 'buffer' }
    );
    // Fast quality levels may silently reduce the window; verify the actual extended WBITS field.
    assert.equal(stdout[0], 0x11);
    assert.equal(stdout[1] & 0x3f, 30);
    const hash = createHash('sha256')
        .update(await readFile(dictionary))
        .digest();
    const encoded = Buffer.concat([DCB_MAGIC, hash, stdout]);
    await assert.rejects(() => decompressDcb(encoded, dictionary), /Unsupported dcb.*window/);
    await assert.rejects(
        () =>
            decompressDcb(encoded, dictionary, {
                brotliBinary: path.join(f.root, 'missing'),
            }),
        /Unsupported dcb.*window/
    );
});

test(
    'export rejects a FIFO representation without waiting for a writer',
    { skip: process.platform === 'win32' },
    async (t) => {
        const f = await fixture(t);
        const input = await put(f.outDir, 'app.js', 'window.app = "public";');
        const asset = await prepareAsset({
            ...f,
            input,
            key: 'app',
            url: '/app.js',
        });
        const identity = path.join(f.outDir, asset.representations.identity.file);
        await rm(identity);
        await promisify(execFile)('mkfifo', [identity]);
        const targetDir = path.join(f.root, 'release');
        const { stdout } = await promisify(execFile)(
            process.execPath,
            [
                '--input-type=module',
                '-e',
                `import assert from 'node:assert/strict';
         import { exportRelease } from 'compression-dictionary-toolkit';
         await assert.rejects(() => exportRelease(JSON.parse(process.argv[1])), /regular file/);
         console.log('rejected');`,
                JSON.stringify({ outDir: f.outDir, targetDir, releaseId: 'invalid' }),
            ],
            { timeout: 5000, killSignal: 'SIGKILL' }
        );
        assert.equal(stdout.trim(), 'rejected');
        // The export lock creates the target directory; failure must leave no objects, metadata, or stale lock.
        assert.deepEqual(await readdir(targetDir), []);
    }
);

test('Vite rejects public metadata before copying it or clearing the previous output', async (t) => {
    const f = await fixture(t);
    await put(f.root, 'index.html', '<h1>Public</h1>');
    const marker = await put(f.outDir, 'previous.txt', 'Keep the current build.');
    await put(f.root, 'private.txt', 'fixture-private-content');
    await put(
        f.root,
        'public/.cdt/manifest.json',
        JSON.stringify({
            schemaVersion: 1,
            assets: {
                '/app.js': {
                    url: '/app.js',
                    file: '../private.txt',
                    hash: '0'.repeat(64),
                },
            },
            dictionaries: {},
        })
    );
    await assert.rejects(() => buildVite(f), /reserved \.cdt/);
    assert.equal(await readFile(marker, 'utf8'), 'Keep the current build.');
    await assert.rejects(() => readFile(path.join(f.outDir, '.cdt/manifest.json')), { code: 'ENOENT' });
});

test('all stored representation maps require hashes, sizes, and managed paths', async (t) => {
    const f = await fixture(t);
    const input = await put(f.outDir, 'app.js', 'window.app = "public";');
    const asset = await prepareAsset({ ...f, input, key: 'app', url: '/app.js' });
    const original = await readManifest(f.outDir);
    for (const kind of ['identity', 'br', 'gzip', 'dcb', 'dcz', 'dictionary']) {
        for (const invalid of [
            { hash: undefined },
            { hash: '' },
            { hash: 'x'.repeat(64) },
            { hash: `${'0'.repeat(63)}\n` },
            { hash: `${'0'.repeat(64)}\n` },
            { bytes: -1 },
            { file: '.env' },
        ]) {
            const manifest = structuredClone(original);
            const record =
                kind === 'dictionary'
                    ? manifest.dictionaries[asset.dictionaryUrl]
                    : kind === 'dcb' || kind === 'dcz'
                      ? manifest.assets[asset.url][kind][asset.dictionaryHash]
                      : manifest.assets[asset.url].representations[kind];
            Object.assign(record, invalid);
            await writeFile(path.join(f.outDir, '.cdt/manifest.json'), JSON.stringify(manifest));
            await assert.rejects(
                () => readManifest(f.outDir),
                /Invalid manifest/,
                `${kind}: ${JSON.stringify(invalid)}`
            );
        }
    }
});

test('standard Brotli windows still decode correctly', async (t) => {
    const f = await fixture(t);
    const dictionary = await put(f.root, 'base.dict', 'public base dictionary');
    const bytes = Buffer.from('public data public data public data');
    const input = await put(f.root, 'input.txt', bytes);
    const hash = createHash('sha256')
        .update(await readFile(dictionary))
        .digest();
    for (const window of [10, 16, 17, 24]) {
        const { stdout } = await promisify(execFile)(
            process.env.BROTLI_BIN ?? 'brotli',
            ['-c', '-q', '4', '-w', String(window), '-D', dictionary, input],
            { encoding: 'buffer' }
        );
        assert.deepEqual(await decompressDcb(Buffer.concat([DCB_MAGIC, hash, stdout]), dictionary), bytes);
    }
});

test('export verifies same-size corruption without replacing a valid release or leaving temporary files', async (t) => {
    const f = await fixture(t);
    const input = await put(f.outDir, 'app.js', 'window.app = "public";');
    const asset = await prepareAsset({ ...f, input, key: 'app', url: '/app.js' });
    const targetDir = path.join(f.root, 'release');
    const result = await exportRelease({
        outDir: f.outDir,
        targetDir,
        releaseId: 'valid',
    });
    const previous = await readFile(result.manifestPath);
    const files = await readdir(targetDir, { recursive: true });
    const file = path.join(f.outDir, asset.representations.identity.file);
    const bytes = await readFile(file);
    bytes[0] ^= 1;
    await writeFile(file, bytes);
    await assert.rejects(() => exportRelease({ outDir: f.outDir, targetDir, releaseId: 'invalid' }), /integrity/);
    assert.deepEqual(await readFile(result.manifestPath), previous);
    assert.deepEqual(await readdir(targetDir, { recursive: true }), files);
});

test('export copies empty and large static files without imposing dictionary size limits', async (t) => {
    const f = await fixture(t);
    const input = await put(f.outDir, 'app.js', 'window.app = "public";');
    await prepareAsset({ ...f, input, key: 'app', url: '/app.js' });
    const bytes = Buffer.alloc(8 * 1024 * 1024 + 1, 'a');
    await put(f.outDir, 'large.bin', bytes);
    await put(f.outDir, 'empty.txt', '');
    const targetDir = path.join(f.root, 'release');
    const result = await exportRelease({
        outDir: f.outDir,
        targetDir,
        releaseId: 'static',
    });
    const manifest = JSON.parse(await readFile(result.manifestPath));
    assert.deepEqual(await readFile(path.join(targetDir, manifest.staticFiles['/large.bin'].file)), bytes);
    assert.equal(manifest.staticFiles['/empty.txt'].bytes, 0);
    assert.equal((await readFile(path.join(targetDir, manifest.staticFiles['/empty.txt'].file))).length, 0);
});

test('cached asset paths cannot escape through traversal or platform-specific separators', async (t) => {
    const f = await fixture(t);
    const input = await put(f.outDir, 'app.js', 'window.app = "public";');
    await prepareAsset({ ...f, input, key: 'app', url: '/app.js' });
    const original = await readManifest(f.outDir);
    for (const file of [
        '../private.txt',
        '/private.txt',
        'C:/private.txt',
        'assets/../../private.txt',
        'assets\\private.txt',
        'assets/./app.js',
        'app.js\n',
    ]) {
        const manifest = structuredClone(original);
        manifest.assets['/app.js'].file = file;
        await writeFile(path.join(f.outDir, '.cdt/manifest.json'), JSON.stringify(manifest));
        await assert.rejects(() => readManifest(f.outDir), /Invalid manifest/);
        await assert.rejects(() => prepareAsset({ ...f, input, key: 'app', url: '/app.js' }), /Invalid manifest/);
    }
});

test('legacy dcz manifests retain their defaults and remain exportable', async (t) => {
    const f = await fixture(t);
    const input = await put(f.outDir, 'app.js', 'window.app = "public";');
    const asset = await prepareAsset({ ...f, input, key: 'app', url: '/app.js' });
    const manifest = await readManifest(f.outDir);
    for (const field of ['dcb', 'dictionaryHash', 'dictionaryPolicy', 'dictionaryEpoch', 'dictionaryDelivery'])
        delete manifest.assets[asset.url][field];
    await writeFile(path.join(f.outDir, '.cdt/manifest.json'), JSON.stringify(manifest));
    const restored = await readManifest(f.outDir);
    assert.deepEqual(restored.assets[asset.url].dcb, {});
    assert.equal(restored.assets[asset.url].dictionaryHash, asset.dictionaryHash);
    assert.equal(restored.assets[asset.url].dictionaryPolicy, 'rolling');
    assert.equal(restored.assets[asset.url].dictionaryDelivery, 'separate');
    const exported = await exportRelease({
        outDir: f.outDir,
        targetDir: path.join(f.root, 'release'),
        releaseId: 'legacy',
    });
    const published = JSON.parse(await readFile(exported.manifestPath));
    assert.ok(published.assets[asset.url].dcz[asset.dictionaryHash]);
    assert.deepEqual(published.assets[asset.url].dcb, {});
    assert.equal(published.assets[asset.url].dictionaryHash, asset.dictionaryHash);
    assert.equal(published.assets[asset.url].dictionaryPolicy, 'rolling');
});

for (const options of [{ publicDir: false }, { build: { copyPublicDir: false } }])
    test(`Vite ignores public metadata when copying is disabled (${JSON.stringify(options)})`, async (t) => {
        const f = await fixture(t);
        await put(f.root, 'index.html', '<h1>Public</h1>');
        await put(f.root, 'public/.cdt/manifest.json', 'invalid metadata');
        await buildVite(f, {
            plugins: [sharedDictionary()],
            ...options,
            build: { ...options.build },
        });
        assert.deepEqual((await readManifest(f.outDir)).assets, {});
    });

test('copied public files can exceed dictionary input limits while invalidating old preparations', async (t) => {
    const f = await fixture(t);
    const input = await put(f.outDir, 'app.js', 'window.app = "old";');
    await prepareAsset({ ...f, input, key: 'app', url: '/app.js' });
    await put(f.root, 'index.html', '<h1>Public</h1>');
    await put(f.root, 'public/app.js', Buffer.alloc(8 * 1024 * 1024 + 1, ' '));
    await buildVite(f, {
        build: { emptyOutDir: false },
    });
    assert.deepEqual((await readManifest(f.outDir)).assets, {});
});

for (const externalPath of ['external.js', 'public-other/app.js']) {
    test(`retained preparations reject a public asset alias outside the public directory (${externalPath})`, async (t) => {
        const f = await fixture(t);
        const input = await put(f.outDir, 'app.js', 'window.app = "old";');
        await prepareAsset({ ...f, input, key: 'app', url: '/app.js' });
        await put(f.root, 'index.html', '<h1>Public</h1>');
        await put(f.root, 'public/placeholder.txt', 'public');
        const external = await put(f.root, externalPath, 'window.app = "new";');
        await symlink(external, path.join(f.root, 'public/app.js'));
        await assert.rejects(() => buildVite(f, { build: { emptyOutDir: false } }), /outside its configured directory/);
    });
}
