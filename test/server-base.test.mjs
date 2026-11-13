import test from 'node:test';
import assert from 'node:assert/strict';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Duplex } from 'node:stream';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import fs, { mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import path from 'node:path';
import { buildVite } from './vite-helpers.mjs';
import sharedDictionary from 'compression-dictionary-toolkit/vite';
import { prepareAsset, readManifest, digestHeader, decompressDcb, decompressDcz } from 'compression-dictionary-toolkit';
import { createRequestHandler } from 'compression-dictionary-toolkit/server';
import { exportEdge, requestEdge } from './edge-helpers.mjs';
import { fixture, put, source } from './helpers.mjs';

const exec = promisify(execFile);

// Exercise real Node HTTP responses over an in-memory socket without opening a listening port.
async function request(handler, url, headers = {}, method = 'GET') {
    const chunks = [];
    const socket = new Duplex({
        read() {},
        write(chunk, encoding, callback) {
            chunks.push(Buffer.from(chunk));
            callback();
        },
    });
    socket.encrypted = true;
    const req = new IncomingMessage(socket);
    Object.assign(req, {
        url,
        method,
        headers,
        httpVersion: '1.1',
        httpVersionMajor: 1,
        httpVersionMinor: 1,
    });
    const res = new ServerResponse(req);
    res.assignSocket(socket);
    const finished = once(res, 'finish');
    try {
        await handler(req, res);
        await finished;
        const wire = Buffer.concat(chunks);
        return {
            status: res.statusCode,
            headers: res.getHeaders(),
            body: wire.subarray(wire.indexOf('\r\n\r\n') + 4),
        };
    } finally {
        socket.destroy();
    }
}

for (const base of ['/', '/app/'])
    test(`public filenames export and serve through equivalent URL encodings under ${base}`, async (t) => {
        const f = await fixture(t);
        const files = [
            ['logo.svg', ['logo.svg', '%6cogo.svg']],
            ['logo light.svg', ['logo%20light.svg']],
            ['caffè.svg', ['caff%C3%A8.svg', 'caff%c3%a8.svg', 'caffè.svg']],
            ['logo@2x.svg', ['logo@2x.svg', 'logo%402x.svg']],
            ['percent%logo.svg', ['percent%25logo.svg']],
            ['logo%20light.svg', ['logo%2520light.svg']],
            ['folder/name.svg', ['folder/name.svg']],
            ['folder%2Fname.svg', ['folder%252Fname.svg']],
            ['icons été/logo#1?.svg', ['icons%20%C3%A9t%C3%A9/logo%231%3F.svg']],
            ["icons/it's (new)!.svg", ["icons/it's%20(new)!.svg", 'icons/it%27s%20%28new%29%21.svg']],
            ['%2eenv.svg', ['%252eenv.svg']],
        ];
        await put(f.root, 'index.html', files.map(([, urls]) => `<img src="${base}${urls[0]}">`).join('\n'));
        for (const [index, [file]] of files.entries())
            await put(f.root, `public/${file}`, `<svg xmlns="http://www.w3.org/2000/svg"><text>${index}</text></svg>`);
        await buildVite(f, {
            base,
        });
        await put(f.outDir, '.env.svg', 'private');
        await put(f.outDir, '.private/logo.svg', 'private');
        const node = createRequestHandler({ root: f.outDir, base });
        const edge = await exportEdge(f, { base, releaseId: 'public-paths' });
        const edgeRequest = (url, headers, method) => requestEdge(edge, url, headers, method);
        for (const get of [(url, headers, method) => request(node, url, headers, method), edgeRequest]) {
            for (const [index, [, urls]] of files.entries()) {
                const expected = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"><text>${index}</text></svg>`);
                let tag;
                for (const suffix of urls) {
                    const url = `${base}${suffix}`;
                    const response = await get(url);
                    assert.equal(response.status, 200, url);
                    assert.deepEqual(response.body, expected, url);
                    assert.equal(response.headers['content-type'], 'image/svg+xml');
                    tag ??= response.headers.etag;
                    assert.equal(response.headers.etag, tag);
                    const head = await get(url, {}, 'HEAD');
                    assert.equal(head.status, 200);
                    assert.equal(head.body.length, 0);
                    assert.equal(Number(head.headers['content-length']), expected.length);
                    const cached = await get(`${url}?version=1`, {
                        'if-none-match': tag,
                    });
                    assert.equal(cached.status, 304);
                    assert.equal(cached.body.length, 0);
                }
            }
            for (const suffix of [
                '.env.svg',
                '%2eenv.svg',
                '%2Eprivate/logo.svg',
                '.cdt/manifest.json',
                'safe%2f..%2f.env.svg',
                'safe%2f.%2flogo.svg',
                '%5c.env.svg',
                '%00',
            ])
                assert.equal((await get(`${base}${suffix}`)).status, 403, suffix);
            assert.equal((await get(`${base}missing%20file.svg`)).status, 404);
            if (base !== '/') assert.equal((await get('/logo.svg')).status, 404);
        }
    });

for (const dynamicRoot of [false, true])
    test(`Node keeps an in-flight request on its release during an atomic switch (dynamic root: ${dynamicRoot})`, async (t) => {
        const f = await fixture(t);
        const releases = [];
        for (const version of [1, 2]) {
            const outDir = path.join(f.root, `v${version}`);
            const input = await put(outDir, 'app.js', source(version));
            const asset = await prepareAsset({
                ...f,
                outDir,
                input,
                key: 'app',
                url: '/app.js',
                dictionaryEpoch: `v${version}`,
            });
            await put(outDir, 'index.html', `<h1>Release ${version}</h1>`);
            releases.push({ outDir, asset });
        }
        const active = path.join(f.root, 'current');
        const handler = createRequestHandler({
            root: dynamicRoot ? async () => active : active,
        });
        for (const kind of ['asset', 'dictionary', 'static']) {
            await rm(active, { force: true });
            await symlink(releases[0].outDir, active, 'dir');
            const originalOpen = fs.open;
            let switched = false;
            // Switch releases after the bounded manifest read closes its file descriptor.
            fs.open = async (file, ...args) => {
                const handle = await originalOpen(file, ...args);
                if (String(file).endsWith('/.cdt/manifest.json')) {
                    const close = handle.close.bind(handle);
                    handle.close = async () => {
                        await close();
                        if (!switched) {
                            switched = true;
                            const next = path.join(f.root, 'next');
                            await symlink(releases[1].outDir, next, 'dir');
                            await rename(next, active);
                        }
                    };
                }
                return handle;
            };
            syncBuiltinESMExports();
            try {
                for (const [index, release] of releases.entries()) {
                    const url =
                        kind === 'dictionary' ? release.asset.dictionaryUrl : kind === 'static' ? '/' : '/app.js';
                    const response = await request(handler, url);
                    assert.equal(response.status, 200, kind);
                    assert.deepEqual(
                        response.body,
                        kind === 'static' ? Buffer.from(`<h1>Release ${index + 1}</h1>`) : source(index + 1),
                        kind
                    );
                }
                assert.equal(switched, true);
            } finally {
                fs.open = originalOpen;
                syncBuiltinESMExports();
            }
        }
    });

for (const transient of [true, false])
    test(
        `Node handles a realpath race while pinning a release (transient: ${transient})`,
        { timeout: 5000 },
        async (t) => {
            const f = await fixture(t);
            const input = await put(f.outDir, 'app.js', source());
            await prepareAsset({ ...f, input, key: 'app', url: '/app.js' });
            const active = path.join(f.root, 'current');
            await symlink(f.outDir, active, 'dir');
            const originalRealpath = fs.realpath;
            let failed = false;
            // macOS can return EINVAL when an atomic symlink replacement interrupts realpath.
            fs.realpath = async (file, ...args) => {
                if (file === active && (!transient || !failed)) {
                    failed = true;
                    throw Object.assign(new Error('Symlink changed during resolution'), {
                        code: 'EINVAL',
                    });
                }
                return originalRealpath(file, ...args);
            };
            syncBuiltinESMExports();
            try {
                const response = await request(createRequestHandler({ root: active }), '/app.js');
                assert.equal(response.status, transient ? 200 : 500);
                if (transient) assert.deepEqual(response.body, source());
            } finally {
                fs.realpath = originalRealpath;
                syncBuiltinESMExports();
            }
        }
    );

for (const extension of ['js', 'mjs', 'cjs', 'JS', 'MJS', 'CJS', 'css', 'CSS'])
    test(`excluded .${extension} keeps its MIME type on Node and edge after a rebuild`, async (t) => {
        const f = await fixture(t);
        const css = extension.toLowerCase() === 'css';
        const entry = await put(f.root, 'app.js', css ? "import './app.css';window.version=1;" : 'window.version=1;');
        if (css) await put(f.root, 'app.css', '.app{color:red}');
        const fileName = css ? `style.${extension}` : `app.${extension}`;
        const run = (exclude) =>
            buildVite(f, {
                plugins: [
                    sharedDictionary({
                        storeDir: f.storeDir,
                        exclude: (name) => exclude && name === fileName,
                    }),
                ],
                build: {
                    emptyOutDir: false,
                    rolldownOptions: {
                        input: entry,
                        output: css ? { assetFileNames: fileName } : { entryFileNames: fileName },
                    },
                },
            });
        const contentType = css ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8';
        await run(false);
        const node = createRequestHandler({ root: f.outDir });
        const before = await request(node, `/${fileName}`);
        assert.equal(before.headers['content-type'], contentType);
        if (css) await put(f.root, 'app.css', '.app{color:blue}');
        else await put(f.root, 'app.js', 'window.version=2;');
        await run(true);
        const expected = await readFile(path.join(f.outDir, fileName));
        assert.notDeepEqual(expected, before.body);
        const after = await request(node, `/${fileName}`);
        const edge = await exportEdge(f, { releaseId: 'excluded' });
        const response = await edge(new Request(`https://app.example/${fileName}`));
        assert.equal(after.status, 200);
        assert.equal(response.status, 200);
        assert.deepEqual(after.body, expected);
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected);
        assert.equal(after.headers['x-content-type-options'], 'nosniff');
        assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
        assert.deepEqual(
            [after.headers['content-type'], response.headers.get('Content-Type')],
            [contentType, contentType]
        );
    });

