import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { connect } from 'node:http2';
import { createDictionaryServer } from 'compression-dictionary-toolkit/server';
import { prepareAsset, digestHeader, decompressDcz, decompressDcb } from 'compression-dictionary-toolkit';
import { fixture, put, source } from './helpers.mjs';

test('HTTPS HTTP/2 negotiates and transfers dcz and dcb over TLS', async (t) => {
    const f = await fixture(t);
    const keyPath = path.join(f.root, 'key.pem');
    const certPath = path.join(f.root, 'cert.pem');
    try {
        await promisify(execFile)('openssl', [
            'req',
            '-x509',
            '-newkey',
            'rsa:2048',
            '-nodes',
            '-keyout',
            keyPath,
            '-out',
            certPath,
            '-subj',
            '/CN=localhost',
            '-days',
            '1',
        ]);
    } catch (error) {
        if (error.code === 'ENOENT') {
            t.skip('OpenSSL is not installed: skipping only the TLS smoke test');
            return;
        }
        throw error;
    }
    const input = await put(f.outDir, 'app.js', source());
    const asset = await prepareAsset({ ...f, input, key: 'app', url: '/app.js' });
    const server = createDictionaryServer({
        root: f.outDir,
        tls: { key: await readFile(keyPath), cert: await readFile(certPath) },
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const client = connect(`https://localhost:${server.address().port}`, { rejectUnauthorized: false });
    t.after(async () => {
        client.destroy();
        await new Promise((resolve) => server.close(resolve));
    });
    for (const [encoding, decompress] of [
        ['dcz', decompressDcz],
        ['dcb', decompressDcb],
    ]) {
        const result = await new Promise((resolve, reject) => {
            const req = client.request({
                ':path': '/app.js',
                'accept-encoding': `br,${encoding}`,
                'available-dictionary': digestHeader(asset.hash),
            });
            let headers;
            const chunks = [];
            req.on('response', (value) => {
                headers = value;
            });
            req.on('data', (chunk) => chunks.push(chunk));
            req.on('error', reject);
            req.on('end', () => resolve({ headers, body: Buffer.concat(chunks) }));
            req.end();
        });
        assert.equal(result.headers[':status'], 200);
        assert.equal(result.headers['content-encoding'], encoding);
        assert.deepEqual(
            await decompress(result.body, path.join(f.storeDir, `dictionaries/${asset.hash}.dict`)),
            source()
        );
    }
});
