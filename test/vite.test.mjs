import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { buildVite } from './vite-helpers.mjs';
import sharedDictionary from 'compression-dictionary-toolkit/vite';
import { prepareAsset, readManifest, decompressDcz, decompressDcb } from 'compression-dictionary-toolkit';
import { compose } from '../examples/compose.mjs';
import { fixture, put, source } from './helpers.mjs';

for (const kind of ['classic', 'module', 'shared'])
    test(`Vite ${kind} workers reuse their dictionary across three builds`, async (t) => {
        const f = await fixture(t);
        const constructor = kind === 'shared' ? 'SharedWorker' : 'Worker';
        const options = kind === 'module' ? ", { type: 'module' }" : '';
        await put(f.root, 'index.html', '<script type="module" src="/app.js"></script>');
        await put(
            f.root,
            'app.js',
            `window.worker = new ${constructor}(new URL('./my.worker.js', import.meta.url)${options});`
        );
        let first;
        for (const version of [1, 2, 3]) {
            await put(
                f.root,
                'my.worker.js',
                source(version).toString().replace('window.catalog', 'self.catalog') +
                    ';self.pluginMarker=__WORKER_MARKER__;'
            );
            await buildVite(f, {
                base: '/demo/',
                worker: {
                    // Existing worker plugins must still run after metadata collection is installed.
                    plugins: () => [
                        {
                            name: 'worker-marker',
                            transform(code, id) {
                                if (id.endsWith('/my.worker.js')) return code.replace('__WORKER_MARKER__', '42');
                            },
                        },
                    ],
                    ...(kind === 'module'
                        ? {
                              rolldownOptions: {
                                  output: { entryFileNames: 'jobs/[name]-[hash:12].js' },
                              },
                          }
                        : {}),
                },
            });
            const manifest = await readManifest(f.outDir);
            const asset = Object.values(manifest.assets).find((item) => item.url.includes('/my.worker-'));
            assert.ok(asset);
            first ??= asset;
            assert.equal(asset.key, first.key);
            assert.equal(asset.dictionaryHash, asset.hash);
            assert.equal(
                manifest.dictionaries[asset.dictionaryUrl].match,
                `/demo/${kind === 'module' ? 'jobs' : 'assets'}/my.worker-*.js`
            );
            if (version > 1) assert.notEqual(asset.url, first.url);
            const expected = await readFile(path.join(f.outDir, asset.file));
            const self = {};
            runInNewContext(expected.toString(), { self });
            assert.equal(self.pluginMarker, 42);
            assert.equal(self.catalog[7].value, version);
            for (const [encoding, decode] of [
                ['dcb', decompressDcb],
                ['dcz', decompressDcz],
            ]) {
                const variant = asset[encoding][first.dictionaryHash];
                assert.ok(variant, `v1 must decode v${version} with ${encoding}`);
                assert.deepEqual(
                    await decode(
                        await readFile(path.join(f.outDir, variant.file)),
                        path.join(f.storeDir, `dictionaries/${first.dictionaryHash}.dict`)
                    ),
                    expected
                );
            }
        }
    });

test('fixed worker names and unrelated nameless assets keep distinct exact matches', async (t) => {
    const f = await fixture(t);
    await put(f.root, 'index.html', '<script type="module" src="/app.js"></script>');
    await put(f.root, 'app.js', "window.worker=new Worker(new URL('./my.worker.js',import.meta.url));");
    const anonymous = ['assets/fixed-Ab12Cd34.js', 'assets/fixed-Ef56Gh78.js'];
    let first;
    for (const version of [1, 2]) {
        await put(f.root, 'my.worker.js', `self.version=${version};`);
        await buildVite(f, {
            plugins: [
                sharedDictionary({ storeDir: f.storeDir }),
                {
                    name: 'unrelated-assets',
                    generateBundle() {
                        for (const [index, fileName] of anonymous.entries())
                            this.emitFile({
                                type: 'asset',
                                fileName,
                                source: `window.example=${index};`,
                            });
                    },
                },
            ],
            worker: {
                rolldownOptions: { output: { entryFileNames: 'jobs/my.worker.js' } },
            },
        });
        const manifest = await readManifest(f.outDir);
        const worker = manifest.assets['/jobs/my.worker.js'];
        first ??= worker;
        assert.equal(worker.key, first.key);
        assert.equal(worker.dictionaryHash, worker.hash);
        assert.ok(worker.dcb[first.hash]);
        for (const url of ['/jobs/my.worker.js', ...anonymous.map((fileName) => `/${fileName}`)]) {
            const asset = manifest.assets[url];
            assert.ok(asset);
            assert.equal(manifest.dictionaries[asset.dictionaryUrl].match, url);
        }
        assert.notEqual(manifest.assets[`/${anonymous[0]}`].key, manifest.assets[`/${anonymous[1]}`].key);
    }
});