for (const legacy of [false, true])
    for (const fails of [false, true])
        test(`native codec changes preserve published responses and exports (legacy paths: ${legacy}, failed preparation: ${fails})`, async (t) => {
            const f = await fixture(t);
            const input = await put(f.root, 'input.js', source());
            const options = { ...f, input, key: 'first', url: '/first.js' };
            const first = await prepareAsset(options);
            const manifestPath = path.join(f.outDir, '.cdt/manifest.json');
            if (legacy) {
                // Older releases addressed ordinary encodings only by the uncompressed asset hash.
                const manifest = await readManifest(f.outDir);
                for (const encoding of ['br', 'gzip']) {
                    const representation = first.representations[encoding];
                    const bytes = await readFile(path.join(f.outDir, representation.file));
                    representation.file = `.cdt/variants/${first.hash}/${encoding}`;
                    await put(f.outDir, representation.file, bytes);
                    manifest.assets[first.url].representations[encoding] = representation;
                }
                await writeFile(manifestPath, JSON.stringify(manifest));
            }
            const before = await readFile(manifestPath);
            const run = () =>
                exec(process.execPath, [
                    fileURLToPath(new URL('./fixtures/prepare-with-different-codecs.mjs', import.meta.url)),
                    JSON.stringify({
                        ...options,
                        key: 'second',
                        url: '/second.js',
                        ...(fails ? { brotliBinary: path.join(f.root, 'missing-brotli') } : {}),
                    }),
                ]);
            let second;
            if (fails) {
                await assert.rejects(run, /Install Brotli/);
                assert.deepEqual(await readFile(manifestPath), before);
            } else {
                second = JSON.parse((await run()).stdout);
                for (const encoding of ['br', 'gzip'])
                    assert.notEqual(second.representations[encoding].hash, first.representations[encoding].hash);
            }
            const node = createRequestHandler({ root: f.outDir });
            for (const [encoding, decode] of [
                ['br', brotliDecompressSync],
                ['gzip', gunzipSync],
            ]) {
                const response = await request(node, first.url, {
                    'accept-encoding': `${encoding},identity;q=0`,
                });
                assert.equal(response.status, 200);
                assert.equal(response.headers.etag, `"${first.representations[encoding].hash}"`);
                assert.deepEqual(decode(response.body), source());
                if (second) {
                    const next = await request(node, second.url, {
                        'accept-encoding': `${encoding},identity;q=0`,
                    });
                    assert.equal(next.status, 200);
                    assert.deepEqual(decode(next.body), source());
                }
            }
            const edge = await exportEdge(f, { releaseId: 'codec-change' });
            for (const [encoding, decode] of [
                ['br', brotliDecompressSync],
                ['gzip', gunzipSync],
            ]) {
                const response = await edge(
                    new Request(`https://app.example${first.url}`, {
                        headers: { 'Accept-Encoding': `${encoding},identity;q=0` },
                    })
                );
                assert.equal(response.status, 200);
                assert.equal(response.headers.get('ETag'), `"${first.representations[encoding].hash}"`);
                assert.deepEqual(decode(Buffer.from(await response.arrayBuffer())), source());
            }
        });

