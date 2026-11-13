import path from 'node:path';
import { readManifest } from './manifest.js';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import {
    confinedPath,
    isPathInsideDirectory,
    resolveDirectory,
    validateKey,
    validatePath,
    withExportLock,
    writeJSON,
} from './utils.js';

const mime = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.cjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.webp': 'image/webp',
    '.woff2': 'font/woff2',
    '.ico': 'image/x-icon',
    '.txt': 'text/plain; charset=utf-8',
    '.wasm': 'application/wasm',
};

/** Build-only: export immutable, opaque objects and a private edge manifest. No upload. */
export async function exportRelease({ outDir = 'dist', targetDir = 'release', releaseId, base = '/' }) {
    validateKey(releaseId);
    validatePath(base);
    if (!base.endsWith('/')) throw new Error('base must end with /');
    outDir = path.resolve(outDir);
    targetDir = path.resolve(targetDir);
    const [realRoot, realTarget] = await Promise.all([realpath(outDir), resolveDirectory(targetDir)]);
    if (
        isPathInsideDirectory(outDir, targetDir) ||
        isPathInsideDirectory(targetDir, outDir) ||
        isPathInsideDirectory(realRoot, realTarget) ||
        isPathInsideDirectory(realTarget, realRoot)
    ) {
        throw new Error('outDir and targetDir must be separate directories');
    }
    // Pin aliases and serialize the complete export, including both metadata files.
    return withExportLock(realTarget, () => writeRelease(realRoot, realTarget, releaseId, base));
}

async function writeRelease(outDir, targetDir, releaseId, base) {
    const published = { ...(await readManifest(outDir)), kind: 'shared-dict-release', releaseId, staticFiles: {} };
    const objects = new Map();
    async function object(relative, expected) {
        const resolved = await realpath(path.resolve(outDir, relative));
        if (!isPathInsideDirectory(outDir, resolved)) {
            throw new Error('File is outside outDir');
        }
        const source = await open(resolved, constants.O_RDONLY | constants.O_NONBLOCK);
        let temporary;
        let destination;
        try {
            const info = await source.stat();
            if (!info.isFile()) throw new Error(`Export requires a regular file: ${relative}`);
            if (expected && info.size !== expected.bytes) throw new Error('Release integrity check failed: size');
            const candidate = await confinedPath(targetDir, path.join(targetDir, 'objects', `.${randomUUID()}.tmp`));
            await mkdir(path.dirname(candidate), { recursive: true });
            destination = await open(candidate, 'wx');
            temporary = candidate;
            const digest = createHash('sha256');
            let bytes = 0;
            for await (const chunk of source.createReadStream({ autoClose: false })) {
                bytes += chunk.length;
                if (bytes > info.size) throw new Error('Release integrity check failed: file grew during export');
                digest.update(chunk);
                await destination.writeFile(chunk);
            }
            const hash = digest.digest('hex');
            if (bytes !== info.size || (expected && hash !== expected.hash))
                throw new Error('Release integrity check failed');
            await destination.close();
            destination = undefined;
            const file = `objects/${hash}.bin`;
            if (!objects.has(file)) {
                await rename(temporary, await confinedPath(targetDir, path.join(targetDir, file)));
                objects.set(file, { file, hash, bytes });
            }
            return { file, hash, bytes };
        } finally {
            try {
                await source.close();
            } finally {
                try {
                    await destination?.close();
                } finally {
                    if (temporary) await rm(temporary, { force: true });
                }
            }
        }
    }
    for (const asset of Object.values(published.assets)) {
        for (const map of [asset.representations, asset.dcb, asset.dcz ?? {}]) {
            for (const representation of Object.values(map))
                Object.assign(representation, await object(representation.file, representation));
        }
    }
    for (const dictionary of Object.values(published.dictionaries))
        Object.assign(dictionary, await object(dictionary.file, dictionary));
    const preparedFiles = new Set(Object.values(published.assets).map((asset) => asset.file));
    async function visit(relative = '') {
        for (const entry of await readdir(path.join(outDir, relative), { withFileTypes: true })) {
            if (entry.name.startsWith('.')) continue;
            const file = path.posix.join(relative, entry.name);
            if (entry.isSymbolicLink()) throw new Error(`Symlink cannot be exported: ${file}`);
            if (entry.isDirectory()) {
                await visit(file);
                continue;
            }
            if (!entry.isFile()) continue;
            // Static filenames are not dictionary patterns. Encode literal %, spaces, and Unicode per segment.
            // eslint-disable-next-line no-control-regex -- Reject control characters and backslashes in public filenames.
            if (/[\\\x00-\x1f\x7f]/.test(file)) throw new Error(`Invalid public file path: ${JSON.stringify(file)}`);
            const url = `${base}${file.split('/').map(encodeURIComponent).join('/')}`;
            if (preparedFiles.has(file)) continue;
            const representation = await object(file);
            const record = {
                ...representation,
                contentType: mime[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
                cacheControl: 'public, max-age=0, must-revalidate',
            };
            published.staticFiles[url] = record;
            if (file === 'index.html') published.staticFiles[base] = record;
        }
    }
    await visit();
    // The manifest is activated only after every object has been written.
    await writeJSON(path.join(targetDir, 'edge-manifest.json'), published, targetDir);
    await writeJSON(
        path.join(targetDir, 'upload-plan.json'),
        {
            schemaVersion: 1,
            releaseId,
            objectMetadata: {
                contentType: 'application/octet-stream',
                cacheControl: 'public, max-age=31536000, immutable, no-transform',
            },
            objects: [...objects.values()],
        },
        targetDir
    );
    return { manifestPath: path.join(targetDir, 'edge-manifest.json'), objects: objects.size, releaseId };
}
