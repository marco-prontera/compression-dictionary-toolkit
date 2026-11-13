import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import path from 'node:path';

/** Capture npm's publication request on loopback; never contact the public registry. */
export async function checkPublishMetadata({ directory, npmCli, cache, integrity }) {
    const metadata = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
    let submitted;
    const registry = http.createServer(async (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if (req.method !== 'PUT') {
            res.writeHead(404);
            res.end('{"error":"not_found"}');
            return;
        }
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        submitted = JSON.parse(Buffer.concat(chunks));
        res.writeHead(201);
        res.end('{"ok":true}');
    });
    await new Promise((resolve) => registry.listen(0, '127.0.0.1', resolve));
    const port = registry.address().port;
    const userconfig = path.join(cache, 'publish-test.npmrc');
    await writeFile(userconfig, '//127.0.0.1:' + port + '/:_authToken=local-test-only\n');
    try {
        await promisify(execFile)(
            process.execPath,
            [
                npmCli,
                'publish',
                directory,
                '--ignore-scripts',
                '--access=public',
                '--tag=metadata-check',
                '--provenance=false',
                '--fetch-retries=0',
                '--cache',
                cache,
                '--userconfig',
                userconfig,
                '--registry=http://127.0.0.1:' + port + '/',
            ],
            { env: { ...process.env, npm_config_update_notifier: 'false' }, maxBuffer: 1024 * 1024 }
        );
        const manifest = submitted?.versions?.[metadata.version];
        assert.ok(manifest, 'npm must submit the expected package version');
        for (const key of ['_resolved', '_from', '_where'])
            assert.equal(manifest[key], undefined, 'Private npm metadata: ' + key);
        assert.doesNotMatch(JSON.stringify(manifest), /\/(?:Users|home)\/|[A-Z]:\\\\Users\\\\/);
        const attachment = submitted._attachments[metadata.name + '-' + metadata.version + '.tgz'];
        const bytes = Buffer.from(attachment.data, 'base64');
        assert.equal(
            'sha512-' + createHash('sha512').update(bytes).digest('base64'),
            integrity,
            'Publishing the directory must preserve the verified tarball'
        );
    } finally {
        await new Promise((resolve) => {
            registry.close(resolve);
            registry.closeAllConnections();
        });
    }
}
