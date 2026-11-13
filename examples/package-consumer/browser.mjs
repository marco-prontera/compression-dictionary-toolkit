import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { digestHeader } from 'compression-dictionary-toolkit';
import { buildReleases } from './build.mjs';
import { startServer } from './server.mjs';
import { results, report, releaseDirectory } from './project.mjs';

const manifests = await buildReleases();
const app = await startServer();
const profiles = await mkdtemp(path.join(results, 'browser-profiles-'));
const samples = [];
let context;
let browser;
try {
    for (const target of ['v3', 'v4']) {
        context = await chromium.launchPersistentContext(path.join(profiles, target), {
            headless: true,
            executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
            args: ['--no-sandbox', '--disable-dev-shm-usage'],
        });
        const page = await context.newPage();
        const errors = [];
        const dictionaries = [];
        page.on('pageerror', (error) => errors.push(error.message));
        page.on('request', (req) => {
            if (new URL(req.url()).pathname.endsWith('.dict')) dictionaries.push(req.url());
        });
        browser = context.browser()?.version();
        for (const version of ['v1', target]) {
            app.setVersion(version);
            const responses = [];
            const capture = (response) => responses.push(response);
            page.on('response', capture);
            await page.goto(app.origin + '/?visit=' + version, { waitUntil: 'networkidle' });
            assert.equal(await page.locator('#version').textContent(), version);
            for (const asset of Object.values(manifests[version].assets)) {
                const response = responses.find((item) => new URL(item.url()).pathname === asset.url);
                assert.ok(response);
                const headers = await response.allHeaders();
                const sent = await response.request().allHeaders();
                assert.equal(response.status(), 200);
                assert.deepEqual(
                    await response.body(),
                    await readFile(path.join(releaseDirectory(version), asset.file))
                );
                assert.ok(headers['use-as-dictionary'].includes(asset.hash));
                if (version === 'v1') {
                    assert.equal(sent['available-dictionary'], undefined);
                    assert.equal(headers['content-encoding'], 'br');
                } else {
                    const base = Object.values(manifests.v1.assets).find((item) => item.key === asset.key);
                    assert.equal(sent['available-dictionary'], digestHeader(base.hash));
                    assert.ok(
                        version === 'v3'
                            ? ['dcb', 'dcz'].includes(headers['content-encoding'])
                            : headers['content-encoding'] === 'br'
                    );
                }
                samples.push({
                    version,
                    scenario: 'v1 to ' + target,
                    asset: path.extname(asset.url),
                    encoding: headers['content-encoding'],
                    bytes: Number(headers['content-length']),
                });
            }
            page.off('response', capture);
        }
        assert.deepEqual(errors, []);
        assert.deepEqual(dictionaries, []);
        await context.close();
        context = undefined;
    }
    await report('browser', { passed: true, browser, dictionaryRequests: 0, samples });
    console.table(samples);
    console.log('Native browser dictionary headers and decoded JS/CSS verified');
} finally {
    await context?.close();
    await app.close();
    await rm(profiles, { recursive: true, force: true });
}
