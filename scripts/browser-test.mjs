import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readManifest, digestHeader } from 'compression-dictionary-toolkit';
import { createPlaygroundServer } from '../playground/server.mjs';
import { buildDemo, project } from './demo.mjs';

process.chdir(project);
for (const version of ['v1', 'v2', 'v3', 'v4']) await buildDemo(version);
const manifests = Object.fromEntries(
    await Promise.all(
        ['v1', 'v2', 'v3', 'v4'].map(async (version) => [
            version,
            await readManifest(`playground/product/dist/${version}`),
        ])
    )
);
const server = await createPlaygroundServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://localhost:${server.address().port}`;
await mkdir('test-results', { recursive: true });
const profiles = await mkdtemp(path.join(project, 'test-results/playground-profiles-'));
const measurements = [];
const dictionaryRequests = [];
let context;
let browserVersion;

async function latest(page, count) {
    await page.waitForFunction(
        (count) => document.querySelector('#history-count').textContent === String(count),
        count,
        { timeout: 30000 }
    );
    const downloadPromise = page.waitForEvent('download');
    await page.click('#export');
    const download = await downloadPromise;
    const report = JSON.parse(await readFile(await download.path(), 'utf8'));
    assert.equal(report.measurements.length, count);
    return report.measurements.at(-1);
}
async function verifyPair(sample, responses, { advertised, used } = {}) {
    const target = manifests[sample.version];
    for (const mode of ['shared', 'baseline']) {
        const result = sample[mode];
        assert.equal(result.version, sample.version);
        assert.equal(result.resources.length, 2);
        assert.ok(Number.isFinite(result.readyMs) && result.readyMs > 0);
        for (const resource of result.resources) {
            const url = new URL(resource.url);
            const asset = target.assets[url.pathname.replace(/^\/baseline/, '')];
            assert.ok(asset);
            const response = responses.find((candidate) => candidate.url() === resource.url);
            assert.ok(response, 'Every displayed measurement must correspond to a real response');
            const headers = await response.allHeaders();
            const requestHeaders = await response.request().allHeaders();
            const body = await response.body();
            assert.equal(response.status(), 200);
            assert.equal(createHash('sha256').update(body).digest('hex'), asset.hash);
            assert.equal(body.length, asset.bytes);
            assert.equal(resource.decodedBytes, asset.bytes);
            assert.equal(resource.encodedBytes, Number(headers['content-length']));
            assert.ok(resource.transferBytes >= resource.encodedBytes);
            assert.ok(Number.isFinite(resource.durationMs) && resource.durationMs >= 0);
            assert.ok(Number.isFinite(resource.serverMs) && resource.serverMs >= 0);
            assert.equal(resource.encoding, headers['content-encoding'] ?? 'identity');
            if (mode === 'baseline') {
                assert.equal(requestHeaders['available-dictionary'], undefined);
                assert.equal(headers['use-as-dictionary'], undefined);
                assert.equal(headers.link, undefined);
                assert.equal(resource.dictionaryHash, null);
                assert.equal(resource.encoding, 'br');
            } else {
                const base =
                    advertised && Object.values(manifests[advertised].assets).find((item) => item.key === asset.key);
                assert.equal(requestHeaders['available-dictionary'], base ? digestHeader(base.hash) : undefined);
                assert.ok(headers['use-as-dictionary'].includes(asset.hash));
                assert.equal(headers.link, undefined);
                if (used) {
                    const dictionary = Object.values(manifests[used].assets).find((item) => item.key === asset.key);
                    assert.equal(resource.dictionaryHash, dictionary.hash);
                    if (sample.format === 'auto') {
                        assert.ok(['dcb', 'dcz'].includes(resource.encoding));
                        assert.equal(
                            resource.encodedBytes,
                            Math.min(asset.dcb[dictionary.hash].bytes, asset.dcz[dictionary.hash].bytes)
                        );
                    } else assert.equal(resource.encoding, sample.format);
                } else {
                    assert.equal(resource.dictionaryHash, null);
                    assert.equal(resource.encoding, 'br');
                }
            }
        }
    }
    measurements.push(sample);
}

