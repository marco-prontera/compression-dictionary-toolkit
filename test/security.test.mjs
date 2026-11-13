import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, open, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildVite } from './vite-helpers.mjs';
import {
    createDictionary,
    compressDcb,
    compressDcz,
    decompressDcb,
    decompressDcz,
    DCB_MAGIC,
    DCZ_MAGIC,
    exportRelease,
    initializeManifest,
    matches,
    prepareAsset,
    readManifest,
    removePreparedAsset,
} from 'compression-dictionary-toolkit';
import { fixture, put, source } from './helpers.mjs';

test('wildcard matching does not block the process on adversarial patterns', async () => {
    // A separate process bounds a regression that would otherwise block the test runner itself.
    const { stdout } = await promisify(execFile)(
        process.execPath,
        [
            '--input-type=module',
            '-e',
            `import { matches } from 'compression-dictionary-toolkit';
             console.log(matches('/' + '*a'.repeat(40) + '*b*', '/' + 'a'.repeat(200)));`,
        ],
        { timeout: 5000, killSignal: 'SIGKILL' }
    );
    assert.equal(stdout.trim(), 'false');
});

test('wildcards preserve literal segments, ordering, and full-path matching', () => {
    for (const [pattern, pathname, expected] of [
        ['/app.js', '/app.js', true],
        ['/app.js', '/appXjs', false],
        ['/assets/app-*.js', '/assets/app-v2.js', true],
        ['/assets/app-*.js', '/other/app-v2.js', false],
        ['/assets/app-*.js', '/assets/app-v2.js.map', false],
        ['/a**b*c*', '/ab/c', true],
        ['/a*b*c', '/acb', false],
        ['/ab*bc', '/abc', false],
        ['/ab*bc', '/abbc', true],
        ['/*', '/', true],
        ['/*', '/nested/path.js', true],
    ])
        assert.equal(matches(pattern, pathname), expected, `${pattern}: ${pathname}`);
});

test('preparation cannot overwrite a file outside outDir through a linked asset directory', async (t) => {
    const f = await fixture(t);
    const input = await put(f.root, 'app.js', 'window.changed = true;');
    const external = path.join(f.root, 'external');
    const original = 'Do not overwrite this external file.';
    const file = await put(external, 'app.js', original);
    await symlink(external, path.join(f.outDir, 'assets'), 'dir');
    const error = await prepareAsset({ ...f, input, key: 'app', url: '/assets/app.js' }).catch((error) => error);
    assert.equal(await readFile(file, 'utf8'), original);
    assert.match(error.message, /outside|symlink/i);
});

for (const alias of [false, true])
    test(`copied originals cannot overwrite managed representations (alias: ${alias})`, async (t) => {
        const f = await fixture(t);
        const input = await put(f.root, 'app.js', source());
        const first = await prepareAsset({ ...f, input, key: 'app', url: '/app.js' });
        const manifest = await readFile(path.join(f.outDir, '.cdt/manifest.json'));
        const registry = await readFile(path.join(f.storeDir, 'registry.json'));
        let destination = first.representations.identity.file;
        if (alias) {
            await symlink(path.join(f.outDir, '.cdt'), path.join(f.outDir, 'public-cache'), 'dir');
            destination = destination.replace('.cdt/', 'public-cache/');
        }
        const nextInput = await put(f.root, 'next.js', source(2));
        await assert.rejects(
            () => prepareAsset({ ...f, input: nextInput, key: 'other', url: `/${destination}` }),
            /reserved.*\.cdt/i
        );
        assert.deepEqual(await readFile(path.join(f.outDir, first.representations.identity.file)), source());
        assert.deepEqual(await readFile(path.join(f.outDir, '.cdt/manifest.json')), manifest);
        assert.deepEqual(await readFile(path.join(f.storeDir, 'registry.json')), registry);
    });

for (const destination of ['.cdt/manifest.json', '.CDT/manifest.json', '.cdt/.write.lock'])
    test(`copied originals reject the reserved path ${destination} before creating output`, async (t) => {
        const f = await fixture(t);
        const input = await put(f.root, 'app.js', source());
        await assert.rejects(
            () => prepareAsset({ ...f, input, key: 'app', url: `/${destination}` }),
            /reserved.*\.cdt/i
        );
        assert.deepEqual(await readdir(f.outDir), []);
        await assert.rejects(() => stat(f.storeDir), { code: 'ENOENT' });
    });

