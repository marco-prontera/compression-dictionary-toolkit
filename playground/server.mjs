import http from 'node:http';
import { createSecureServer } from 'node:http2';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { readManifest } from 'compression-dictionary-toolkit';
import { createRequestHandler } from 'compression-dictionary-toolkit/server';
import { demoDictionaryEncodings } from './encoding-policy.mjs';
import { releases } from './product/releases.mjs';

const directory = fileURLToPath(new URL('.', import.meta.url));

/** Demo controls select prebuilt releases. The toolkit package owns all asset negotiation. */
export async function createPlaygroundServer({
    productRoot = path.join(directory, 'product/dist'),
    siteRoot = path.join(directory, 'site'),
    initialVersion = 'v1',
    tls,
    logger = () => {},
} = {}) {
    const versions = Object.keys(releases);
    if (!versions.includes(initialVersion)) throw new Error('Unknown initial version');
    let activeVersion = initialVersion;
    const products = new Map();
    const routes = new Map();
    for (const version of versions) {
        const root = path.join(productRoot, version);
        const manifest = await readManifest(root);
        const assets = Object.values(manifest.assets);
        if (
            assets.length !== 2 ||
            !assets.some((asset) => asset.url.endsWith('.css')) ||
            !assets.some((asset) => asset.url.endsWith('.js'))
        ) {
            throw new Error(`Build ${version} must contain one product JS and one CSS asset`);
        }
        products.set(
            version,
            assets.map(({ key, url, hash, bytes }) => ({ key, url, hash, bytes }))
        );
        const options = { root, base: '/product/', allowInsecureLocalhost: !tls, serverTiming: true, logger };
        const handlers = {
            shared: createRequestHandler({ ...options, dictionaryEncodings: demoDictionaryEncodings }),
            baseline: createRequestHandler({ ...options, dictionaryEncodings: [] }),
        };
        for (const url of [...Object.keys(manifest.assets), ...Object.keys(manifest.dictionaries)])
            routes.set(url, handlers);
    }
    const staticFiles = {
        '/': ['index.html', 'text/html; charset=utf-8'],
        '/site.js': ['site.js', 'text/javascript; charset=utf-8'],
        '/site.css': ['site.css', 'text/css; charset=utf-8'],
        '/preview.js': ['preview.js', 'text/javascript; charset=utf-8'],
    };
    const listener = async (req, res) => {
        const respond = (status, body, contentType = 'application/json; charset=utf-8') => {
            res.writeHead(status, {
                'Content-Type': contentType,
                'Cache-Control': 'no-store',
                'X-Content-Type-Options': 'nosniff',
            });
            res.end(req.method === 'HEAD' ? undefined : body);
        };
        try {
            const url = new URL(req.url, 'http://localhost');
            if (url.pathname === '/api/version') {
                if (req.method !== 'POST') return respond(405, '{"error":"Use POST"}');
                const expectedOrigin = `${tls ? 'https' : 'http'}://${req.headers.host ?? req.headers[':authority']}`;
                if (
                    (req.headers.origin && req.headers.origin !== expectedOrigin) ||
                    (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin')
                ) {
                    return respond(403, '{"error":"Same-origin controls only"}');
                }
                if (!req.headers['content-type']?.startsWith('application/json'))
                    return respond(415, '{"error":"Use JSON"}');
                let body = '';
                for await (const chunk of req) {
                    body += chunk;
                    if (body.length > 1024) return respond(413, '{"error":"Request too large"}');
                }
                let requested;
                try {
                    requested = JSON.parse(body).version;
                } catch {
                    return respond(400, '{"error":"Invalid JSON"}');
                }
                if (!versions.includes(requested)) return respond(400, '{"error":"Unknown version"}');
                activeVersion = requested;
                return respond(200, JSON.stringify({ activeVersion }));
            }
            if (!['GET', 'HEAD'].includes(req.method)) return respond(405, '{"error":"Use GET or HEAD"}');
            if (url.pathname === '/api/state') {
                return respond(200, JSON.stringify({ activeVersion, versions, assets: products.get(activeVersion) }));
            }
            if (url.pathname === '/preview') {
                const version = url.searchParams.get('version') ?? activeVersion;
                const mode = url.searchParams.get('mode') ?? 'shared';
                const encoding = url.searchParams.get('encoding') ?? 'auto';
                const run = url.searchParams.get('run') ?? 'manual';
                if (
                    !versions.includes(version) ||
                    !['shared', 'baseline'].includes(mode) ||
                    !['auto', 'dcb', 'dcz'].includes(encoding) ||
                    !/^[a-zA-Z0-9-]{1,80}$/.test(run)
                ) {
                    return respond(400, '{"error":"Invalid preview options"}');
                }
                const assets = products.get(version);
                const assetUrl = (extension) => {
                    const asset = assets.find((asset) => asset.url.endsWith(extension));
                    return `${mode === 'baseline' ? '/baseline' : ''}${asset.url}?sample=${run}&amp;encoding=${encoding}`;
                };
                return respond(
                    200,
                    `<!doctype html>
<html lang="en" data-version="${version}" data-mode="${mode}" data-run="${run}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Atlas product ${version}</title>
<link data-product rel="stylesheet" href="${assetUrl('.css')}">
<script data-product defer src="${assetUrl('.js')}"></script>
<script defer src="/preview.js"></script></head>
<body><main id="product"></main></body></html>`,
                    'text/html; charset=utf-8'
                );
            }
            const baseline = url.pathname.startsWith('/baseline/');
            const assetPath = baseline ? url.pathname.slice('/baseline'.length) : url.pathname;
            const handlers = routes.get(assetPath);
            if (handlers) {
                // Separate public paths keep baseline requests outside dictionary match patterns.
                if (baseline) req.url = req.url.slice('/baseline'.length);
                return await handlers[baseline ? 'baseline' : 'shared'](req, res);
            }
            const file = Object.hasOwn(staticFiles, url.pathname) ? staticFiles[url.pathname] : undefined;
            if (file) return respond(200, await readFile(path.join(siteRoot, file[0])), file[1]);
            return respond(404, '{"error":"Not found"}');
        } catch (error) {
            logger({ status: 500, error: error.message });
            if (res.headersSent) res.destroy(error);
            else respond(500, '{"error":"Playground request failed"}');
        }
    };
    return tls ? createSecureServer({ ...tls, allowHTTP1: true }, listener) : http.createServer(listener);
}

export async function startPlayground() {
    const { values } = parseArgs({
        options: {
            port: { type: 'string', default: '4173' },
            https: { type: 'boolean', default: false },
        },
    });
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
    const tls = values.https
        ? {
              key: await readFile(path.join(directory, '../.cert/localhost-key.pem')),
              cert: await readFile(path.join(directory, '../.cert/localhost.pem')),
          }
        : undefined;
    const server = await createPlaygroundServer({ tls, logger: (entry) => console.log(JSON.stringify(entry)) });
    await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
    console.log(
        `Playground: ${tls ? 'https' : 'http'}://localhost:${port}\nUse the version buttons; builds are already prepared. Ctrl+C to stop.`
    );
    return server;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await startPlayground();