for (const base of ['/', '/app/'])
    for (const backend of ['Node', 'edge'])
        test(`${backend} serves manifest-declared dot-prefixed assets and dictionaries under ${base}`, async (t) => {
            const f = await fixture(t);
            await put(f.root, 'index.html', '<script type="module" src="/app.js"></script>');
            await put(f.root, 'app.js', "import './app.css';window.version=1;");
            await put(f.root, 'app.css', '.app { color: red; }');
            await buildVite(f, {
                base,
                plugins: [
                    sharedDictionary({
                        storeDir: f.storeDir,
                        dictionaryBase: '/.well-known/compression-dictionaries/',
                    }),
                ],
                build: { assetsDir: '.assets' },
            });
            await put(f.outDir, '.env', 'PRIVATE=secret');
            await put(f.outDir, '.assets/private.txt', 'private');
            await put(f.outDir, '.dictionary-store/registry.json', '{}');
            const manifest = await readManifest(f.outDir);
            const assets = Object.values(manifest.assets);
            assert.equal(assets.length, 2);
            assert.ok(assets.some((asset) => asset.url.endsWith('.js')));
            assert.ok(assets.some((asset) => asset.url.endsWith('.css')));
            let get;
            if (backend === 'Node') {
                const handler = createRequestHandler({ root: f.outDir, base });
                get = (url, headers, method) => request(handler, url, headers, method);
            } else {
                const handler = await exportEdge(f, { base, releaseId: 'dot-routes' });
                get = (url, headers, method) => requestEdge(handler, url, headers, method);
            }
            for (const asset of assets) {
                assert.ok(asset.url.startsWith(`${base}.assets/`));
                const expected = await readFile(path.join(f.outDir, asset.url.slice(base.length)));
                const identity = await get(asset.url);
                assert.equal(identity.status, 200);
                assert.deepEqual(identity.body, expected);
                assert.equal(identity.headers.link, undefined);
                assert.ok(identity.headers['use-as-dictionary'].includes(`id="${asset.key}-${asset.hash}"`));
                const dictionary = await get(asset.dictionaryUrl);
                assert.equal(dictionary.status, 200);
                assert.match(dictionary.headers['use-as-dictionary'], /^match=/);
                assert.deepEqual(
                    dictionary.body,
                    await readFile(path.join(f.outDir, manifest.dictionaries[asset.dictionaryUrl].file))
                );
                const cachedDictionary = await put(f.root, `cached-${asset.dictionaryHash}.dict`, dictionary.body);
                for (const [encoding, decode] of [
                    ['dcb', decompressDcb],
                    ['dcz', decompressDcz],
                ]) {
                    const headers = {
                        'accept-encoding': `${encoding},identity;q=0`,
                        'available-dictionary': digestHeader(asset.dictionaryHash),
                    };
                    const response = await get(asset.url, headers);
                    assert.equal(response.status, 200);
                    assert.equal(response.headers['content-encoding'], encoding);
                    assert.deepEqual(await decode(response.body, cachedDictionary), expected);
                    const head = await get(asset.url, headers, 'HEAD');
                    assert.equal(head.status, 200);
                    assert.equal(head.body.length, 0);
                    assert.equal(Number(head.headers['content-length']), response.body.length);
                    const cached = await get(asset.url, {
                        ...headers,
                        'if-none-match': response.headers.etag,
                    });
                    assert.equal(cached.status, 304);
                    assert.equal(cached.body.length, 0);
                }
                // An encoded alias is not the exact public URL declared by the build.
                assert.equal((await get(asset.url.replace('.assets', '%2eassets'))).status, 403);
            }
            for (const suffix of [
                '.env',
                '.assets/private.txt',
                '.cdt/manifest.json',
                '.dictionary-store/registry.json',
                'safe%2f..%2f.env',
                '%5c.env',
                '%00',
            ])
                assert.equal((await get(`${base}${suffix}`)).status, 403, suffix);
            assert.equal((await get('/.well-known/compression-dictionaries/missing.dict')).status, 403);
            assert.equal((await get(`${base}missing.txt`)).status, 404);
            if (backend === 'Node') {
                for (const suffix of ['./.env', '../.env', '%2e%2e/.env'])
                    assert.equal((await get(`${base}${suffix}`)).status, 403, suffix);
            }
        });

