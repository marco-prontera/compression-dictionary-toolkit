import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import { brotliDecompressSync } from 'node:zlib';
import { prepareAsset, digestHeader, decompressDcz, decompressDcb } from 'compression-dictionary-toolkit';
import { createDictionaryServer, selectRepresentation } from 'compression-dictionary-toolkit/server';
import { demoDictionaryEncodings } from '../playground/encoding-policy.mjs';
import { fixture, source, stylesheet, put, listen, request } from './helpers.mjs';

async function setup(t, allowInsecureLocalhost = true, extension = 'js') {
    const f = await fixture(t);
    const content = extension === 'css' ? stylesheet : source;
    const url = `/app.${extension}`;
    const input = await put(f.outDir, `app.${extension}`, content());
    const old = await prepareAsset({ ...f, input, key: 'app', url });
    await put(f.outDir, `app.${extension}`, content(2));
    const asset = await prepareAsset({ ...f, input, key: 'app', url });
    const port = await listen(
        t,
        createDictionaryServer({
            root: f.outDir,
            allowInsecureLocalhost,
            dictionaryEncodings: demoDictionaryEncodings,
        })
    );
    const headers = {
        'accept-encoding': 'gzip, br, dcz',
        'available-dictionary': digestHeader(old.hash),
    };
    return { ...f, old, asset, port, headers, url, content };
}

for (const extension of ['js', 'css'])
    test(`negotiates dcz with the previous hash and correct headers and bytes (${extension})`, async (t) => {
        const f = await setup(t, true, extension);
        const response = await request(f.port, `${f.url}?version=2`, f.headers);
        assert.equal(response.status, 200);
        assert.equal(
            response.headers['content-type'],
            extension === 'css' ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8'
        );
        assert.equal(response.headers['content-encoding'], 'dcz');
        assert.match(response.headers.vary, /Accept-Encoding, Available-Dictionary/);
        assert.equal(response.headers.link, undefined);
        assert.ok(response.headers['use-as-dictionary'].includes(`id="app-${f.asset.hash}"`));
        assert.equal(Number(response.headers['content-length']), response.body.length);
        assert.deepEqual(
            await decompressDcz(response.body, path.join(f.storeDir, `dictionaries/${f.old.hash}.dict`)),
            f.content(2)
        );
        const dictionary = await request(f.port, f.old.dictionaryUrl);
        assert.ok(dictionary.headers['use-as-dictionary'].includes(`match="${f.url}"`));
        assert.deepEqual(dictionary.body, f.content());
    });

for (const extension of ['js', 'css'])
    test(`negotiates dcb with the previous base and falls back without a usable dictionary (${extension})`, async (t) => {
        const f = await setup(t, true, extension);
        const response = await request(f.port, f.url, {
            ...f.headers,
            'accept-encoding': 'br,gzip,dcb',
        });
        assert.equal(response.headers['content-encoding'], 'dcb');
        assert.equal(
            response.headers['content-type'],
            extension === 'css' ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8'
        );
        assert.match(response.headers.vary, /Available-Dictionary/);
        assert.deepEqual(
            await decompressDcb(response.body, path.join(f.storeDir, `dictionaries/${f.old.hash}.dict`)),
            f.content(2)
        );
        const firstVisit = await request(f.port, f.url, {
            'accept-encoding': 'br,dcb,dcz',
        });
        assert.equal(firstVisit.headers['content-encoding'], 'br');
        assert.equal(firstVisit.headers['content-type'], response.headers['content-type']);
        assert.deepEqual(brotliDecompressSync(firstVisit.body), f.content(2));
        for (const headers of [
            { 'accept-encoding': 'br,dcb' },
            {
                ...f.headers,
                'accept-encoding': 'br,dcb',
                'available-dictionary': digestHeader('ab'.repeat(32)),
            },
            {
                ...f.headers,
                'accept-encoding': 'br,dcb',
                'available-dictionary': 'invalid',
            },
            { ...f.headers, 'accept-encoding': 'br,dcb;q=0' },
            { ...f.headers, 'accept-encoding': '*' },
            {
                ...f.headers,
                'accept-encoding': 'br,dcb',
                'sec-fetch-site': 'cross-site',
                'sec-fetch-mode': 'no-cors',
            },
        ]) {
            const fallback = await request(f.port, `${f.url}?encoding=dcb`, headers);
            assert.equal(fallback.status, 200);
            assert.notEqual(fallback.headers['content-encoding'], 'dcb');
        }
    });

test('both encodings prioritize quality then size; demo restrictions respect the client', async (t) => {
    const f = await setup(t);
    const headers = { ...f.headers, 'accept-encoding': 'br,gzip,dcb,dcz' };
    const smallest = f.asset.dcb[f.old.hash].bytes < f.asset.dcz[f.old.hash].bytes ? 'dcb' : 'dcz';
    assert.equal((await request(f.port, '/app.js', headers)).headers['content-encoding'], smallest);
    for (const encoding of ['dcb', 'dcz']) {
        const other = encoding === 'dcb' ? 'dcz' : 'dcb';
        const chosen = await request(f.port, '/app.js', {
            ...headers,
            'accept-encoding': `${encoding};q=1,${other};q=0.5,br;q=0.1,identity;q=0`,
        });
        assert.equal(chosen.headers['content-encoding'], encoding);
        const forced = await request(f.port, `/app.js?encoding=${encoding}`, headers);
        assert.equal(forced.headers['content-encoding'], encoding);
        assert.deepEqual(forced.body, await readFile(path.join(f.outDir, f.asset[encoding][f.old.hash].file)));
        const unsupported = await request(f.port, `/app.js?encoding=${encoding}`, {
            ...headers,
            'accept-encoding': `${other},br`,
        });
        assert.equal(unsupported.headers['content-encoding'], 'br');
        const refused = await request(f.port, `/app.js?encoding=${encoding}`, {
            ...headers,
            'accept-encoding': `${other},${encoding};q=0,br;q=0,gzip;q=0,identity;q=0`,
        });
        assert.equal(refused.status, 406);
    }
    const legacy = { ...f.asset };
    delete legacy.dcb;
    assert.equal(selectRepresentation(legacy, headers, true).encoding, 'dcz');
});

