import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import assert from 'node:assert/strict';
import { digestHeader } from 'compression-dictionary-toolkit';

const { values } = parseArgs({
    options: { origin: { type: 'string' }, manifest: { type: 'string', default: 'release/edge-manifest.json' } },
});
if (!values.origin)
    throw new Error(
        'Usage: npm run check:deployment -- --origin=https://app.example --manifest=release/edge-manifest.json'
    );
const origin = new URL(values.origin);
if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash)
    throw new Error('origin must contain only a scheme, host, and port');
if (
    origin.protocol !== 'https:' &&
    !(origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))
)
    throw new Error('HTTPS is required outside localhost');
const manifest = JSON.parse(await readFile(values.manifest, 'utf8'));
assert.equal(manifest.schemaVersion, 1);
const sha256 = (body) => createHash('sha256').update(body).digest('hex');
function request(url, headers) {
    return new Promise((resolve, reject) => {
        const client = origin.protocol === 'https:' ? https : http;
        const req = client.get(new URL(url, origin), { headers, timeout: 20000 }, (res) => {
            const chunks = [];
            let size = 0;
            res.on('data', (chunk) => {
                size += chunk.length;
                if (size > 32 * 1024 * 1024) res.destroy(new Error('Response exceeds 32 MiB'));
                else chunks.push(chunk);
            });
            res.on('error', reject);
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('Timeout')));
    });
}
const rows = [];
for (const asset of Object.values(manifest.assets)) {
    const dictionary = manifest.dictionaries[asset.dictionaryUrl];
    const acquisitionUrl = asset.dictionaryDelivery === 'asset' ? asset.url : asset.dictionaryUrl;
    const download = await request(acquisitionUrl, { 'Accept-Encoding': 'identity' });
    assert.equal(download.status, 200, acquisitionUrl);
    assert.equal(sha256(download.body), dictionary.hash, 'Dictionary bytes were altered');
    assert.ok(
        download.headers['use-as-dictionary']?.includes(`match="${dictionary.match}"`),
        'Use-As-Dictionary is missing or incorrect'
    );
    const cases = [
        { mode: 'without-base', headers: { 'Accept-Encoding': 'br,gzip' } },
        ...['dcb', 'dcz'].map((encoding) => ({
            mode: encoding,
            headers: {
                'Accept-Encoding': `${encoding},identity;q=0`,
                'Available-Dictionary': digestHeader(dictionary.hash),
            },
        })),
        {
            mode: 'unknown-hash',
            headers: { 'Accept-Encoding': 'br,gzip,dcb,dcz', 'Available-Dictionary': digestHeader('0'.repeat(64)) },
        },
        { mode: 'without-base-after', headers: { 'Accept-Encoding': 'br,gzip' } },
    ];
    // Identical public URL across requests: this deliberately exercises cache separation.
    for (const scenario of cases) {
        const result = await request(asset.url, scenario.headers);
        assert.equal(result.status, 200, `${asset.url} ${scenario.mode}`);
        if (asset.dictionaryDelivery === 'asset') {
            assert.equal(
                result.headers.link,
                undefined,
                'Asset delivery must not advertise an extra dictionary download'
            );
            assert.equal(
                result.headers['use-as-dictionary'],
                `match="${dictionary.match}", id="${dictionary.id}", type=raw`,
                'The decoded asset must be advertised as the next base'
            );
        }
        const encoding = result.headers['content-encoding'] ?? 'identity';
        const isDictionary = ['dcb', 'dcz'].includes(scenario.mode);
        if (isDictionary) assert.equal(encoding, scenario.mode);
        else assert.ok(!['dcb', 'dcz'].includes(encoding), 'The cache served a dictionary variant to the wrong client');
        const expected = isDictionary ? asset[encoding][dictionary.hash] : asset.representations[encoding];
        assert.ok(expected, `Unexpected representation: ${encoding}`);
        assert.equal(sha256(result.body), expected.hash, `${asset.url}: altered body or incorrect variant`);
        const vary = String(result.headers.vary)
            .toLowerCase()
            .split(',')
            .map((x) => x.trim());
        for (const header of ['accept-encoding', 'available-dictionary', 'sec-fetch-site', 'sec-fetch-mode'])
            assert.ok(vary.includes(header), `Vary does not contain ${header}`);
        rows.push({
            asset: asset.url,
            mode: scenario.mode,
            encoding,
            bytes: result.body.length,
            cloudflare: result.headers['cf-cache-status'] ?? '-',
            cloudfront: result.headers['x-cache'] ?? '-',
        });
    }
}
console.table(rows);
console.log(
    'Bytes and response separation verified. This HTTP client does not verify browser dictionary registration.'
);
