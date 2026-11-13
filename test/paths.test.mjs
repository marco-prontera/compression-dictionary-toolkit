import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import { buildVite } from './vite-helpers.mjs';
import sharedDictionary from 'compression-dictionary-toolkit/vite';
import {
    createDictionary,
    prepareAsset,
    readManifest,
    exportRelease,
    validateStoreDirectory,
} from 'compression-dictionary-toolkit';
import { fixture, put, source } from './helpers.mjs';

for (const existingStore of [false, true])
    test(`preparation rejects a store inside an aliased output before writing (existing: ${existingStore})`, async (t) => {
        const f = await fixture(t);
        const alias = path.join(f.root, 'dist-alias');
        await symlink(f.outDir, alias, 'dir');
        const storeDir = path.join(alias, 'nested/store');
        const input = await put(f.root, 'app.js', source());
        if (existingStore) await createDictionary({ input, storeDir, key: 'app', match: '/app.js' });
        const before = await readdir(f.outDir, { recursive: true });
        const registry = existingStore ? await readFile(path.join(storeDir, 'registry.json')) : undefined;
        await assert.rejects(
            () =>
                prepareAsset({
                    input,
                    outDir: f.outDir,
                    storeDir,
                    key: 'app',
                    url: '/app.js',
                }),
            /storeDir must be outside outDir/
        );
        assert.deepEqual(await readdir(f.outDir, { recursive: true }), before);
        if (existingStore) assert.deepEqual(await readFile(path.join(storeDir, 'registry.json')), registry);
    });

test('an output alias cannot hide a store inside the real output', async (t) => {
    const f = await fixture(t);
    const outDir = path.join(f.root, 'dist-alias');
    await symlink(f.outDir, outDir, 'dir');
    const input = await put(f.root, 'app.js', source());
    await assert.rejects(
        () =>
            prepareAsset({
                input,
                outDir,
                storeDir: path.join(f.outDir, 'store'),
                key: 'app',
                url: '/app.js',
            }),
        /storeDir must be outside outDir/
    );
    assert.deepEqual(await readdir(f.outDir), []);
});

test('Vite rejects an aliased store before emptying the output or deleting dictionary history', async (t) => {
    const f = await fixture(t);
    const input = await put(f.root, 'app.js', source());
    const realStore = path.join(f.outDir, 'store');
    const dictionary = await createDictionary({
        input,
        storeDir: realStore,
        key: 'app',
        match: '/app.js',
    });
    const storeDir = path.join(f.root, 'store-alias');
    await symlink(realStore, storeDir, 'dir');
    const registry = await readFile(path.join(realStore, 'registry.json'));
    const marker = await put(f.outDir, 'previous-release.txt', 'Keep the current release until validation succeeds.');
    await assert.rejects(
        () =>
            buildVite(f, {
                plugins: [sharedDictionary({ storeDir })],
                build: { emptyOutDir: true, rolldownOptions: { input } },
            }),
        /storeDir must be outside outDir/
    );
    assert.deepEqual(await readFile(path.join(realStore, 'registry.json')), registry);
    assert.deepEqual(await readFile(dictionary.path), source());
    assert.equal(await readFile(marker, 'utf8'), 'Keep the current release until validation succeeds.');
});

for (const bundler of ['rolldownOptions', 'rollupOptions'])
    for (const layout of ['store', 'dictionaries', 'multiple', 'alias'])
        test(`Vite rejects a bundler output override before deleting dictionary history (${bundler}, ${layout})`, async (t) => {
            const f = await fixture(t);
            const input = await put(f.root, 'app.js', source());
            const dictionary = await createDictionary({
                input,
                storeDir: f.storeDir,
                key: 'app',
                match: '/app.js',
            });
            const registry = await readFile(path.join(f.storeDir, 'registry.json'));
            const marker = await put(f.outDir, 'previous-release.txt', 'Keep the previous release.');
            const overridden = layout === 'dictionaries' ? path.join(f.storeDir, 'dictionaries') : f.storeDir;
            const alias = path.join(f.root, 'output-alias');
            if (layout === 'alias') await symlink(f.storeDir, alias, 'dir');
            const output = {
                dir: layout === 'alias' ? alias : overridden,
                entryFileNames: 'app.js',
            };
            const before = await readdir(f.root, { recursive: true });
            await assert.rejects(
                () =>
                    buildVite(f, {
                        build: {
                            emptyOutDir: true,
                            [bundler]: {
                                input,
                                output: layout === 'multiple' ? [{ dir: f.outDir }, output] : output,
                            },
                        },
                    }),
                /Multiple output directories are not supported/
            );
            assert.deepEqual(await readFile(path.join(f.storeDir, 'registry.json')), registry);
            assert.deepEqual(await readFile(dictionary.path), source());
            assert.equal(await readFile(marker, 'utf8'), 'Keep the previous release.');
            assert.deepEqual(await readdir(f.root, { recursive: true }), before);
        });

