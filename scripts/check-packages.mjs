import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { checkPublishMetadata } from './publish-metadata.mjs';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, 'Run this script with npm run check:packages or npm run pack:release');
const { values } = parseArgs({ options: { 'out-dir': { type: 'string' }, 'package': { type: 'string' } } });
const output = values['out-dir'] === undefined ? undefined : path.resolve(root, values['out-dir']);
const temporary = await mkdtemp(path.join(os.tmpdir(), 'shared-dictionary-packages-'));
const cache = path.join(temporary, 'npm-cache');
const consumer = path.join(temporary, 'consumer');
const name = 'compression-dictionary-toolkit';

async function npm(args, cwd) {
    return exec(process.execPath, [npmCli, '--cache', cache, ...args], {
        cwd,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, npm_config_update_notifier: 'false' },
    });
}

try {
    const { stdout } = await npm(
        [
            'pack',
            ...(values.package ? [values.package] : []),
            '--json',
            '--ignore-scripts',
            '--registry=https://registry.npmjs.org/',
            '--pack-destination',
            temporary,
        ],
        root
    );
    const packages = JSON.parse(stdout);
    assert.deepEqual(
        packages.map((item) => item.name),
        [name]
    );
    for (const item of packages) {
        const files = new Set(item.files.map((file) => file.path));
        for (const required of [
            'package.json',
            'README.md',
            'LICENSE',
            'src/core/index.js',
            'src/core/index.d.ts',
            'src/vite/index.js',
            'src/vite/index.d.ts',
            'src/server/index.js',
            'src/server/index.d.ts',
            'src/server/edge.js',
            'src/server/edge.d.ts',
            'src/shared/types.d.ts',
            'src/core/cli.js',
        ]) {
            assert.ok(files.has(required), `${item.name} is missing ${required}`);
        }
        for (const file of files) {
            assert.ok(
                file.startsWith('src/') || ['package.json', 'README.md', 'LICENSE', 'CHANGELOG.md'].includes(file),
                `${item.name} includes an unexpected file: ${file}`
            );
        }
    }

    await mkdir(consumer);
    await writeFile(path.join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    // Use normal peer resolution: Vite must remain absent from this server-only installation.
    await npm(
        [
            'install',
            '--offline',
            '--ignore-scripts',
            '--no-audit',
            '--no-fund',
            ...packages.map((item) => path.join(temporary, item.filename)),
        ],
        consumer
    );

    const manifest = JSON.parse(await readFile(path.join(consumer, 'node_modules', name, 'package.json'), 'utf8'));
    assert.equal(manifest.license, 'MIT');
    assert.equal(manifest.author, 'Marco Prontera');
    assert.ok(!manifest.private);
    assert.deepEqual(manifest.dependencies ?? {}, {});
    assert.deepEqual(Object.keys(manifest.exports), ['.', './vite', './server', './edge']);
    assert.equal(manifest.peerDependenciesMeta.vite.optional, true);
    await assert.rejects(() => readFile(path.join(consumer, 'node_modules/vite/package.json')), { code: 'ENOENT' });

    // Reject unwanted imports while loading the actual installed entry points.
    const loader = path.join(temporary, 'import-guard.mjs');
    await writeFile(
        loader,
        [
            "import { isBuiltin } from 'node:module';",
            'export async function resolve(specifier, context, nextResolve) {',
            "  if (specifier === 'vite' || specifier.startsWith('vite/')) throw new Error('Unexpected Vite import');",
            "  if (process.env.CDT_IMPORT_CHECK === 'edge' && isBuiltin(specifier)) throw new Error('Unexpected Node import: ' + specifier);",
            '  const resolved = await nextResolve(specifier, context);',
            "  if (process.env.CDT_IMPORT_CHECK === 'server' && /\\/src\\/(?:vite\\/|core\\/(?:index|codec|release|tasks)\\.js)/.test(resolved.url)) throw new Error('Unexpected build import: ' + resolved.url);",
            '  return resolved;',
            '}',
        ].join('\n')
    );
    for (const [entry, mode] of [
        ['', 'core'],
        ['/vite', 'vite'],
        ['/server', 'server'],
        ['/edge', 'edge'],
    ]) {
        await exec(
            process.execPath,
            [
                '--no-warnings',
                '--experimental-loader',
                loader,
                '--input-type=module',
                '-e',
                'await import(' + JSON.stringify(name + entry) + ')',
            ],
            { cwd: consumer, env: { ...process.env, CDT_IMPORT_CHECK: mode } }
        );
    }
    await writeFile(
        path.join(consumer, 'edge.mts'),
        [
            "import { createEdgeHandler, type EdgeManifest } from 'compression-dictionary-toolkit/edge';",
            "const manifest: EdgeManifest = { schemaVersion: 1, kind: 'shared-dict-release', releaseId: 'types', assets: {}, dictionaries: {}, staticFiles: {} };",
            'const handle = createEdgeHandler({ manifest, loadObject: async () => new Uint8Array() });',
            "const response: Promise<Response> = handle(new Request('https://example.test/'), undefined);",
            'void response;',
        ].join('\n')
    );
    await writeFile(
        path.join(consumer, 'tsconfig.json'),
        JSON.stringify({
            compilerOptions: {
                target: 'ES2022',
                module: 'NodeNext',
                moduleResolution: 'NodeNext',
                strict: true,
                noEmit: true,
                types: [],
                lib: ['ES2022', 'DOM'],
                skipLibCheck: false,
            },
            include: ['edge.mts'],
        })
    );
    await exec(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'], {
        cwd: consumer,
    });

    await exec(
        process.execPath,
        [
            '--input-type=module',
            '-e',
            `
    import assert from 'node:assert/strict';
    import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
    import { createDictionary, prepareAsset, initializeManifest, exportRelease } from 'compression-dictionary-toolkit';
    import sharedDictionary from 'compression-dictionary-toolkit/vite';
    import { createDictionaryServer } from 'compression-dictionary-toolkit/server';
    import { createEdgeHandler } from 'compression-dictionary-toolkit/edge';
    await writeFile('input.js', 'export const answer = 42;');
    const dictionary = await createDictionary({ input: 'input.js', key: 'app', match: '/app.js' });
    assert.equal(dictionary.hash.length, 64);
    assert.equal(sharedDictionary().apply, 'build');

    // Verify the safety checks in the installed tarball, without relying on repository imports or encoders.
    await initializeManifest('dist');
    const before = await readFile('dist/.cdt/manifest.json');
    await assert.rejects(
        () => prepareAsset({ input: 'input.js', key: 'other', url: '/.cdt/manifest.json' }),
        /reserved.*cdt/
    );
    assert.deepEqual(await readFile('dist/.cdt/manifest.json'), before);
    await writeFile('dist/index.html', '<h1>Package check</h1>');
    await mkdir('release');
    await writeFile('release/.write.lock', 'package-check');
    await assert.rejects(() => exportRelease({ releaseId: 'blocked' }), /Export is busy/);
    await unlink('release/.write.lock');
    await exportRelease({ releaseId: 'verified' });
    const manifest = JSON.parse(await readFile('release/edge-manifest.json'));
    const plan = JSON.parse(await readFile('release/upload-plan.json'));
    assert.equal(manifest.releaseId, 'verified');
    assert.equal(plan.releaseId, manifest.releaseId);
    assert.ok(plan.objects.some(object => object.file === manifest.staticFiles['/'].file));
    const server = createDictionaryServer({ root: 'dist', serverTiming: true });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        const response = await fetch('http://127.0.0.1:' + server.address().port);
        assert.equal(await response.text(), '<h1>Package check</h1>');
        assert.ok(response.headers.has('server-timing'));
    } finally {
        await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    }
    const edge = createEdgeHandler({ manifest, loadObject: file => readFile('release/' + file) });
    const response = await edge(new Request('https://example.test/'));
    assert.equal(await response.text(), '<h1>Package check</h1>');
  `,
        ],
        { cwd: consumer }
    );

    const cli = await npm(['exec', '--offline', '--', 'shared-dict', '--help'], consumer);
    assert.match(cli.stdout, /shared-dict export/);
    await checkPublishMetadata({
        directory: path.join(consumer, 'node_modules', name),
        npmCli,
        cache,
        integrity: packages[0].integrity,
    });
    console.log(
        'One tarball verified: contents, license, offline installation without Vite, isolated entry points, edge types, core checks, CLI, and publication metadata.'
    );
    if (output) {
        await mkdir(output, { recursive: true });
        const staging = path.join(output, 'package');
        for (const file of packages[0].files) {
            const target = path.join(staging, file.path);
            await mkdir(path.dirname(target), { recursive: true });
            await copyFile(path.join(consumer, 'node_modules', name, file.path), target);
        }
        const staged = await npm(
            ['pack', staging, '--json', '--ignore-scripts', '--pack-destination', temporary],
            root
        );
        assert.equal(
            JSON.parse(staged.stdout)[0].integrity,
            packages[0].integrity,
            'Staging must reproduce the verified archive'
        );
        await Promise.all(
            packages.map((item) => copyFile(path.join(temporary, item.filename), path.join(output, item.filename)))
        );
        await writeFile(path.join(output, 'packages.json'), JSON.stringify(packages, null, 4) + '\n');
        console.log('Verified packages saved to ' + path.relative(root, output));
        for (const item of packages) {
            console.log('  ' + item.filename + ' (' + item.size + ' bytes)');
        }
    }
} finally {
    await rm(temporary, { recursive: true, force: true });
}