for (const base of ['/', '/app/', '/nested/app/'])
    test(`Node serves a Vite build and its public files under ${base}`, async (t) => {
        const f = await fixture(t);
        await put(f.root, 'index.html', `<script type="module" src="/app.js"></script><img src="${base}logo.svg">`);
        await put(f.root, 'app.js', 'window.version=1;');
        const image = '<svg xmlns="http://www.w3.org/2000/svg"/>';
        await put(f.root, 'public/logo.svg', image);
        const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
        await put(f.root, 'public/module.wasm', wasm);
        await buildVite(f, {
            base,
        });
        const handler = createRequestHandler({
            root: async () => f.outDir,
            ...(base === '/' ? {} : { base }),
        });
        const html = await readFile(path.join(f.outDir, 'index.html'));
        for (const url of [base, `${base}index.html`, `${base}index.html?v=1`]) {
            const response = await request(handler, url);
            assert.equal(response.status, 200, url);
            assert.equal(response.headers['content-type'], 'text/html; charset=utf-8');
            assert.deepEqual(response.body, html);
            const head = await request(handler, url, {}, 'HEAD');
            assert.equal(head.status, 200);
            assert.equal(head.body.length, 0);
            assert.equal(head.headers['content-length'], html.length);
            const cached = await request(handler, url, {
                'if-none-match': response.headers.etag,
            });
            assert.equal(cached.status, 304);
            assert.equal(cached.body.length, 0);
        }
        const logo = await request(handler, `${base}logo.svg`);
        assert.equal(logo.status, 200);
        assert.equal(logo.headers['content-type'], 'image/svg+xml');
        assert.equal(logo.body.toString(), image);
        const moduleResponse = await request(handler, `${base}module.wasm`);
        assert.equal(moduleResponse.status, 200);
        assert.deepEqual(moduleResponse.body, wasm);
        const compiled = await WebAssembly.instantiateStreaming(
            new Response(moduleResponse.body, {
                headers: { 'Content-Type': moduleResponse.headers['content-type'] },
            })
        );
        assert.ok(compiled.instance instanceof WebAssembly.Instance);
        const manifest = await readManifest(f.outDir);
        const asset = Object.values(manifest.assets)[0];
        const plain = await request(handler, asset.url);
        assert.equal(plain.status, 200);
        assert.deepEqual(plain.body, await readFile(path.join(f.outDir, asset.representations.identity.file)));
        const canonical = digestHeader(asset.dictionaryHash);
        for (const available of [canonical, canonical.replace('=:', ':')]) {
            const encoded = await request(handler, asset.url, {
                'accept-encoding': 'dcb,identity;q=0',
                'available-dictionary': available,
            });
            assert.equal(encoded.status, 200);
            assert.equal(encoded.headers['content-encoding'], 'dcb');
            assert.deepEqual(encoded.body, await readFile(path.join(f.outDir, asset.dcb[asset.dictionaryHash].file)));
        }
        // Dictionary routes are absolute manifest URLs, even when they are outside the app's base.
        const dictionary = await request(handler, asset.dictionaryUrl);
        assert.equal(dictionary.status, 200);
        assert.deepEqual(
            dictionary.body,
            await readFile(path.join(f.outDir, manifest.dictionaries[asset.dictionaryUrl].file))
        );
        if (base !== '/') {
            for (const url of ['/', '/index.html', '/logo.svg', `${base.slice(0, -1)}lication/logo.svg`])
                assert.equal((await request(handler, url)).status, 404, url);
        }
        const secret = await put(f.root, 'secret.txt', 'private');
        await symlink(secret, path.join(f.outDir, 'leak.txt'));
        for (const suffix of ['.cdt/manifest.json', '%2e%2e/secret.txt', '%5csecret.txt', 'leak.txt'])
            assert.equal((await request(handler, `${base}${suffix}`)).status, 403, suffix);
        assert.equal((await request(handler, `${base}missing.txt`)).status, 404);
    });