try {
    for (const [name, format, targets] of [
        ['skip-dcb', 'dcb', ['v3', 'v4']],
        ['skip-dcz', 'dcz', ['v3', 'v4']],
        ['skip-auto', 'auto', ['v3', 'v4']],
        ['next-auto', 'auto', ['v2']],
        ['expired-auto', 'auto', ['v4']],
    ]) {
        context = await chromium.launchPersistentContext(path.join(profiles, name), {
            headless: true,
            executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
            args: ['--no-sandbox', '--disable-dev-shm-usage'],
            viewport: { width: 1280, height: 1000 },
        });
        // Controls only: never inject Available-Dictionary or Accept-Encoding.
        await context.request.post(`${origin}/api/version`, { data: { version: 'v1' } });
        const page = await context.newPage();
        browserVersion = context.browser()?.version() ?? (await page.evaluate(() => navigator.userAgent));
        const responses = [];
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        page.on('request', (request) => {
            if (new URL(request.url()).pathname.endsWith('.dict')) dictionaryRequests.push(request.url());
        });
        page.on('response', (response) => {
            if (new URL(response.url()).pathname.includes('/product/assets/')) responses.push(response);
        });
        await page.goto(origin, { waitUntil: 'networkidle' });
        const first = await latest(page, 1);
        await verifyPair(first, responses);
        assert.equal(
            first.shared.resources.reduce((n, r) => n + r.encodedBytes, 0),
            first.baseline.resources.reduce((n, r) => n + r.encodedBytes, 0)
        );
        await page.selectOption('#encoding', format);
        let from = 'v1';
        let count = 1;
        for (const version of targets) {
            const before = responses.length;
            if (version === 'v3') {
                await page.click('[data-version="v2"]');
                await page.waitForFunction(() => document.querySelector('#active-version').textContent === 'v2');
            }
            await page.click(`[data-version="${version}"]`);
            await page.waitForFunction(
                (version) => document.querySelector('#active-version').textContent === version,
                version
            );
            assert.equal(responses.length, before, 'Publishing must not request product assets');
            assert.ok((await page.textContent('#loaded-version')).includes(from));
            await page.click('#load-product');
            const sample = await latest(page, ++count);
            await verifyPair(sample, responses, { advertised: from, used: name === 'expired-auto' ? undefined : from });
            assert.notEqual(first.shared.resources[0].url, sample.shared.resources[0].url);
            if (name === 'skip-auto' && version === 'v3') {
                await page.screenshot({ path: 'test-results/demo.png', fullPage: true });
                const downloadPromise = page.waitForEvent('download');
                await page.click('#export');
                const download = await downloadPromise;
                const exported = JSON.parse(await readFile(await download.path(), 'utf8'));
                assert.equal(exported.measurements.length, count);
                assert.equal(exported.measurements.at(-1).version, version);
            }
            from = version;
        }
        if (name === 'skip-auto') {
            await page.setViewportSize({ width: 390, height: 844 });
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
            await page.screenshot({ path: 'test-results/demo-mobile.png', fullPage: true });
        }
        assert.deepEqual(errors, []);
        await context.close();
        context = undefined;
    }
    assert.deepEqual(dictionaryRequests, []);
    const report = { testedAt: new Date().toISOString(), browserVersion, dictionaryRequests, measurements };
    await writeFile('test-results/browser-report.json', JSON.stringify(report, null, 2) + '\n');
    console.table(
        measurements.map((sample) => ({
            version: sample.version,
            format: sample.format,
            sharedBytes: sample.shared.resources.reduce((n, r) => n + r.encodedBytes, 0),
            ordinaryBytes: sample.baseline.resources.reduce((n, r) => n + r.encodedBytes, 0),
            encodings: sample.shared.resources.map((r) => r.encoding).join('/'),
        }))
    );
    console.log(
        `Verified ${measurements.length} paired visits and ${measurements.length * 4} JS/CSS responses in Chromium ${browserVersion}; zero .dict requests.`
    );
} finally {
    await context?.close();
    await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections?.();
    });
    await rm(profiles, { recursive: true, force: true });
}
