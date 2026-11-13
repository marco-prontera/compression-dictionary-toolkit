import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import {
    prepareAsset,
    prepareAssets,
    readManifest,
    decompressDcb,
    decompressDcz,
} from 'compression-dictionary-toolkit';
import sharedDictionary from 'compression-dictionary-toolkit/vite';
import { fixture, source, put } from './helpers.mjs';
import { buildVite } from './vite-helpers.mjs';

// Hold real codecs at stdin until a full wave is running; assertions do not depend on encoder speed.
function observeCodecs(t, waveSize) {
    const spawn = childProcess.spawn;
    const children = new Set();
    let peak = 0;
    let pending = [];
    const observer = t.mock.method(childProcess, 'spawn', (...args) => {
        const child = spawn(...args);
        children.add(child);
        peak = Math.max(peak, children.size);
        child.once('close', () => children.delete(child));
        const end = child.stdin.end.bind(child.stdin);
        child.stdin.end = (...input) => {
            pending.push(() => end(...input));
            if (pending.length === waveSize) {
                const wave = pending;
                pending = [];
                wave.forEach((release) => release());
            }
            return child.stdin;
        };
        return child;
    });
    syncBuiltinESMExports();
    function restore() {
        observer.mock.restore();
        syncBuiltinESMExports();
    }
    t.after(() => {
        restore();
        children.forEach((child) => child.kill());
    });
    return { peak: () => peak, restore };
}

for (const concurrency of [1, 2]) {
    test(
        `batch overlaps codecs within its asset limit and preserves the first stable base (${concurrency})`,
        { timeout: 15000 },
        async (t) => {
            const f = await fixture(t);
            const options = [];
            for (let version = 1; version <= 4; version++) {
                options.push({
                    ...f,
                    input: await put(f.root, `input-${version}.js`, source(version)),
                    key: 'app',
                    dictionaryPolicy: 'stable',
                    match: '/app-*.js',
                    url: `/app-${version}.js`,
                });
            }
            const observer = observeCodecs(t, 2 * concurrency);
            const assets = await prepareAssets(options, { concurrency });
            assert.equal(observer.peak(), 2 * concurrency);
            observer.restore();

            assert.deepEqual(
                assets.map((asset) => asset.url),
                options.map((asset) => asset.url)
            );
            const manifest = await readManifest(f.outDir);
            const dictionary = path.join(f.outDir, manifest.dictionaries[assets[0].dictionaryUrl].file);
            assert.deepEqual(await readFile(dictionary), source(1));
            for (const [index, asset] of assets.entries()) {
                assert.equal(asset.dictionaryHash, assets[0].dictionaryHash);
                assert.deepEqual(manifest.assets[asset.url], asset);
                for (const [encoding, decode] of [
                    ['dcb', decompressDcb],
                    ['dcz', decompressDcz],
                ]) {
                    const variant = asset[encoding][asset.dictionaryHash];
                    assert.deepEqual(
                        await decode(await readFile(path.join(f.outDir, variant.file)), dictionary),
                        source(index + 1)
                    );
                }
            }
        }
    );
}

test('rolling batches snapshot history in input order and publish repeated URLs deterministically', async (t) => {
    const f = await fixture(t);
    const options = [];
    for (let version = 1; version <= 3; version++) {
        options.push({
            ...f,
            input: await put(f.root, `input-${version}.js`, source(version)),
            key: 'app',
            url: '/app.js',
            dictionaryPolicy: 'rolling',
            historyLimit: 2,
        });
    }
    const assets = await prepareAssets(options, { concurrency: 3 });
    for (const [index, asset] of assets.entries()) {
        const hashes = assets
            .slice(Math.max(0, index - 1), index + 1)
            .map((item) => item.dictionaryHash)
            .sort();
        assert.deepEqual(Object.keys(asset.dcb).sort(), hashes);
        assert.deepEqual(Object.keys(asset.dcz).sort(), hashes);
    }
    assert.deepEqual((await readManifest(f.outDir)).assets['/app.js'], assets[2]);
    assert.deepEqual(await readFile(path.join(f.outDir, 'app.js')), source(3));
    const registry = JSON.parse(await readFile(path.join(f.storeDir, 'registry.json')));
    assert.deepEqual(
        registry.groups.app.history.map((entry) => entry.hash),
        assets.map((asset) => asset.hash).reverse()
    );
});

