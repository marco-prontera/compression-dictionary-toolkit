import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { isPathInsideDirectory, writeFileAtomically } from '../src/core/utils.js';
import { fixture, put } from './helpers.mjs';

test('directory boundaries distinguish path segments from similarly named siblings', () => {
    const directory = path.resolve('test-results', 'assets');
    const cases = [
        [directory, true],
        [path.join(directory, 'nested', 'app.js'), true],
        [path.join(directory, '..draft', 'app.js'), true],
        [path.join(directory, 'nested', '..', 'app.js'), true],
        [path.join(directory, '..'), false],
        [path.join(directory, '..', 'assets-other', 'app.js'), false],
        [path.join(directory, '..', 'other', 'app.js'), false],
        [path.relative(process.cwd(), path.join(directory, 'app.js')), true],
    ];

    for (const [filePath, expected] of cases) {
        assert.equal(isPathInsideDirectory(directory, filePath), expected, filePath);
    }

    assert.equal(isPathInsideDirectory(path.parse(directory).root, directory), true);
    assert.equal(isPathInsideDirectory(path.relative(process.cwd(), directory), path.join(directory, 'app.js')), true);
});

test('atomic writes create missing parents, replace contents, and leave unrelated files alone', async (t) => {
    const { root } = await fixture(t);
    const destinationDirectory = path.join(root, 'nested', 'assets');
    const filePath = path.join(destinationDirectory, 'app.js');

    await writeFileAtomically(filePath, Buffer.from('first version'), root);
    assert.equal(await readFile(filePath, 'utf8'), 'first version');

    const marker = await put(destinationDirectory, '.cdt-write-existing/keep.txt', 'keep');
    await writeFileAtomically(filePath, Buffer.from('second version'), root);
    assert.equal(await readFile(filePath, 'utf8'), 'second version');
    assert.equal(await readFile(marker, 'utf8'), 'keep');
    assert.deepEqual((await readdir(destinationDirectory)).sort(), ['.cdt-write-existing', 'app.js']);
});

test('a failed staged write preserves the previous file and removes its temporary files', async (t) => {
    const { root, outDir } = await fixture(t);
    const filePath = await put(outDir, 'app.js', 'previous version');

    await assert.rejects(() => writeFileAtomically(filePath, null, root), { code: 'ERR_INVALID_ARG_TYPE' });
    assert.equal(await readFile(filePath, 'utf8'), 'previous version');
    assert.deepEqual(await readdir(outDir), ['app.js']);
});

test('a failed publication preserves the destination directory and removes its temporary files', async (t) => {
    const { root, outDir } = await fixture(t);
    const marker = await put(outDir, 'occupied/keep.txt', 'keep');
    const destinationPath = path.join(outDir, 'occupied');

    await assert.rejects(() => writeFileAtomically(destinationPath, Buffer.from('replacement'), root));
    assert.equal(await readFile(marker, 'utf8'), 'keep');
    assert.deepEqual(await readdir(destinationPath), ['keep.txt']);
    assert.deepEqual(await readdir(outDir), ['occupied']);
});

test('concurrent atomic writes expose only complete versions and leave no temporary files', async (t) => {
    const { root, outDir } = await fixture(t);
    const versions = [Buffer.alloc(128 * 1024, 'a'), Buffer.alloc(256 * 1024, 'b'), Buffer.alloc(64 * 1024, 'c')];
    const filePath = await put(outDir, 'app.js', versions[0]);

    async function readPublishedVersions() {
        for (let iteration = 0; iteration < 25; iteration++) {
            const content = await readFile(filePath);
            assert.ok(
                versions.some((version) => version.equals(content)),
                'Readers must see a complete version'
            );
        }
    }

    await Promise.all([
        readPublishedVersions(),
        ...versions.slice(1).map((content) => writeFileAtomically(filePath, content, root)),
    ]);

    const published = await readFile(filePath);
    assert.ok(versions.slice(1).some((version) => version.equals(published)));
    assert.deepEqual(await readdir(outDir), ['app.js']);
});