test('Node rejects invalid public bases before handling requests', () => {
    for (const base of ['app/', '/app', '//example/', '/app/../', '/.private/', '/app?/', '/app#/', '/app%2f/'])
        assert.throws(() => createRequestHandler({ base }), /base/);
});

for (const base of ['/', '/app/'])
    test(`a Vite build containing only HTML can be served and exported under ${base}`, async (t) => {
        const f = await fixture(t);
        await put(f.root, 'index.html', '<h1>Static release</h1>');
        await buildVite(f, {
            base,
        });
        const html = await readFile(path.join(f.outDir, 'index.html'));
        const handler = createRequestHandler({ root: f.outDir, base });
        const response = await request(handler, base);
        assert.equal(response.status, 200);
        assert.deepEqual(response.body, html);
        assert.equal((await request(handler, base, { 'if-none-match': response.headers.etag })).status, 304);
        const manifest = await readManifest(f.outDir);
        assert.deepEqual(manifest.assets, {});
        assert.deepEqual(manifest.dictionaries, {});
        const edge = await exportEdge(f, { base, releaseId: 'static' });
        const edgeResponse = await edge(new Request(`https://app.example${base}`));
        assert.equal(edgeResponse.status, 200);
        assert.equal(edgeResponse.headers.get('Content-Type'), 'text/html; charset=utf-8');
        assert.deepEqual(Buffer.from(await edgeResponse.arrayBuffer()), html);
    });