test(
    'batch failure drains a running codec before releasing locks and leaves metadata unpublished',
    { timeout: 15000 },
    async (t) => {
        const f = await fixture(t);
        const input = await put(f.root, 'input.js', source());
        await prepareAsset({ ...f, input, key: 'existing', url: '/existing.js' });
        const manifestPath = path.join(f.outDir, '.cdt/manifest.json');
        const registryPath = path.join(f.storeDir, 'registry.json');
        const before = await Promise.all([readFile(manifestPath), readFile(registryPath)]);
        const missing = path.join(f.root, 'missing-brotli');
        const spawn = childProcess.spawn;
        let release;
        let starts = 0;
        const children = [];
        let notifyWaiting;
        let notifyFailure;
        const waiting = new Promise((resolve) => {
            notifyWaiting = resolve;
        });
        const failure = new Promise((resolve) => {
            notifyFailure = resolve;
        });

        const observer = t.mock.method(childProcess, 'spawn', (executable, ...args) => {
            const child = spawn(executable, ...args);
            children.push(child);
            starts++;
            if (executable === missing) {
                child.once('error', notifyFailure);
            } else {
                const end = child.stdin.end.bind(child.stdin);
                child.stdin.end = (...data) => {
                    release = () => end(...data);
                    notifyWaiting();
                    return child.stdin;
                };
            }
            return child;
        });
        syncBuiltinESMExports();
        t.after(() => {
            observer.mock.restore();
            syncBuiltinESMExports();
            children.forEach((child) => {
                if (child.exitCode === null && child.signalCode === null) child.kill();
            });
        });

        let settled = false;
        const batch = prepareAssets(
            [
                {
                    ...f,
                    input,
                    key: 'failing',
                    url: '/failing.js',
                    brotliBinary: missing,
                },
                { ...f, input, key: 'queued', url: '/queued.js' },
            ],
            { concurrency: 1 }
        );
        batch.then(
            () => {
                settled = true;
            },
            () => {
                settled = true;
            }
        );
        const rejected = assert.rejects(batch, /Cannot run brotli/);
        await Promise.all([waiting, failure]);
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(settled, false);
        assert.equal(starts, 2);
        await access(path.join(f.outDir, '.cdt/.write.lock'));
        await access(path.join(f.storeDir, '.write.lock'));
        release();
        await rejected;
        assert.equal(starts, 2);
        observer.mock.restore();
        syncBuiltinESMExports();

        assert.deepEqual(await readFile(manifestPath), before[0]);
        assert.deepEqual(await readFile(registryPath), before[1]);
        await assert.rejects(() => access(path.join(f.outDir, 'failing.js')), {
            code: 'ENOENT',
        });
        await assert.rejects(() => access(path.join(f.outDir, '.cdt/.write.lock')), { code: 'ENOENT' });
        await prepareAsset({ ...f, input, key: 'next', url: '/next.js' });
        assert.ok((await readManifest(f.outDir)).assets['/next.js']);
    }
);

test('batches reject invalid limits and mixed directories before publishing anything', async (t) => {
    const f = await fixture(t);
    const input = await put(f.root, 'input.js', source());
    const asset = { ...f, input, key: 'app', url: '/app.js' };
    for (const concurrency of [0, -1, 1.5, 17, NaN, '2', null]) {
        await assert.rejects(() => prepareAssets([asset], { concurrency }), /concurrency/);
        assert.throws(() => sharedDictionary({ concurrency }), /concurrency/);
    }
    for (const property of ['outDir', 'storeDir']) {
        await assert.rejects(
            () => prepareAssets([asset, { ...asset, [property]: path.join(f.root, 'other') }]),
            /same resolved/
        );
    }
    assert.deepEqual(await prepareAssets([]), []);
    await assert.rejects(() => access(path.join(f.outDir, '.cdt')), {
        code: 'ENOENT',
    });
    await assert.rejects(() => access(f.storeDir), { code: 'ENOENT' });
});

test('Vite submits finished assets to the bounded core batch', { timeout: 15000 }, async (t) => {
    const f = await fixture(t);
    const input = {};
    for (let version = 1; version <= 4; version++) {
        input[`app-${version}`] = await put(f.root, `input-${version}.js`, source(version));
    }
    const observer = observeCodecs(t, 4);
    await buildVite(f, {
        plugins: [sharedDictionary({ storeDir: f.storeDir, concurrency: 2 })],
        build: { rolldownOptions: { input } },
    });
    assert.equal(observer.peak(), 4);
    assert.equal(Object.keys((await readManifest(f.outDir)).assets).length, 4);
});

test('an encoder failure keeps completed peers out of the published batch', async (t) => {
    const f = await fixture(t);
    const input = await put(f.root, 'input.js', source());
    await prepareAsset({ ...f, input, key: 'existing', url: '/existing.js' });
    const manifestPath = path.join(f.outDir, '.cdt/manifest.json');
    const registryPath = path.join(f.storeDir, 'registry.json');
    const before = await Promise.all([readFile(manifestPath), readFile(registryPath)]);

    await assert.rejects(
        () =>
            prepareAssets(
                [
                    { ...f, input, key: 'ready', url: '/ready.js' },
                    {
                        ...f,
                        input,
                        key: 'failing',
                        url: '/failing.js',
                        brotliBinary: path.join(f.root, 'missing'),
                    },
                ],
                { concurrency: 2 }
            ),
        /Cannot run brotli/
    );

    assert.deepEqual(await readFile(manifestPath), before[0]);
    assert.deepEqual(await readFile(registryPath), before[1]);
    await assert.rejects(() => access(path.join(f.outDir, 'ready.js')), {
        code: 'ENOENT',
    });
});
