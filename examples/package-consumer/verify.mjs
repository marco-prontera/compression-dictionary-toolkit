import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import path from 'node:path';
import { brotliDecompressSync } from 'node:zlib';
import { decompressDcb, decompressDcz, digestHeader, exportRelease } from 'compression-dictionary-toolkit';
import { createEdgeHandler } from 'compression-dictionary-toolkit/edge';
import { buildReleases } from './build.mjs';
import { startServer } from './server.mjs';
import { metadata, packageRoot, results, report, store, releaseDirectory } from './project.mjs';

const manifests = await buildReleases();
for (const manifest of Object.values(manifests)) assert.equal(Object.keys(manifest.assets).length, 2);
const app = await startServer();
const samples = [];
function request(url, headers = {}, method = 'GET') {
    return new Promise((resolve, reject) => {
        const req = http.request(
            { hostname: '127.0.0.1', port: app.server.address().port, path: url, headers, method },
            (response) => {
                const chunks = [];
                response.on('data', (chunk) => chunks.push(chunk));
                response.on('end', () =>
                    resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) })
                );
            }
        );
        req.on('error', reject);
        req.end();
    });
}
try {
    for (const asset of Object.values(manifests.v1.assets)) {
        const first = await request(asset.url, { 'accept-encoding': 'br, dcb, dcz' });
        assert.equal(first.status, 200);
        assert.equal(first.headers['content-encoding'], 'br');
        assert.ok(first.headers['use-as-dictionary'].includes(asset.hash));
        assert.equal(first.headers.link, undefined);
        assert.deepEqual(
            brotliDecompressSync(first.body),
            await readFile(path.join(releaseDirectory('v1'), asset.file))
        );
    }
    app.setVersion('v3');
    for (const asset of Object.values(manifests.v3.assets)) {
        const base = Object.values(manifests.v1.assets).find((item) => item.key === asset.key);
        assert.ok(base);
        const dictionary = path.join(store, 'dictionaries', base.hash + '.dict');
        const expected = await readFile(path.join(releaseDirectory('v3'), asset.file));
        const ordinary = await request(asset.url, { 'accept-encoding': 'br' });
        for (const [encoding, decode] of [
            ['dcb', decompressDcb],
            ['dcz', decompressDcz],
        ]) {
            const headers = { 'accept-encoding': encoding, 'available-dictionary': digestHeader(base.hash) };
            const response = await request(asset.url, headers);
            assert.equal(response.status, 200);
            assert.equal(response.headers['content-encoding'], encoding);
            assert.ok(response.headers['use-as-dictionary'].includes(asset.hash));
            assert.deepEqual(await decode(response.body, dictionary), expected);
            assert.ok(response.body.length < ordinary.body.length);
            const head = await request(asset.url, headers, 'HEAD');
            assert.equal(head.body.length, 0);
            assert.equal(Number(head.headers['content-length']), response.body.length);
            const cached = await request(asset.url, { ...headers, 'if-none-match': response.headers.etag });
            assert.equal(cached.status, 304);
            samples.push({
                asset: path.extname(asset.url),
                encoding,
                sharedBytes: response.body.length,
                ordinaryBytes: ordinary.body.length,
            });
        }
    }
    const targetDir = path.join(results, 'edge');
    await exportRelease({ outDir: releaseDirectory('v3'), targetDir, releaseId: 'consumer-' + metadata.version });
    const edgeManifest = JSON.parse(await readFile(path.join(targetDir, 'edge-manifest.json'), 'utf8'));
    const edge = createEdgeHandler({
        manifest: edgeManifest,
        loadObject: (file) => readFile(path.join(targetDir, file)),
    });
    for (const asset of Object.values(manifests.v3.assets)) {
        const base = Object.values(manifests.v1.assets).find((item) => item.key === asset.key);
        for (const [encoding, decode] of [
            ['dcb', decompressDcb],
            ['dcz', decompressDcz],
        ]) {
            const response = await edge(
                new Request('https://consumer.example' + asset.url, {
                    headers: { 'accept-encoding': encoding, 'available-dictionary': digestHeader(base.hash) },
                })
            );
            assert.equal(response.status, 200);
            assert.equal(response.headers.get('content-encoding'), encoding);
            assert.deepEqual(
                await decode(
                    new Uint8Array(await response.arrayBuffer()),
                    path.join(store, 'dictionaries', base.hash + '.dict')
                ),
                await readFile(path.join(releaseDirectory('v3'), asset.file))
            );
        }
    }
    app.setVersion('v4');
    for (const asset of Object.values(manifests.v4.assets)) {
        const base = Object.values(manifests.v1.assets).find((item) => item.key === asset.key);
        const response = await request(asset.url, {
            'accept-encoding': 'br, dcb, dcz',
            'available-dictionary': digestHeader(base.hash),
        });
        assert.equal(response.headers['content-encoding'], 'br');
        assert.deepEqual(
            brotliDecompressSync(response.body),
            await readFile(path.join(releaseDirectory('v4'), asset.file))
        );
    }
    const exec = promisify(execFile);
    const cli = path.join(packageRoot, metadata.bin['shared-dict']);
    assert.match((await exec(process.execPath, [cli, '--help'])).stdout, /shared-dict export/);
    const exported = JSON.parse(
        (
            await exec(process.execPath, [
                cli,
                'export',
                '--out-dir',
                releaseDirectory('v3'),
                '--target-dir',
                path.join(results, 'cli-export'),
                '--release-id',
                'cli-check',
            ])
        ).stdout
    );
    assert.equal(exported.releaseId, 'cli-check');
    await report('protocol', {
        passed: true,
        scenarios: [
            'cold JS/CSS',
            'v1 to v3 with dcb/dcz on Node and edge',
            'HEAD and 304',
            'v1 to v4 fallback',
            'CLI export',
        ],
        samples,
    });
    console.table(samples);
    console.log(metadata.name + '@' + metadata.version + ': installed package checks passed');
} finally {
    await app.close();
}
