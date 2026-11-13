import http from 'node:http';
import { createSecureServer } from 'node:http2';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readManifest } from '../core/manifest.js';
import { encodingQuality, selectRepresentation } from './negotiation.js';
import { etagMatches, unsafePath, vary, dictionaryAdvertisement } from './http.js';

export { parseAvailableDictionary, encodingQuality, selectRepresentation } from './negotiation.js';
const mime = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.cjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.wasm': 'application/wasm',
};
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const contains = (root, file) => {
    const p = path.relative(root, file);
    return p === '' || (p !== '..' && !p.startsWith(`..${path.sep}`) && !path.isAbsolute(p));
};

async function resolveRelease(directory) {
    try {
        return await realpath(directory);
    } catch (error) {
        // An atomic symlink replacement can interrupt realpath on macOS. Retry once before reading any files.
        if (error.code !== 'EINVAL') throw error;
        return realpath(directory);
    }
}

async function safeRead(root, relative) {
    const resolved = await realpath(path.resolve(root, relative));
    const rootReal = await realpath(root);
    if (!contains(rootReal, resolved)) throw Object.assign(new Error('Forbidden'), { status: 403 });
    if (!(await stat(resolved)).isFile()) throw Object.assign(new Error('Not found'), { status: 404 });
    return readFile(resolved);
}

function readableRequest(headers) {
    // This server intentionally exposes only same-origin resources (no CORS).
    const site = headers['sec-fetch-site'];
    if (!site || site === 'same-origin') return true;
    const mode = headers['sec-fetch-mode'];
    return !mode || mode === 'navigate' || mode === 'same-origin';
}

function secureRequest(req, allowInsecureLocalhost) {
    if (req.socket.encrypted) return true;
    if (!allowInsecureLocalhost) return false;
    const address = req.socket.remoteAddress;
    const loopback = address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
    const host = String(req.headers.host ?? req.headers[':authority'] ?? '');
    return loopback && /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host);
}

