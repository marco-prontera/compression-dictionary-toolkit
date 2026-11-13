import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { exportRelease } from 'compression-dictionary-toolkit';
import { createEdgeHandler } from 'compression-dictionary-toolkit/edge';

export async function exportEdge(fixture, options) {
    const targetDir = path.join(fixture.root, 'release');
    const exported = await exportRelease({ outDir: fixture.outDir, targetDir, ...options });
    return createEdgeHandler({
        manifest: JSON.parse(await readFile(exported.manifestPath)),
        loadObject: (file) => readFile(path.join(targetDir, file)),
    });
}

export async function requestEdge(handler, url, headers = {}, method = 'GET') {
    const response = await handler(new Request(`https://app.example${url}`, { headers, method }));
    return {
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: Buffer.from(await response.arrayBuffer()),
    };
}
