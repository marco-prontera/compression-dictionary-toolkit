import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, symlink } from 'node:fs/promises';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import {
    initializeManifest,
    prepareAsset,
    removePreparedAsset,
    readManifest,
    decompressDcb,
    decompressDcz,
    exportRelease,
} from 'compression-dictionary-toolkit';
import { fixture, source, put } from './helpers.mjs';

for (const alias of [false, true])
    test(`concurrent exports keep the manifest and upload plan together (target alias: ${alias})`, async (t) => {
        const f = await fixture(t);
        const targetDir = path.join(f.root, 'release');
        await mkdir(targetDir);
        const otherTarget = alias ? path.join(f.root, 'release-alias') : targetDir;
        if (alias) await symlink(targetDir, otherTarget, 'dir');
        const inputs = await Promise.all(
            ['a', 'b', 'c', 'd'].map(async (releaseId) => {
                const outDir = path.join(f.root, releaseId);
                await initializeManifest(outDir);
                await put(outDir, 'index.html', releaseId);
                return { outDir, releaseId };
            })
        );
        await Promise.all(
            inputs.map((options, index) => exportRelease({ ...options, targetDir: index ? otherTarget : targetDir }))
        );
        const manifest = JSON.parse(await readFile(path.join(targetDir, 'edge-manifest.json')));
        const plan = JSON.parse(await readFile(path.join(targetDir, 'upload-plan.json')));
        assert.equal(manifest.releaseId, plan.releaseId);
        const page = manifest.staticFiles['/'];
        assert.ok(plan.objects.some((object) => object.file === page.file));
        assert.equal(await readFile(path.join(targetDir, page.file), 'utf8'), manifest.releaseId);
    });

test('another process cannot replace metadata during an export', { timeout: 15000 }, async (t) => {
    const f = await fixture(t);
    await initializeManifest(f.outDir);
    await put(f.outDir, 'index.html', 'first release');
    const targetDir = path.join(f.root, 'release');
    const options = { outDir: f.outDir, targetDir, releaseId: 'first' };
    await exportRelease({ ...options, releaseId: 'initial' });
    const child = fork(new URL('./fixtures/paused-export.mjs', import.meta.url), [JSON.stringify(options)], {
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    const exited = once(child, 'exit');
    let stderr = '';
    child.stderr.on('data', (chunk) => {
        stderr += chunk;
    });
    t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await exited;
    });
    const ready = await Promise.race([
        once(child, 'message', { signal: AbortSignal.timeout(10000) }).then(([message]) => message),
        exited.then(() => {
            throw new Error(`Export exited before pausing: ${stderr}`);
        }),
    ]);
    assert.equal(ready, 'manifest-written');
    const before = await readFile(path.join(targetDir, 'edge-manifest.json'));
    const planBefore = await readFile(path.join(targetDir, 'upload-plan.json'));
    const alias = path.join(f.root, 'release-alias');
    await symlink(targetDir, alias, 'dir');
    await assert.rejects(
        () => exportRelease({ ...options, targetDir: alias, releaseId: 'competing' }),
        /Export is busy/
    );
    await exportRelease({ ...options, targetDir: path.join(f.root, 'independent'), releaseId: 'independent' });
    assert.deepEqual(await readFile(path.join(targetDir, 'edge-manifest.json')), before);
    assert.deepEqual(await readFile(path.join(targetDir, 'upload-plan.json')), planBefore);
    child.send('resume');
    const [code, signal] = await exited;
    assert.equal(signal, null, stderr);
    assert.equal(code, 0, stderr);
    await exportRelease({ ...options, targetDir: alias, releaseId: 'next' });
    assert.equal(JSON.parse(await readFile(path.join(targetDir, 'upload-plan.json'))).releaseId, 'next');
    assert.equal(JSON.parse(await readFile(path.join(targetDir, 'edge-manifest.json'))).releaseId, 'next');
});

for (const alias of [false, true])
    test(`concurrent preparations with separate stores preserve all assets (output alias: ${alias})`, async (t) => {
        const f = await fixture(t);
        const otherOutDir = alias ? path.join(f.root, 'dist-alias') : f.outDir;
        if (alias) await symlink(f.outDir, otherOutDir, 'dir');
        const inputs = await Promise.all([1, 2, 3].map((i) => put(f.root, `app-${i}.js`, source(i))));
        const results = await Promise.all(
            inputs.map((input, i) =>
                prepareAsset({
                    input,
                    outDir: i === 0 ? f.outDir : otherOutDir,
                    storeDir: path.join(f.root, `store-${i}`),
                    key: `app-${i}`,
                    url: `/app-${i}.js`,
                })
            )
        );
        const manifest = await readManifest(f.outDir);
        assert.deepEqual(Object.keys(manifest.assets).sort(), results.map((asset) => asset.url).sort());
        assert.equal(Object.keys(manifest.dictionaries).length, results.length);
        for (const [i, result] of results.entries()) {
            const asset = manifest.assets[result.url];
            assert.deepEqual(asset, result);
            const dictionary = path.join(f.outDir, manifest.dictionaries[asset.dictionaryUrl].file);
            for (const [encoding, decode] of [
                ['dcb', decompressDcb],
                ['dcz', decompressDcz],
            ]) {
                const variant = asset[encoding][asset.dictionaryHash];
                assert.deepEqual(
                    await decode(await readFile(path.join(f.outDir, variant.file)), dictionary),
                    source(i + 1)
                );
            }
        }
    });