for (const publicFiles of ['absent', 'disabled-copy', 'disabled-directory'])
    test(`an HTML-only build preserves manually prepared assets in a retained output (${publicFiles})`, async (t) => {
        const f = await fixture(t);
        await put(f.root, 'index.html', '<h1>Static shell</h1>');
        const expected = 'window.manual=1;';
        const input = await put(f.outDir, 'manual.js', expected);
        await prepareAsset({ ...f, input, key: 'manual', url: '/manual.js' });
        if (publicFiles !== 'absent') await put(f.root, 'public/manual.js', 'window.manual=2;');
        const before = await readManifest(f.outDir);
        await buildVite(f, {
            publicDir: publicFiles === 'disabled-directory' ? false : 'public',
            build: {
                emptyOutDir: false,
                copyPublicDir: publicFiles !== 'disabled-copy',
            },
        });
        assert.deepEqual(await readManifest(f.outDir), before);
        assert.equal(await readFile(input, 'utf8'), expected);
    });

for (const mode of ['generate-only', 'failed'])
    test(`a ${mode} Vite build does not initialize an output manifest`, async (t) => {
        const f = await fixture(t);
        await put(
            f.root,
            'index.html',
            mode === 'failed' ? '<script type="module" src="/missing.js"></script>' : '<h1>Static shell</h1>'
        );
        const before = await readdir(f.outDir, { recursive: true });
        const run = () =>
            buildVite(f, {
                build: { write: mode !== 'generate-only' },
            });
        if (mode === 'failed') await assert.rejects(run);
        else await run();
        assert.deepEqual(await readdir(f.outDir, { recursive: true }), before);
    });

test('real Vite plugin handles renamed JS and CSS, base, exclusion, and build history', async (t) => {
    const f = await fixture(t);
    await put(f.root, 'src/style.css', '.app{color:red}');
    await put(f.root, 'src/skip.js', 'window.skip=1;');
    const entry = await put(f.root, 'src/main.js', 'import "./style.css"; window.buildVersion=1;');
    const config = {
        base: '/demo/',
        plugins: [
            sharedDictionary({
                storeDir: f.storeDir,
                exclude: (name) => name.startsWith('skip'),
                resolveAsset: ({ fileName }) =>
                    fileName.endsWith('.css')
                        ? { key: 'style', match: '/demo/assets/style-*.css' }
                        : { key: 'main', match: '/demo/assets/main-*.js' },
            }),
        ],
        build: {
            rolldownOptions: {
                input: { main: entry, skip: path.join(f.root, 'src/skip.js') },
                output: {
                    entryFileNames: (chunk) => (chunk.name === 'skip' ? 'skip.js' : 'assets/main-[hash].js'),
                    assetFileNames: 'assets/style-[hash][extname]',
                },
            },
        },
    };
    await buildVite(f, config);
    const first = await readManifest(f.outDir);
    assert.equal(Object.keys(first.assets).length, 2);
    const old = Object.values(first.assets).find((a) => a.key === 'main');
    await writeFile(entry, 'import "./style.css"; window.buildVersion=2;');
    await buildVite(f, config);
    const second = await readManifest(f.outDir);
    const current = Object.values(second.assets).find((a) => a.key === 'main');
    assert.notEqual(old.url, current.url);
    assert.ok(current.dcz[old.hash]);
    assert.ok(current.dcb[old.hash]);
    for (const asset of Object.values(second.assets)) {
        assert.deepEqual(Object.keys(asset.dcb).sort(), Object.keys(asset.dcz).sort());
        const variant = asset.dcb[asset.dictionaryHash];
        const dictionaryPath = path.join(f.outDir, second.dictionaries[variant.dictionaryUrl].file);
        assert.deepEqual(
            await decompressDcb(await readFile(path.join(f.outDir, variant.file)), dictionaryPath),
            await readFile(path.join(f.outDir, asset.file))
        );
    }
    assert.ok(second.dictionaries[old.dictionaryUrl]);
    assert.ok(Object.values(second.assets).every((a) => a.url.startsWith('/demo/')));
});