/** Node request handler. Pass a directory or a function returning the active release directory. */
export function createRequestHandler({
    root = 'dist',
    base = '/',
    allowInsecureLocalhost = false,
    dictionaryEncodings = ['dcz', 'dcb'],
    serverTiming = false,
    logger = () => {},
} = {}) {
    if (typeof base !== 'string' || !/^\/(?:[A-Za-z0-9_~-][A-Za-z0-9_.~-]*\/)*$/.test(base))
        throw new Error('base must be an absolute same-origin path ending with /, such as / or /app/');
    return async (req, res) => {
        let pathname;
        const started = serverTiming ? performance.now() : 0;
        try {
            res.setHeader('X-Content-Type-Options', 'nosniff');
            if (!['GET', 'HEAD'].includes(req.method)) {
                res.setHeader('Allow', 'GET, HEAD');
                res.writeHead(405);
                res.end();
                return;
            }
            const rawPath = (req.url ?? '/').split('?')[0];
            const decoded = decodeURIComponent(rawPath);
            const segments = decoded.split('/');
            if (!decoded.startsWith('/') || unsafePath(decoded)) {
                res.writeHead(403);
                res.end();
                return;
            }
            // Generated paths are ASCII. Decode only for traversal validation, not routing.
            pathname = rawPath;
            // Pin the release before reading its manifest; an active symlink may change during the request.
            const directory = await resolveRelease(path.resolve(typeof root === 'function' ? await root() : root));
            const manifest = await readManifest(directory);
            const dictionary = manifest.dictionaries[pathname];
            const asset = manifest.assets[pathname];
            // Hidden paths are public only when their exact URL is declared in the manifest.
            if (!dictionary && !asset && segments.some((part) => part.startsWith('.'))) {
                res.writeHead(403);
                res.end();
                return;
            }
            const secure = secureRequest(req, allowInsecureLocalhost);
            const allowDictionary = secure && readableRequest(req.headers);
            let bytes;
            let encoding = 'identity';
            let dictionaryHash;
            let tag;
            if (dictionary) {
                if (!allowDictionary) {
                    res.writeHead(403);
                    res.end();
                    return;
                }
                if (!encodingQuality(req.headers['accept-encoding'], 'identity')) {
                    res.writeHead(406);
                    res.end();
                    return;
                }
                bytes = await safeRead(directory, dictionary.file);
                if (hash(bytes) !== dictionary.hash) throw new Error('Dictionary integrity failure');
                tag = `"${dictionary.hash}"`;
                res.setHeader('Content-Type', 'application/octet-stream');
                res.setHeader('Cache-Control', dictionary.cacheControl);
                res.setHeader('Use-As-Dictionary', `match="${dictionary.match}", id="${dictionary.id}", type=raw`);
                res.setHeader('Vary', vary);
            } else if (asset) {
                res.setHeader('Vary', vary);
                const allowedEncodings =
                    typeof dictionaryEncodings === 'function' ? dictionaryEncodings(req) : dictionaryEncodings;
                const chosen = selectRepresentation(asset, req.headers, allowDictionary, allowedEncodings);
                if (!chosen) {
                    res.writeHead(406);
                    res.end();
                    return;
                }
                bytes = await safeRead(directory, chosen.file);
                if (hash(bytes) !== chosen.hash) throw new Error('Representation integrity failure');
                encoding = chosen.encoding;
                dictionaryHash = chosen.dictionaryHash;
                tag = `"${chosen.hash}"`;
                res.setHeader('Content-Type', asset.contentType);
                res.setHeader('Cache-Control', asset.cacheControl);
                if (allowDictionary && allowedEncodings.length > 0) {
                    const [name, value] = dictionaryAdvertisement(asset, manifest.dictionaries[asset.dictionaryUrl]);
                    res.setHeader(name, value);
                }
                if (encoding !== 'identity') res.setHeader('Content-Encoding', encoding);
            } else {
                if (pathname.startsWith('/__dictionaries/') || !decoded.startsWith(base)) {
                    res.writeHead(404);
                    res.end();
                    return;
                }
                if (!encodingQuality(req.headers['accept-encoding'], 'identity')) {
                    res.writeHead(406);
                    res.end();
                    return;
                }
                const relative = decoded.slice(base.length) || 'index.html';
                bytes = await safeRead(directory, relative);
                tag = `"${hash(bytes)}"`;
                res.setHeader('Content-Type', mime[path.extname(relative).toLowerCase()] ?? 'application/octet-stream');
                res.setHeader('Cache-Control', 'no-cache');
            }
            if (serverTiming) {
                const metrics = [
                    `asset;dur=${(performance.now() - started).toFixed(2)}`,
                    `encoding;desc="${encoding}"`,
                ];
                if (dictionaryHash) metrics.push(`dictionary;desc="${dictionaryHash}"`);
                res.setHeader('Server-Timing', metrics.join(', '));
            }
            res.setHeader('ETag', tag);
            // Strong validators vary with the wire representation, including the dictionary.
            if (etagMatches(req.headers['if-none-match'], tag)) {
                res.writeHead(304);
                res.end();
                logger({
                    method: req.method,
                    url: pathname,
                    status: 304,
                    encoding,
                    dictionaryHash,
                    bytes: 0,
                });
                return;
            }
            res.setHeader('Content-Length', bytes.length);
            res.writeHead(200);
            res.end(req.method === 'HEAD' ? undefined : bytes);
            logger({
                method: req.method,
                url: pathname,
                status: 200,
                encoding,
                dictionaryHash,
                bytes: bytes.length,
            });
        } catch (error) {
            if (res.headersSent) {
                res.destroy(error);
                return;
            }
            // Never leave a Content-Encoding header attached to an error body.
            for (const name of res.getHeaderNames()) res.removeHeader(name);
            const status = error.status ?? (error.code === 'ENOENT' ? 404 : error instanceof URIError ? 400 : 500);
            res.writeHead(status, {
                'Content-Type': 'text/plain; charset=utf-8',
                'Cache-Control': 'no-store',
            });
            res.end(
                req.method === 'HEAD'
                    ? undefined
                    : `${status === 500 ? 'Internal server error' : 'Resource unavailable'}\n`
            );
            logger({
                method: req.method,
                url: pathname,
                status,
                error: error.message,
            });
        }
    };
}

export function createDictionaryServer({ tls, ...options } = {}) {
    const handler = createRequestHandler(options);
    return tls ? createSecureServer({ ...tls, allowHTTP1: true }, handler) : http.createServer(handler);
}