for (const bundler of ['rolldownOptions', 'rollupOptions'])
    test(`Vite prepares multiple formats in the configured output directory (${bundler})`, async (t) => {
        const f = await fixture(t);
        const input = await put(f.root, 'app.js', source());
        const config = {
            // Reuse one plugin instance across builds to exercise its lifecycle.
            plugins: [sharedDictionary({ storeDir: f.storeDir })],
            build: {
                [bundler]: {
                    input,
                    output: [
                        { dir: f.outDir, format: 'es', entryFileNames: 'app.js' },
                        { dir: f.outDir, format: 'cjs', entryFileNames: 'app.cjs' },
                    ],
                },
            },
        };
        let first;
        for (const version of [1, 2]) {
            await put(f.root, 'app.js', source(version));
            await buildVite(f, config);
            const manifest = await readManifest(f.outDir);
            first ??= manifest;
            assert.deepEqual(Object.keys(manifest.assets).sort(), ['/app.cjs', '/app.js']);
            for (const asset of Object.values(manifest.assets)) {
                assert.deepEqual(
                    await readFile(path.join(f.outDir, asset.representations.identity.file)),
                    await readFile(path.join(f.outDir, asset.file))
                );
                assert.ok(manifest.dictionaries[asset.dictionaryUrl]);
                assert.equal(asset.dictionaryHash, asset.hash);
                assert.ok(asset.dcb[first.assets[asset.url].hash]);
                if (version > 1) assert.notEqual(asset.hash, first.assets[asset.url].hash);
            }
        }
    });

test('Vite rejects a relative output resolved differently by the bundler before generating', async (t) => {
    const f = await fixture(t);
    const input = await put(f.root, 'app.js', source());
    await assert.rejects(
        () =>
            buildVite(f, {
                build: {
                    write: false,
                    rolldownOptions: { input, output: { dir: 'dist' } },
                },
            }),
        /Multiple output directories are not supported/
    );
});

for (const layout of ['direct', 'output-alias', 'dictionary-alias'])
    test(`Vite protects persistent dictionaries before cleaning an overlapping output (${layout})`, async (t) => {
        const f = await fixture(t);
        const input = await put(f.root, 'app.js', source());
        let outDir = path.join(f.storeDir, 'dictionaries');
        if (layout === 'dictionary-alias') {
            outDir = path.join(f.storeDir, 'objects');
            await mkdir(outDir, { recursive: true });
            await symlink(outDir, path.join(f.storeDir, 'dictionaries'), 'dir');
        }
        const first = await prepareAsset({
            ...f,
            input,
            key: 'app',
            url: '/app.js',
        });
        if (layout === 'output-alias') {
            const alias = path.join(f.root, 'output-alias');
            await symlink(outDir, alias, 'dir');
            outDir = alias;
        }
        const base = path.join(f.storeDir, 'dictionaries', `${first.dictionaryHash}.dict`);
        const registry = await readFile(path.join(f.storeDir, 'registry.json'));
        const before = await readdir(outDir, { recursive: true });
        await put(f.root, 'app.js', source(2));
        await assert.rejects(
            () =>
                buildVite(f, {
                    plugins: [
                        sharedDictionary({
                            storeDir: f.storeDir,
                            resolveAsset: () => ({ key: 'app', match: '/app.js' }),
                        }),
                    ],
                    build: {
                        outDir,
                        emptyOutDir: true,
                        rolldownOptions: { input, output: { entryFileNames: 'app.js' } },
                    },
                }),
            /outDir must not overlap.*dictionaries/
        );
        assert.deepEqual(await readFile(base), source());
        assert.deepEqual(await readFile(path.join(f.storeDir, 'registry.json')), registry);
        assert.deepEqual(await readdir(outDir, { recursive: true }), before);
    });