test('manual composition creates one dictionary from the two final outputs', async (t) => {
    const f = await fixture(t);
    const partsDir = path.join(f.root, 'parts');
    await put(partsDir, 'part-a.js', '(()=>{window.a=1})();');
    await put(partsDir, 'part-b.js', '(()=>{window.b=2})();');
    const asset = await compose({ ...f, partsDir });
    const manifest = await readManifest(f.outDir);
    assert.equal(Object.keys(manifest.assets).length, 1);
    const original = await readFile(path.join(f.outDir, asset.file));
    assert.match(original.toString(), /window.a=1[\s\S]*window.b=2/);
    const dict = path.join(f.outDir, manifest.dictionaries[asset.dictionaryUrl].file);
    assert.deepEqual(await readFile(dict), original);
    assert.deepEqual(
        await decompressDcz(await readFile(path.join(f.outDir, asset.dcz[asset.hash].file)), dict),
        original
    );
    assert.deepEqual(
        await decompressDcb(await readFile(path.join(f.outDir, asset.dcb[asset.hash].file)), dict),
        original
    );
});

for (const name of ['app', 'my.app', 'my.app.client'])
    test(`default Vite JS and CSS families retain dictionaries across content-hash changes (${name})`, async (t) => {
        const f = await fixture(t);
        const style = await put(f.root, `${name}.css`, ':root{--version:1;color:red}');
        const entry = await put(f.root, `${name}.js`, `import "./${name}.css"; window.version=1;`);
        const run = () =>
            buildVite(f, {
                build: { rolldownOptions: { input: entry } },
            });
        await run();
        const first = await readManifest(f.outDir);
        assert.equal(Object.keys(first.assets).length, 2);
        await writeFile(entry, `import "./${name}.css"; window.version=2;`);
        await writeFile(style, ':root{--version:2;color:blue}');
        await run();
        const second = await readManifest(f.outDir);
        assert.equal(Object.keys(second.assets).length, 2);
        for (const extension of ['js', 'css']) {
            const old = Object.values(first.assets).find((asset) => asset.url.endsWith(`.${extension}`));
            const current = Object.values(second.assets).find((asset) => asset.url.endsWith(`.${extension}`));
            assert.equal(current.key, old.key);
            assert.notEqual(current.url, old.url);
            assert.notEqual(current.hash, old.hash);
            assert.equal(current.dictionaryHash, current.hash);
            assert.notEqual(current.dictionaryUrl, old.dictionaryUrl);
            assert.equal(
                current.contentType,
                extension === 'css' ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8'
            );
            const dictionary = second.dictionaries[current.dictionaryUrl];
            assert.ok(dictionary.match.endsWith(`*.${extension}`));
            if (extension === 'js') assert.equal(dictionary.match, `/assets/${name}-*.js`);
            for (const [encoding, decode] of [
                ['dcb', decompressDcb],
                ['dcz', decompressDcz],
            ]) {
                const variant = current[encoding][old.hash];
                assert.ok(variant);
                assert.deepEqual(
                    await decode(
                        await readFile(path.join(f.outDir, variant.file)),
                        path.join(f.outDir, second.dictionaries[variant.dictionaryUrl].file)
                    ),
                    await readFile(path.join(f.outDir, current.file))
                );
            }
        }
        // Rebuilding unchanged input must not manufacture another filename hash.
        await run();
        assert.deepEqual(Object.keys((await readManifest(f.outDir)).assets).sort(), Object.keys(second.assets).sort());
    });

test('fixed dotted filenames retain their exact match across builds', async (t) => {
    const f = await fixture(t);
    const entry = await put(f.root, 'my.app.js', 'window.version=1;');
    const run = () =>
        buildVite(f, {
            base: '/demo/',
            build: {
                rolldownOptions: {
                    input: entry,
                    output: { entryFileNames: 'my.app.js' },
                },
            },
        });
    await run();
    const first = (await readManifest(f.outDir)).assets['/demo/my.app.js'];
    await writeFile(entry, 'window.version=2;');
    await run();
    const manifest = await readManifest(f.outDir);
    const second = manifest.assets[first.url];
    assert.equal(second.key, first.key);
    assert.notEqual(second.hash, first.hash);
    assert.equal(second.dictionaryHash, second.hash);
    assert.ok(second.dcb[first.hash]);
    assert.equal(manifest.dictionaries[second.dictionaryUrl].match, '/demo/my.app.js');
});