for (const shared of ['output', 'store'])
    test(
        `another process holding the ${shared} rejects a conflicting preparation without changing the manifest`,
        { timeout: 15000 },
        async (t) => {
            const f = await fixture(t);
            const input = await put(f.root, 'app.js', source());
            const options = { ...f, input, key: 'app', url: '/app.js' };
            await prepareAsset(options);
            const manifestPath = path.join(f.outDir, '.cdt/manifest.json');
            const before = await readFile(manifestPath);
            const registryPath = path.join(f.storeDir, 'registry.json');
            const registryBefore = await readFile(registryPath);
            const nextInput = await put(f.root, 'next.js', source(2));
            const child = fork(
                new URL('./fixtures/paused-preparation.mjs', import.meta.url),
                [JSON.stringify({ ...options, input: nextInput })],
                {
                    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
                }
            );
            const exited = once(child, 'exit');
            let stderr = '';
            child.stderr.on('data', (chunk) => {
                stderr += chunk;
            });
            t.after(async () => {
                if (child.exitCode === null && child.signalCode === null) child.kill();
                await exited;
            });
            const ready = await Promise.race([
                once(child, 'message', { signal: AbortSignal.timeout(10000) }).then(([message]) => message),
                exited.then(() => {
                    throw new Error(`Preparation exited before pausing: ${stderr}`);
                }),
            ]);
            assert.equal(ready, 'manifest-read');

            // Unrelated output and store must remain usable while this preparation is paused.
            await prepareAsset({
                ...options,
                outDir: path.join(f.root, 'independent-dist'),
                storeDir: path.join(f.root, 'independent-store'),
            });
            const competing = {
                ...options,
                input: nextInput,
                outDir: shared === 'output' ? f.outDir : path.join(f.root, 'other-dist'),
                storeDir: shared === 'store' ? f.storeDir : path.join(f.root, 'other-store'),
            };
            await assert.rejects(
                () => prepareAsset(competing),
                shared === 'output' ? /Output is busy/ : /Store is busy/
            );
            if (shared === 'output') {
                await assert.rejects(() => removePreparedAsset({ outDir: f.outDir, url: '/app.js' }), /Output is busy/);
                await assert.rejects(() => initializeManifest(f.outDir), /Output is busy/);
            }
            assert.deepEqual(await readFile(manifestPath), before);
            assert.deepEqual(await readFile(registryPath), registryBefore);

            child.send('resume');
            const [code, signal] = await exited;
            assert.equal(signal, null, stderr);
            assert.equal(code, 0, stderr);
            // A conflict must release any other lock it already acquired.
            const result = await prepareAsset(competing);
            assert.equal((await readManifest(competing.outDir)).assets[result.url].hash, result.hash);
        }
    );

test('removing an asset preserves shared dictionaries and concurrent preparations through an output alias', async (t) => {
    const f = await fixture(t);
    const options = { ...f, key: 'app', match: '/app-*.js' };
    const first = await prepareAsset({
        ...options,
        input: await put(f.outDir, 'app-1.js', source(1)),
        url: '/app-1.js',
    });
    const second = await prepareAsset({
        ...options,
        input: await put(f.outDir, 'app-2.js', source(2)),
        url: '/app-2.js',
    });
    const registry = await readFile(path.join(f.storeDir, 'registry.json'));
    const alias = path.join(f.root, 'dist-alias');
    await symlink(f.outDir, alias, 'dir');
    const input = await put(f.root, 'app-3.js', source(3));
    const [removed, third] = await Promise.all([
        removePreparedAsset({ outDir: alias, url: first.url }),
        prepareAsset({ ...options, input, url: '/app-3.js', storeDir: path.join(f.root, 'other-store') }),
    ]);
    assert.equal(removed, true);
    const manifest = await readManifest(f.outDir);
    assert.deepEqual(Object.keys(manifest.assets).sort(), [second.url, third.url]);
    assert.ok(manifest.dictionaries[second.dictionaryUrl]);
    assert.ok(manifest.dictionaries[third.dictionaryUrl]);
    assert.deepEqual(await readFile(path.join(f.outDir, first.file)), source(1));
    assert.deepEqual(await readFile(path.join(f.storeDir, 'registry.json')), registry);
    assert.equal(await removePreparedAsset({ outDir: f.outDir, url: first.url }), false);
    assert.equal(await removePreparedAsset({ outDir: f.outDir, url: second.url }), true);
    const remaining = await readManifest(f.outDir);
    assert.deepEqual(Object.keys(remaining.assets), [third.url]);
    assert.deepEqual(Object.keys(remaining.dictionaries), [third.dictionaryUrl]);
});