test('dictionary storage overlap is rejected before new directories are created', async (t) => {
    const f = await fixture(t);
    const before = await readdir(f.root, { recursive: true });
    for (const relative of ['dictionaries', 'dictionaries/nested/dist'])
        await assert.rejects(
            () =>
                validateStoreDirectory({
                    storeDir: f.storeDir,
                    outDir: path.join(f.storeDir, relative),
                }),
            /outDir must not overlap.*dictionaries/
        );
    assert.deepEqual(await readdir(f.root, { recursive: true }), before);
});

test('a build below the store remains valid when it is separate from dictionary storage', async (t) => {
    const f = await fixture(t);
    const input = await put(f.root, 'app.js', source());
    const outDir = path.join(f.storeDir, 'build');
    const first = await prepareAsset({
        input,
        outDir,
        storeDir: f.storeDir,
        key: 'app',
        url: '/app.js',
    });
    await buildVite(f, {
        plugins: [
            sharedDictionary({
                storeDir: f.storeDir,
                resolveAsset: () => ({ key: 'app', match: '/app.js' }),
            }),
        ],
        build: {
            outDir,
            emptyOutDir: true,
            rolldownOptions: { input, output: { entryFileNames: 'app.js' } },
        },
    });
    assert.ok((await readManifest(outDir)).assets['/app.js'].dcb[first.hash]);
    assert.deepEqual(await readFile(path.join(f.storeDir, 'dictionaries', `${first.dictionaryHash}.dict`)), source());
});

for (const relationship of ['same', 'child', 'parent'])
    test(`export rejects an aliased ${relationship} directory before writing objects or metadata`, async (t) => {
        const f = await fixture(t);
        const input = await put(f.outDir, 'app.js', source());
        await prepareAsset({ ...f, input, key: 'app', url: '/app.js' });
        const alias = path.join(f.root, 'target-alias');
        await symlink(relationship === 'parent' ? f.root : f.outDir, alias, 'dir');
        const targetDir = relationship === 'child' ? path.join(alias, 'nested/release') : alias;
        const before = await readdir(f.root, { recursive: true });
        const manifest = await readFile(path.join(f.outDir, '.cdt/manifest.json'));
        await assert.rejects(() => exportRelease({ outDir: f.outDir, targetDir, releaseId: 'invalid' }), /separate/);
        assert.deepEqual(await readdir(f.root, { recursive: true }), before);
        assert.deepEqual(await readFile(path.join(f.outDir, '.cdt/manifest.json')), manifest);
    });

test('separate directories under an alias support new stores, new outputs, and release exports', async (t) => {
    const f = await fixture(t);
    const parent = path.join(f.root, 'workspace');
    await mkdir(parent);
    const alias = path.join(f.root, 'workspace-alias');
    await symlink(parent, alias, 'dir');
    const input = await put(f.root, 'app.js', source());
    const outDir = path.join(alias, 'new/dist');
    const storeDir = path.join(parent, 'new/store');
    const asset = await prepareAsset({
        input,
        outDir,
        storeDir,
        key: 'app',
        url: '/app.js',
    });
    assert.equal((await readManifest(outDir)).assets['/app.js'].hash, asset.hash);
    const targetDir = path.join(alias, 'new/release');
    const exported = await exportRelease({
        outDir,
        targetDir,
        releaseId: 'valid',
    });
    const manifest = JSON.parse(await readFile(exported.manifestPath));
    assert.equal(manifest.assets['/app.js'].hash, asset.hash);
    assert.ok(!Object.hasOwn(manifest.staticFiles, '/edge-manifest.json'));
    assert.ok(!Object.hasOwn(manifest.staticFiles, '/upload-plan.json'));
});