for (const withOtherBundle of [false, true])
    test(`a retained Vite output serves current bytes when a bundle moves to public (other bundle: ${withOtherBundle})`, async (t) => {
        const f = await fixture(t);
        const base = '/demo/';
        const publicDir = withOtherBundle ? 'static' : 'public';
        let rebuilding = false;
        const url = `${base}assets/app.js`;
        await put(f.root, 'index.html', '<script type="module" src="/src/app.js"></script>');
        await put(f.root, 'src/app.js', 'window.version=1;');
        const run = () =>
            buildVite(f, {
                base,
                publicDir,
                build: {
                    emptyOutDir: false,
                    rolldownOptions: {
                        output: {
                            entryFileNames: () => (rebuilding && withOtherBundle ? 'assets/other.js' : 'assets/app.js'),
                        },
                    },
                },
            });
        await run();
        const keepBytes = 'window.keep=true;';
        await prepareAsset({
            ...f,
            input: await put(f.outDir, 'keep.js', keepBytes),
            key: 'keep',
            url: `${base}keep.js`,
        });
        const first = await readManifest(f.outDir);
        const registry = JSON.parse(await readFile(path.join(f.storeDir, 'registry.json')));
        const handler = createRequestHandler({ root: f.outDir, base });
        const before = await request(handler, url);
        const expected = Buffer.from('window.version=2;');
        await put(f.root, `${publicDir}/assets/app.js`, expected);
        await put(f.root, `${publicDir}/keep.js`, keepBytes);
        await put(f.root, 'src/other.js', 'window.other=true;');
        await put(
            f.root,
            'index.html',
            '<script src="/demo/assets/app.js"></script>' +
                (withOtherBundle ? '<script type="module" src="/src/other.js"></script>' : '')
        );
        rebuilding = true;
        await run();
        assert.deepEqual(await readFile(path.join(f.outDir, 'assets/app.js')), expected);
        const requests = ['identity', 'dcb,dcz,br,gzip'].map((encoding) => ({
            'accept-encoding': encoding,
            'available-dictionary': digestHeader(first.assets[url].dictionaryHash),
            'if-none-match': before.headers.etag,
        }));
        for (const headers of requests) {
            const response = await request(handler, url, headers);
            assert.equal(response.status, 200);
            assert.deepEqual(response.body, expected);
            assert.equal(response.headers.link, undefined);
            assert.equal(response.headers['content-encoding'], undefined);
        }
        const manifest = await readManifest(f.outDir);
        assert.equal(manifest.assets[url], undefined);
        assert.equal(manifest.dictionaries[first.assets[url].dictionaryUrl], undefined);
        assert.deepEqual(manifest.assets[`${base}keep.js`], first.assets[`${base}keep.js`]);
        if (withOtherBundle) assert.ok(manifest.assets[`${base}assets/other.js`]);
        const currentRegistry = JSON.parse(await readFile(path.join(f.storeDir, 'registry.json')));
        for (const [key, group] of Object.entries(registry.groups))
            assert.deepEqual(currentRegistry.groups[key], group);
        const edge = await exportEdge(f, { base, releaseId: 'public-v2' });
        for (const headers of requests) {
            const edgeResponse = await edge(new Request(`https://app.example${url}`, { headers }));
            assert.equal(edgeResponse.status, 200);
            assert.deepEqual(Buffer.from(await edgeResponse.arrayBuffer()), expected);
            assert.equal(edgeResponse.headers.get('Link'), null);
            assert.equal(edgeResponse.headers.get('Content-Encoding'), null);
        }
    });