test('an original asset inside the metadata directory cannot become a prepared public asset', async (t) => {
    const f = await fixture(t);
    const input = await put(f.outDir, '.cdt/internal.js', source());
    await assert.rejects(() => prepareAsset({ ...f, input, key: 'app', url: '/app.js' }), /reserved.*\.cdt/i);
    assert.deepEqual(await readdir(path.join(f.outDir, '.cdt')), ['internal.js']);
});

for (const operation of ['prepare', 'initialize', 'remove', 'vite'])
    test(`${operation} rejects a linked metadata directory without writing outside outDir`, async (t) => {
        const f = await fixture(t);
        const input = await put(f.root, 'app.js', source());
        const external = path.join(f.root, 'external');
        await mkdir(external);
        await symlink(external, path.join(f.outDir, '.cdt'), 'dir');
        const actions = {
            prepare: () => prepareAsset({ ...f, input, key: 'app', url: '/app.js' }),
            initialize: () => initializeManifest(f.outDir),
            remove: () => removePreparedAsset({ outDir: f.outDir, url: '/app.js' }),
            vite: () =>
                buildVite(f, {
                    build: { emptyOutDir: false, rolldownOptions: { input } },
                }),
        };
        await assert.rejects(actions[operation], /outside|symlink/i);
        assert.deepEqual(await readdir(external), []);
        assert.deepEqual(await readdir(f.outDir), ['.cdt']);
    });

test('dictionary registration rejects storage redirected outside storeDir', async (t) => {
    const f = await fixture(t);
    const input = await put(f.root, 'app.js', source());
    const external = path.join(f.root, 'external');
    await mkdir(external);
    await mkdir(f.storeDir);
    await symlink(external, path.join(f.storeDir, 'dictionaries'), 'dir');
    await assert.rejects(
        () => createDictionary({ input, storeDir: f.storeDir, key: 'app', match: '/app.js' }),
        /outside|symlink/i
    );
    assert.deepEqual(await readdir(external), []);
});

for (const directory of ['variants', 'dictionaries'])
    test(`preparation rejects an output ${directory} directory redirected outside outDir`, async (t) => {
        const f = await fixture(t);
        const input = await put(f.root, 'app.js', source());
        const external = path.join(f.root, 'external');
        await mkdir(external);
        await mkdir(path.join(f.outDir, '.cdt'));
        await symlink(external, path.join(f.outDir, '.cdt', directory), 'dir');
        await assert.rejects(() => prepareAsset({ ...f, input, key: 'app', url: '/app.js' }), /outside|symlink/i);
        assert.deepEqual(await readdir(external), []);
    });

test('export rejects an objects directory redirected outside targetDir', async (t) => {
    const f = await fixture(t);
    const external = path.join(f.root, 'external');
    const targetDir = path.join(f.root, 'release');
    await mkdir(external);
    await mkdir(targetDir);
    await initializeManifest(f.outDir);
    await put(f.outDir, 'index.html', '<h1>Public</h1>');
    await symlink(external, path.join(targetDir, 'objects'), 'dir');
    await assert.rejects(() => exportRelease({ outDir: f.outDir, targetDir, releaseId: 'test' }), /outside|symlink/i);
    assert.deepEqual(await readdir(external), []);
    assert.deepEqual(await readdir(targetDir), ['objects']);
});

test('a manifest symlink cannot import metadata from outside outDir', async (t) => {
    const f = await fixture(t);
    const external = await put(f.root, 'external.json', '{"schemaVersion":1,"assets":{},"dictionaries":{}}');
    await mkdir(path.join(f.outDir, '.cdt'));
    await symlink(external, path.join(f.outDir, '.cdt/manifest.json'));
    await assert.rejects(() => readManifest(f.outDir), /outside|symlink/i);
});

test('dangling directory symlinks are rejected before creating their targets', async (t) => {
    const f = await fixture(t);
    const external = path.join(f.root, 'missing');
    await symlink(external, path.join(f.outDir, '.cdt'), 'dir');
    await assert.rejects(() => initializeManifest(f.outDir), /symlink/i);
    await assert.rejects(() => readdir(external), { code: 'ENOENT' });
});

