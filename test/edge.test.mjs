import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import { brotliDecompressSync } from 'node:zlib';
import {
    prepareAsset,
    exportRelease,
    digestHeader,
    decompressDcb,
    decompressDcz,
} from 'compression-dictionary-toolkit';
import { createEdgeHandler, loadCloudflareObject } from 'compression-dictionary-toolkit/edge';
import { fixture, source, stylesheet, put } from './helpers.mjs';

async function setup(t, extension = 'js') {
    const f = await fixture(t);
    const content = extension === 'css' ? stylesheet : source;
    const url = `https://app.example/app.${extension}`;
    const input = await put(f.outDir, `app.${extension}`, content());
    const first = await prepareAsset({ ...f, input, key: 'app', url: `/app.${extension}` });
    await put(f.outDir, `app.${extension}`, content(2));
    await prepareAsset({ ...f, input, key: 'app', url: `/app.${extension}` });
    await put(f.outDir, 'index.html', '<h1>Release 2</h1>');
    const targetDir = path.join(f.root, 'release');
    await exportRelease({ outDir: f.outDir, targetDir, releaseId: 'release-2' });
    const manifest = JSON.parse(await readFile(path.join(targetDir, 'edge-manifest.json')));
    let loads = 0;
    const handler = createEdgeHandler({
        manifest,
        loadObject: async (key) => {
            loads++;
            return readFile(path.join(targetDir, key));
        },
    });
    const headers = { 'Accept-Encoding': 'br,dcb,dcz', 'Available-Dictionary': digestHeader(first.dictionaryHash) };
    return { ...f, targetDir, manifest, handler, first, headers, url, content, loads: () => loads };
}

for (const extension of ['js', 'css'])
    test(`edge serves a shared base, both encodings and fallback; HEAD and 304 avoid object reads (${extension})`, async (t) => {
        const f = await setup(t, extension);
        const contentType = extension === 'css' ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8';
        const firstVisit = await f.handler(new Request(f.url, { headers: { 'Accept-Encoding': 'br,dcb,dcz' } }));
        assert.equal(firstVisit.headers.get('Content-Encoding'), 'br');
        assert.equal(firstVisit.headers.get('Content-Type'), contentType);
        assert.deepEqual(brotliDecompressSync(Buffer.from(await firstVisit.arrayBuffer())), f.content(2));
        for (const [encoding, decode] of [
            ['dcb', decompressDcb],
            ['dcz', decompressDcz],
        ]) {
            const response = await f.handler(
                new Request(f.url, { headers: { ...f.headers, 'Accept-Encoding': `${encoding},br` } })
            );
            assert.equal(response.status, 200);
            assert.equal(response.headers.get('Content-Type'), contentType);
            assert.equal(response.headers.get('Content-Encoding'), encoding);
            assert.match(response.headers.get('Vary'), /Available-Dictionary/);
            assert.equal(response.headers.get('Cloudflare-CDN-Cache-Control'), 'no-store');
            const bytes = Buffer.from(await response.arrayBuffer());
            assert.deepEqual(
                await decode(bytes, path.join(f.storeDir, `dictionaries/${f.first.dictionaryHash}.dict`)),
                f.content(2)
            );
            const count = f.loads();
            const head = await f.handler(
                new Request(f.url, { method: 'HEAD', headers: { ...f.headers, 'Accept-Encoding': encoding } })
            );
            assert.equal(head.headers.get('Content-Length'), String(bytes.length));
            const cached = await f.handler(
                new Request(f.url, {
                    headers: {
                        ...f.headers,
                        'Accept-Encoding': encoding,
                        'If-None-Match': response.headers.get('ETag'),
                    },
                })
            );
            assert.equal(cached.status, 304);
            assert.equal(f.loads(), count);
        }
        const dictionary = await f.handler(new Request(`https://app.example${f.first.dictionaryUrl}`));
        assert.ok(dictionary.headers.get('Use-As-Dictionary').includes(`match="/app.${extension}"`));
        assert.deepEqual(Buffer.from(await dictionary.arrayBuffer()), f.content());
        assert.equal(await (await f.handler(new Request('https://app.example/'))).text(), '<h1>Release 2</h1>');
        const plan = JSON.parse(await readFile(path.join(f.targetDir, 'upload-plan.json')));
        assert.equal(plan.objectMetadata.contentEncoding, undefined);
        assert.ok(plan.objects.every((x) => x.file === `objects/${x.hash}.bin`));
    });