for (const strategy of ['exclude', 'resolveAsset'])
    test(`a retained Vite output serves current bytes after ${strategy} stops preparing an asset`, async (t) => {
        const f = await fixture(t);
        const app = await put(f.root, 'app.js', 'window.version=1;');
        const keep = await put(f.root, 'keep.js', 'window.keep=true;');
        const run = (skip = false) =>
            buildVite(f, {
                base: '/demo/',
                plugins: [
                    sharedDictionary({
                        storeDir: f.storeDir,
                        exclude: strategy === 'exclude' ? (name) => skip && name === 'app.js' : undefined,
                        resolveAsset:
                            strategy === 'resolveAsset'
                                ? ({ fileName }) => (skip && fileName === 'app.js' ? false : undefined)
                                : undefined,
                    }),
                ],
                build: {
                    emptyOutDir: false,
                    rolldownOptions: {
                        input: { app, keep },
                        output: { entryFileNames: '[name].js' },
                    },
                },
            });
        await run();
        const handler = createRequestHandler({ root: f.outDir, base: '/demo/' });
        const before = await request(handler, '/demo/app.js');
        const first = await readManifest(f.outDir);
        const registry = await readFile(path.join(f.storeDir, 'registry.json'));
        await put(f.root, 'app.js', 'window.version=2;');
        await run(true);
        const response = await request(handler, '/demo/app.js', {
            'if-none-match': before.headers.etag,
        });
        assert.equal(response.status, 200);
        assert.deepEqual(response.body, await readFile(path.join(f.outDir, 'app.js')));
        assert.equal(response.headers.link, undefined);
        const manifest = await readManifest(f.outDir);
        assert.deepEqual(Object.keys(manifest.assets), ['/demo/keep.js']);
        assert.equal(manifest.dictionaries[first.assets['/demo/app.js'].dictionaryUrl], undefined);
        assert.ok(manifest.dictionaries[first.assets['/demo/keep.js'].dictionaryUrl]);
        assert.deepEqual(await readFile(path.join(f.storeDir, 'registry.json')), registry);
    });