test('dcb and dcz have separate ETags and HEAD returns correct metadata', async (t) => {
    const f = await setup(t);
    const headers = { ...f.headers, 'accept-encoding': 'dcb,dcz,br' };
    const dcb = await request(f.port, '/app.js?encoding=dcb', headers);
    const dcz = await request(f.port, '/app.js?encoding=dcz', headers);
    assert.notEqual(dcb.headers.etag, dcz.headers.etag);
    const head = await request(f.port, '/app.js?encoding=dcb', headers, 'HEAD');
    assert.equal(head.headers['content-encoding'], 'dcb');
    assert.equal(head.headers['content-length'], dcb.headers['content-length']);
    assert.equal(head.body.length, 0);
    assert.equal(
        (
            await request(f.port, '/app.js?encoding=dcb', {
                ...headers,
                'if-none-match': dcb.headers.etag,
            })
        ).status,
        304
    );
    assert.equal(
        (
            await request(f.port, '/app.js?encoding=dcz', {
                ...headers,
                'if-none-match': dcb.headers.etag,
            })
        ).status,
        200
    );
});

test('falls back for unknown, invalid, or missing hashes and rejected dcz', async (t) => {
    const f = await setup(t);
    for (const headers of [
        { 'accept-encoding': 'br,gzip,dcz' },
        { ...f.headers, 'available-dictionary': digestHeader('ab'.repeat(32)) },
        { ...f.headers, 'available-dictionary': 'invalid' },
        {
            ...f.headers,
            'available-dictionary': `${digestHeader(f.old.hash)},${digestHeader(f.asset.hash)}`,
        },
        { ...f.headers, 'accept-encoding': 'br,dcz;q=0' },
        { ...f.headers, 'accept-encoding': 'br;q=1,dcz;q=0.2' },
        { ...f.headers, 'accept-encoding': '*' },
        {
            ...f.headers,
            'sec-fetch-site': 'cross-site',
            'sec-fetch-mode': 'no-cors',
        },
    ]) {
        const response = await request(f.port, '/app.js', headers);
        assert.equal(response.status, 200);
        assert.notEqual(response.headers['content-encoding'], 'dcz');
    }
    const identity = await request(f.port, '/app.js');
    assert.equal(identity.headers['content-encoding'], undefined);
    assert.deepEqual(identity.body, source(2));
    assert.equal(
        (
            await request(f.port, '/app.js', {
                'accept-encoding': 'identity;q=0,br;q=0,gzip;q=0,*;q=0',
            })
        ).status,
        406
    );
});

test('serves the correct immutable dictionary with Use-As-Dictionary', async (t) => {
    const f = await setup(t);
    const response = await request(f.port, f.old.dictionaryUrl);
    assert.equal(response.status, 200);
    assert.match(response.headers['use-as-dictionary'], /match="\/app.js"/);
    assert.match(response.headers['cache-control'], /immutable/);
    assert.deepEqual(response.body, source());
    assert.equal(response.headers['content-encoding'], undefined);
});

test('HEAD and validators track each representation including dictionary changes', async (t) => {
    const f = await setup(t);
    const get = await request(f.port, '/app.js', f.headers);
    const head = await request(f.port, '/app.js', f.headers, 'HEAD');
    assert.equal(head.body.length, 0);
    assert.equal(head.headers['content-length'], get.headers['content-length']);
    assert.equal(head.headers.etag, get.headers.etag);
    const cached = await request(f.port, '/app.js', {
        ...f.headers,
        'if-none-match': `W/${get.headers.etag}`,
    });
    assert.equal(cached.status, 304);
    assert.equal(cached.body.length, 0);
    const other = await request(f.port, '/app.js', {
        'accept-encoding': 'br',
        'if-none-match': get.headers.etag,
    });
    assert.equal(other.status, 200);
    assert.notEqual(other.headers.etag, get.headers.etag);
});

test('insecure HTTP does not enable dictionaries without loopback opt-in', async (t) => {
    const f = await setup(t, false);
    assert.notEqual((await request(f.port, '/app.js', f.headers)).headers['content-encoding'], 'dcz');
    assert.equal((await request(f.port, f.old.dictionaryUrl)).status, 403);
});

test('protects paths, methods, and internal files', async (t) => {
    const f = await setup(t);
    for (const url of [
        '/../store/registry.json',
        '/%2e%2e/store/registry.json',
        '/.cdt/manifest.json',
        '/%2eCDT',
        '/%5c..%5csecret',
    ]) {
        assert.equal((await request(f.port, url)).status, 403);
    }
    assert.equal((await request(f.port, '/bad%')).status, 400);
    assert.equal((await request(f.port, '/app.js', {}, 'POST')).status, 405);
    assert.equal((await request(f.port, '/missing.js')).status, 404);
    const outside = await put(f.root, 'secret.js', 'secret');
    await symlink(outside, path.join(f.outDir, 'leak.js'));
    assert.equal((await request(f.port, '/leak.js')).status, 403);
    const foreignHost = await request(f.port, '/app.js', {
        ...f.headers,
        Host: 'not-local.example',
    });
    assert.notEqual(foreignHost.headers['content-encoding'], 'dcz');
});
