import { encodingQuality, selectRepresentation } from './negotiation.js';
import { etagMatches, unsafePath, vary, dictionaryAdvertisement } from './http.js';

const own = (map, key) => (Object.hasOwn(map, key) ? map[key] : undefined);
const sha256 = async (bytes) =>
    Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (x) =>
        x.toString(16).padStart(2, '0')
    ).join('');

/** Selection only. loadObject retrieves exact opaque bytes; no compression at runtime. */
export function createEdgeHandler({ manifest, loadObject }) {
    if (manifest.schemaVersion !== 1 || manifest.kind !== 'shared-dict-release')
        throw new Error('Invalid edge manifest');
    return async (request, env, context) => {
        const fail = (status) =>
            new Response(null, {
                status,
                headers: {
                    'Cache-Control': 'no-store',
                    ...(status === 405 ? { Allow: 'GET, HEAD' } : {}),
                },
            });
        try {
            if (!['GET', 'HEAD'].includes(request.method)) return fail(405);
            const url = new URL(request.url);
            const decoded = decodeURIComponent(url.pathname);
            const segments = decoded.split('/');
            if (unsafePath(decoded)) return fail(403);
            const dictionary = own(manifest.dictionaries, url.pathname);
            const asset = own(manifest.assets, url.pathname);
            let staticFile = own(manifest.staticFiles, url.pathname);
            if (!dictionary && !asset && !staticFile) {
                if (segments.some((part) => part.startsWith('.'))) return fail(403);
                // Normalize only static URLs, after traversal checks, decoding each filename exactly once.
                staticFile = own(manifest.staticFiles, segments.map(encodeURIComponent).join('/'));
                if (!staticFile) return fail(404);
            }
            const headers = Object.fromEntries(request.headers);
            // Cloudflare may rewrite Accept-Encoding; use the original visitor value if supplied.
            if (typeof request.cf?.clientAcceptEncoding === 'string')
                headers['accept-encoding'] = request.cf.clientAcceptEncoding;
            const site = headers['sec-fetch-site'];
            const allowed = url.protocol === 'https:' && (!site || site === 'same-origin' || site === 'none');
            const responseHeaders = new Headers({
                'Vary': vary,
                'X-Content-Type-Options': 'nosniff',
                // Never cache the final negotiated response without rerunning selection.
                // CDN/object caches store the immutable opaque objects separately.
                'Cloudflare-CDN-Cache-Control': 'no-store',
            });
            let representation;
            if (dictionary) {
                if (!allowed) return fail(403);
                if (!encodingQuality(headers['accept-encoding'], 'identity')) return fail(406);
                representation = dictionary;
                responseHeaders.set('Content-Type', 'application/octet-stream');
                responseHeaders.set(
                    'Use-As-Dictionary',
                    `match="${dictionary.match}", id="${dictionary.id}", type=raw`
                );
                responseHeaders.set('Cache-Control', `${dictionary.cacheControl}, no-transform`);
            } else if (asset) {
                representation = selectRepresentation(asset, headers, allowed);
                if (!representation) return fail(406);
                responseHeaders.set('Content-Type', asset.contentType);
                responseHeaders.set('Cache-Control', `${asset.cacheControl}, no-transform`);
                if (representation.encoding !== 'identity')
                    responseHeaders.set('Content-Encoding', representation.encoding);
                if (allowed) {
                    const [name, value] = dictionaryAdvertisement(asset, manifest.dictionaries[asset.dictionaryUrl]);
                    responseHeaders.set(name, value);
                }
            } else {
                if (!encodingQuality(headers['accept-encoding'], 'identity')) return fail(406);
                representation = staticFile;
                responseHeaders.set('Content-Type', staticFile.contentType);
                responseHeaders.set('Cache-Control', `${staticFile.cacheControl}, no-transform`);
            }
            const tag = `"${representation.hash}"`;
            responseHeaders.set('ETag', tag);
            if (etagMatches(headers['if-none-match'], tag))
                return new Response(null, {
                    status: 304,
                    headers: responseHeaders,
                    encodeBody: 'manual',
                });
            responseHeaders.set('Content-Length', String(representation.bytes));
            if (request.method === 'HEAD')
                return new Response(null, {
                    headers: responseHeaders,
                    encodeBody: 'manual',
                });
            const body = await loadObject(representation.file, env, context);
            if (!body) return fail(502);
            const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
            if (bytes.length !== representation.bytes || (await sha256(bytes)) !== representation.hash)
                return fail(502);
            return new Response(bytes, {
                headers: responseHeaders,
                encodeBody: 'manual',
            });
        } catch {
            return fail(500);
        }
    };
}

/** Read neutral binary objects from private R2, or from CloudFront in front of S3. */
export async function loadCloudflareObject(key, env) {
    if (!/^objects\/[a-f0-9]{64}\.bin$/.test(key)) throw new Error('Invalid object key');
    if (env.BUCKET) {
        const object = await env.BUCKET.get(key);
        if (!object) return null;
        if (object.httpMetadata?.contentEncoding) throw new Error('R2 object was transformed: remove Content-Encoding');
        return object.arrayBuffer();
    }
    const origin = new URL(env.BLOB_ORIGIN);
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash)
        throw new Error('BLOB_ORIGIN must be an HTTPS URL without credentials, query, or fragment');
    if (!origin.pathname.endsWith('/')) origin.pathname += '/';
    const response = await fetch(new URL(key, origin), {
        headers: { 'Accept-Encoding': 'identity' },
        redirect: 'error',
    });
    if (response.status !== 200 || response.headers.has('Content-Encoding'))
        throw new Error('Origin: expected opaque bytes without Content-Encoding');
    return response.arrayBuffer();
}