test('edge respects original Cloudflare encoding, unknown hashes, origin, and q=0', async (t) => {
    const f = await setup(t);
    const req = new Request('https://app.example/app.js', { headers: f.headers });
    Object.defineProperty(req, 'cf', { value: { clientAcceptEncoding: 'br' } });
    assert.equal((await f.handler(req)).headers.get('Content-Encoding'), 'br');
    for (const headers of [
        { 'Accept-Encoding': 'br,dcb,dcz' },
        { ...f.headers, 'Available-Dictionary': digestHeader('a'.repeat(64)) },
        { ...f.headers, 'Sec-Fetch-Site': 'cross-site' },
        { ...f.headers, 'Accept-Encoding': 'br,dcb;q=0,dcz;q=0' },
    ])
        assert.equal(
            (await f.handler(new Request('https://app.example/app.js', { headers }))).headers.get('Content-Encoding'),
            'br'
        );
    assert.equal(
        (await f.handler(new Request('http://app.example/app.js', { headers: f.headers }))).headers.get(
            'Content-Encoding'
        ),
        'br'
    );
    assert.equal(
        (await f.handler(new Request('https://app.example/app.js', { headers: { 'Accept-Encoding': '*;q=0' } })))
            .status,
        406
    );
    assert.equal((await f.handler(new Request('https://app.example/app.js', { method: 'POST' }))).status, 405);
    assert.equal((await f.handler(new Request('https://app.example/.cdt/manifest.json'))).status, 403);
    assert.equal((await f.handler(new Request('https://app.example/missing'))).status, 404);
});

test('edge negotiates and decodes dcb and dcz with an unpadded dictionary digest', async (t) => {
    const f = await setup(t);
    const available = digestHeader(f.first.dictionaryHash).replace('=:', ':');
    for (const [encoding, decode] of [
        ['dcb', decompressDcb],
        ['dcz', decompressDcz],
    ]) {
        const response = await f.handler(
            new Request(f.url, {
                headers: { 'Accept-Encoding': `${encoding},br`, 'Available-Dictionary': available },
            })
        );
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('Content-Encoding'), encoding);
        assert.deepEqual(
            await decode(
                Buffer.from(await response.arrayBuffer()),
                path.join(f.storeDir, `dictionaries/${f.first.dictionaryHash}.dict`)
            ),
            f.content(2)
        );
    }
    for (const headers of [
        { 'Accept-Encoding': 'br,dcb,dcz', 'Available-Dictionary': digestHeader('a'.repeat(64)).replace('=:', ':') },
        { 'Accept-Encoding': 'br,dcb;q=0,dcz;q=0', 'Available-Dictionary': available },
        { 'Accept-Encoding': 'br,dcb,dcz', 'Available-Dictionary': 'invalid' },
    ])
        assert.equal((await f.handler(new Request(f.url, { headers }))).headers.get('Content-Encoding'), 'br');
});

test('edge negotiates parameterized dictionary digests and rejects malformed extensions', async (t) => {
    const f = await setup(t);
    const digest = digestHeader(f.first.dictionaryHash);
    for (const [encoding, decode] of [
        ['dcb', decompressDcb],
        ['dcz', decompressDcz],
    ]) {
        for (const suffix of [';foo=bar', ';flag', ';note="one;two,three";enabled=?1']) {
            const response = await f.handler(
                new Request(f.url, {
                    headers: { 'Accept-Encoding': `${encoding},identity;q=0`, 'Available-Dictionary': digest + suffix },
                })
            );
            assert.equal(response.status, 200);
            assert.equal(response.headers.get('Content-Encoding'), encoding);
            assert.deepEqual(
                await decode(
                    Buffer.from(await response.arrayBuffer()),
                    path.join(f.storeDir, 'dictionaries', `${f.first.dictionaryHash}.dict`)
                ),
                f.content(2)
            );
        }
    }
    for (const suffix of [';flag=?2', ';note="unterminated', `;flag,${digest}`]) {
        const response = await f.handler(
            new Request(f.url, {
                headers: { 'Accept-Encoding': 'br,dcb,dcz', 'Available-Dictionary': digest + suffix },
            })
        );
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('Content-Encoding'), 'br');
        assert.deepEqual(brotliDecompressSync(Buffer.from(await response.arrayBuffer())), f.content(2));
    }
});