for (const previouslyPrepared of [false, true])
    test(`Vite serves an empty chunk without dictionary preparation (previously prepared: ${previouslyPrepared})`, async (t) => {
        const f = await fixture(t);
        const input = await put(f.root, 'app.js', previouslyPrepared ? 'window.version=1;' : 'export {};');
        const run = () =>
            buildVite(f, {
                build: {
                    emptyOutDir: false,
                    rolldownOptions: { input, output: { entryFileNames: 'app.js' } },
                },
            });
        let registry;
        if (previouslyPrepared) {
            await run();
            registry = await readFile(path.join(f.storeDir, 'registry.json'));
            await put(f.root, 'app.js', 'export {};');
        }
        await run();
        const manifest = await readManifest(f.outDir);
        assert.deepEqual(manifest.assets, {});
        assert.deepEqual(manifest.dictionaries, {});
        const response = await request(createRequestHandler({ root: f.outDir }), '/app.js');
        assert.equal(response.status, 200);
        assert.equal(response.headers['content-type'], 'text/javascript; charset=utf-8');
        assert.equal(response.headers['content-length'], 0);
        assert.equal(response.headers.link, undefined);
        assert.equal(response.body.length, 0);
        if (previouslyPrepared) assert.deepEqual(await readFile(path.join(f.storeDir, 'registry.json')), registry);
    });

for (const [dictionaryPolicy, historyLimit, retained] of [
    ['stable', 1, true],
    ['rolling', 3, true],
    ['rolling', 2, false],
])
    test(`a client holding only the v1 dictionary can receive v3 (${dictionaryPolicy}, history ${historyLimit})`, async (t) => {
        const f = await fixture(t);
        const options = {
            ...f,
            key: 'app',
            match: '/app-*.js',
            dictionaryPolicy,
            historyLimit,
        };
        const first = await prepareAsset({
            ...options,
            input: await put(f.outDir, 'app-v1.js', source(1)),
            url: '/app-v1.js',
        });
        const handler = createRequestHandler({ root: f.outDir });
        const downloaded = await request(handler, dictionaryPolicy === 'stable' ? first.dictionaryUrl : first.url);
        assert.equal(downloaded.status, 200);
        const cachedDictionary = await put(f.root, 'client-v1.dict', downloaded.body);
        for (const version of [2, 3]) {
            await rm(f.outDir, { recursive: true });
            await mkdir(f.outDir);
            await prepareAsset({
                ...options,
                input: await put(f.outDir, `app-v${version}.js`, source(version)),
                url: `/app-v${version}.js`,
            });
        }
        // The client has made no v2 requests and still advertises only its cached v1 base.
        for (const [encoding, decode] of [
            ['dcb', decompressDcb],
            ['dcz', decompressDcz],
        ]) {
            const response = await request(handler, '/app-v3.js', {
                'accept-encoding': `${encoding},br`,
                'available-dictionary': digestHeader(first.dictionaryHash),
            });
            assert.equal(response.status, 200);
            assert.equal(response.headers['content-encoding'], retained ? encoding : 'br');
            const decoded = retained
                ? await decode(response.body, cachedDictionary)
                : brotliDecompressSync(response.body);
            assert.deepEqual(decoded, source(3));
        }
    });

test('Node negotiates parameterized dictionary digests and rejects malformed extensions', async (t) => {
    const f = await fixture(t);
    const input = await put(f.outDir, 'app.js', source());
    const first = await prepareAsset({ ...f, input, key: 'app', url: '/app.js' });
    await put(f.outDir, 'app.js', source(2));
    await prepareAsset({ ...f, input, key: 'app', url: '/app.js' });
    const handler = createRequestHandler({ root: f.outDir });
    const digest = digestHeader(first.dictionaryHash);
    for (const [encoding, decode] of [
        ['dcb', decompressDcb],
        ['dcz', decompressDcz],
    ]) {
        for (const suffix of [';foo=bar', ';flag', ';note="one;two,three";enabled=?1']) {
            const response = await request(handler, '/app.js', {
                'accept-encoding': `${encoding},identity;q=0`,
                'available-dictionary': digest + suffix,
            });
            assert.equal(response.status, 200);
            assert.equal(response.headers['content-encoding'], encoding);
            assert.deepEqual(
                await decode(response.body, path.join(f.storeDir, 'dictionaries', `${first.dictionaryHash}.dict`)),
                source(2)
            );
        }
    }
    for (const suffix of [';flag=?2', ';note="unterminated', `;flag,${digest}`]) {
        const response = await request(handler, '/app.js', {
            'accept-encoding': 'br,dcb,dcz',
            'available-dictionary': digest + suffix,
        });
        assert.equal(response.status, 200);
        assert.equal(response.headers['content-encoding'], 'br');
        assert.deepEqual(brotliDecompressSync(response.body), source(2));
    }
});
