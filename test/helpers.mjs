import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';

export async function fixture(t) {
    const parent = path.resolve('test-results');
    await mkdir(parent, { recursive: true });
    const root = await mkdtemp(path.join(parent, 'case-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const outDir = path.join(root, 'dist');
    const storeDir = path.join(root, 'store');
    await mkdir(outDir);
    return { root, outDir, storeDir };
}
export function source(version = 1) {
    return Buffer.from(
        `window.catalog=${JSON.stringify(
            Array.from({ length: 250 }, (_, i) => ({
                id: i,
                token: createHash('sha256').update(String(i)).digest('hex'),
                value: i === 7 ? version : i,
            }))
        )};`
    );
}
export function stylesheet(version = 1) {
    return Buffer.from(
        `:root{--version:${version}}\n${Array.from(
            { length: 250 },
            (_, i) =>
                `.sample-${i}{color:#${createHash('sha256').update(String(i)).digest('hex').slice(0, 6)};padding:${i % 13}px}`
        ).join('\n')}`
    );
}
export async function put(outDir, file, bytes) {
    const full = path.join(outDir, file);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, bytes);
    return full;
}
export async function listen(t, server) {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(
        () =>
            new Promise((resolve) => {
                server.close(resolve);
                server.closeAllConnections?.();
            })
    );
    return server.address().port;
}
export function request(port, url, headers = {}, method = 'GET') {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: url, method, headers }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        });
        req.on('error', reject);
        req.end();
    });
}