test('release and edge reject corrupt objects and symlinks without mislabeled response bodies', async (t) => {
    const f = await setup(t);
    const handler = createEdgeHandler({ manifest: f.manifest, loadObject: async () => Buffer.from('broken') });
    const response = await handler(new Request('https://app.example/app.js', { headers: f.headers }));
    assert.equal(response.status, 502);
    assert.equal(response.headers.get('Content-Encoding'), null);
    const secret = await put(f.root, 'secret', 'private');
    await symlink(secret, path.join(f.outDir, 'leak'));
    await assert.rejects(
        () => exportRelease({ outDir: f.outDir, targetDir: f.targetDir, releaseId: 'bad' }),
        /Symlink/
    );
    await assert.rejects(
        () => exportRelease({ outDir: f.outDir, targetDir: path.join(f.outDir, 'release'), releaseId: 'bad' }),
        /separate/
    );
    const originalManifest = JSON.parse(await readFile(path.join(f.outDir, '.cdt/manifest.json')));
    await writeFile(path.join(f.outDir, originalManifest.assets['/app.js'].representations.br.file), 'broken');
    await assert.rejects(
        () => exportRelease({ outDir: f.outDir, targetDir: f.targetDir, releaseId: 'bad' }),
        /integrity/
    );
});

test(
    'invalid public filenames cannot replace an exported release',
    { skip: process.platform === 'win32' },
    async (t) => {
        const f = await setup(t);
        const before = await readFile(path.join(f.targetDir, 'edge-manifest.json'));
        for (const file of ['broken\nname.svg', 'broken\\name.svg', 'broken\u007fname.svg']) {
            const invalid = await put(f.outDir, file, 'invalid public path');
            await assert.rejects(
                () => exportRelease({ outDir: f.outDir, targetDir: f.targetDir, releaseId: 'invalid' }),
                /Invalid public file path/
            );
            assert.deepEqual(await readFile(path.join(f.targetDir, 'edge-manifest.json')), before);
            await rm(invalid);
        }
    }
);

test('R2 and CloudFront loaders read opaque bytes without forwarding browser negotiation', async (t) => {
    const key = `objects/${'a'.repeat(64)}.bin`;
    const expected = new Uint8Array([1, 2, 3]);
    assert.deepEqual(
        await loadCloudflareObject(key, {
            BUCKET: {
                get: async (found) => {
                    assert.equal(found, key);
                    return { arrayBuffer: async () => expected.buffer };
                },
            },
        }),
        expected.buffer
    );
    await assert.rejects(
        () =>
            loadCloudflareObject(key, { BUCKET: { get: async () => ({ httpMetadata: { contentEncoding: 'dcb' } }) } }),
        /Content-Encoding/
    );
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        assert.equal(String(url), `https://blobs.example/shared-dict/${key}`);
        assert.deepEqual(options.headers, { 'Accept-Encoding': 'identity' });
        assert.equal(options.redirect, 'error');
        return new Response(expected);
    });
    assert.deepEqual(
        await loadCloudflareObject(key, { BLOB_ORIGIN: 'https://blobs.example/shared-dict/' }),
        expected.buffer
    );
    await assert.rejects(() => loadCloudflareObject('../bad', {}), /key/);
    await assert.rejects(() => loadCloudflareObject(key, { BLOB_ORIGIN: 'http://blobs.example' }), /HTTPS/);
});