for (const size of [0, 8 * 1024 * 1024 + 1])
    test(`all codecs reject a ${size}-byte raw dictionary before invoking an encoder`, async (t) => {
        const f = await fixture(t);
        const dictionary = Buffer.alloc(size);
        const dictionaryPath = await put(f.root, 'invalid.dict', dictionary);
        const hash = createHash('sha256').update(dictionary).digest();
        const options = { brotliBinary: path.join(f.root, 'missing'), zstdBinary: path.join(f.root, 'missing') };
        for (const [compress, decompress, magic] of [
            [compressDcb, decompressDcb, DCB_MAGIC],
            [compressDcz, decompressDcz, DCZ_MAGIC],
        ]) {
            await assert.rejects(
                () => compress(Buffer.from('hello'), dictionaryPath, options),
                /Raw dictionary required/
            );
            const encoded = Buffer.concat([magic, hash, Buffer.alloc(4)]);
            await assert.rejects(() => decompress(encoded, dictionaryPath, options), /Raw dictionary required/);
        }
    });

test('codec dictionary inputs cannot block on a named pipe', { skip: process.platform === 'win32' }, async (t) => {
    const f = await fixture(t);
    const fifo = path.join(f.root, 'dictionary.pipe');
    await promisify(execFile)('mkfifo', [fifo]);
    const { stdout } = await promisify(execFile)(
        process.execPath,
        [
            '--input-type=module',
            '-e',
            `import assert from 'node:assert/strict';
             import { compressDcb, compressDcz, decompressDcb, decompressDcz, DCB_MAGIC, DCZ_MAGIC } from 'compression-dictionary-toolkit';
             for (const [encode, decode, magic] of [[compressDcb, decompressDcb, DCB_MAGIC], [compressDcz, decompressDcz, DCZ_MAGIC]]) {
                 await assert.rejects(() => encode(Buffer.from('hello'), process.argv[1]), /Raw dictionary required/);
                 const encoded = Buffer.concat([magic, Buffer.alloc(36)]);
                 await assert.rejects(() => decode(encoded, process.argv[1]), /Raw dictionary required/);
             }
             console.log('rejected');`,
            fifo,
        ],
        { timeout: 5000, killSignal: 'SIGKILL' }
    );
    assert.equal(stdout.trim(), 'rejected');
});

test('reading a manifest cannot block on a named pipe', { skip: process.platform === 'win32' }, async (t) => {
    const f = await fixture(t);
    await mkdir(path.join(f.outDir, '.cdt'));
    await promisify(execFile)('mkfifo', [path.join(f.outDir, '.cdt/manifest.json')]);
    const { stdout } = await promisify(execFile)(
        process.execPath,
        [
            '--input-type=module',
            '-e',
            `import assert from 'node:assert/strict';
             import { readManifest } from 'compression-dictionary-toolkit';
             await assert.rejects(() => readManifest(process.argv[1]), /Metadata must be/);
             console.log('rejected');`,
            f.outDir,
        ],
        { timeout: 5000, killSignal: 'SIGKILL' }
    );
    assert.equal(stdout.trim(), 'rejected');
});

test('oversized manifest metadata is rejected before parsing', async (t) => {
    const f = await fixture(t);
    await mkdir(path.join(f.outDir, '.cdt'));
    const handle = await open(path.join(f.outDir, '.cdt/manifest.json'), 'wx');
    try {
        // A sparse file exercises the limit without allocating a large fixture in memory.
        await handle.truncate(64 * 1024 * 1024 + 1);
    } finally {
        await handle.close();
    }
    await assert.rejects(() => readManifest(f.outDir), /Metadata must be.*64 MiB/);
});

test('an update exceeding the metadata limit preserves the previous manifest', async (t) => {
    const f = await fixture(t);
    const file = path.join(f.outDir, '.cdt/manifest.json');
    await mkdir(path.dirname(file));
    const prefix = '{"schemaVersion":1,"assets":{},"dictionaries":{},"padding":"';
    const size = 64 * 1024 * 1024 - 1;
    const bytes = Buffer.alloc(size, 'a');
    bytes.write(prefix);
    bytes.write('"}', size - 2);
    await writeFile(file, bytes);
    const input = await put(f.root, 'app.js', 'window.app = "public";');
    // Adding an asset to this valid, compact manifest must not publish metadata above the read limit.
    await assert.rejects(() => prepareAsset({ ...f, input, key: 'app', url: '/app.js' }), /Metadata.*64 MiB/);
    assert.equal((await stat(file)).size, size);
    const handle = await open(file, 'r');
    try {
        const head = Buffer.alloc(prefix.length);
        await handle.read(head, 0, head.length, 0);
        assert.equal(head.toString(), prefix);
    } finally {
        await handle.close();
    }
});
