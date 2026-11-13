import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const MAX_DICTIONARY = 8 * 1024 * 1024;
const MAX_METADATA = 64 * 1024 * 1024;
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const digestHeader = (hash) => `:${Buffer.from(hash, 'hex').toString('base64')}:`;
export const emptyManifest = () => ({
    schemaVersion: 1,
    assets: {},
    dictionaries: {},
});
export const posix = (value) => value.split(path.sep).join('/');
export function isPathInsideDirectory(directory, filePath) {
    const relativePath = path.relative(directory, filePath);
    if (path.isAbsolute(relativePath)) {
        return false;
    }

    const [firstSegment] = relativePath.split(path.sep);
    return firstSegment !== '..';
}

// Resolve existing ancestors as well, so validation does not need to create new directories.
export async function resolveDirectory(directory) {
    const absolute = path.resolve(directory);
    try {
        return await realpath(absolute);
    } catch (error) {
        const parent = path.dirname(absolute);
        if (error.code !== 'ENOENT' || parent === absolute) throw error;
        const entry = await lstat(absolute).catch((error) => {
            if (error.code !== 'ENOENT') throw error;
        });
        if (entry?.isSymbolicLink())
            throw new Error(`Dangling symlink is not allowed: ${absolute}`, {
                cause: error,
            });
        return path.join(await resolveDirectory(parent), path.basename(absolute));
    }
}

// The configured root may itself be an alias; descendants must stay inside its physical directory.
export async function confinedPath(root, file) {
    if (!isPathInsideDirectory(root, file)) {
        throw new Error(`File is outside the configured directory: ${file}`);
    }
    const [realRoot, resolved] = await Promise.all([resolveDirectory(root), resolveDirectory(file)]);
    if (!isPathInsideDirectory(realRoot, resolved)) {
        throw new Error(`File is outside the configured directory: ${file}`);
    }
    return resolved;
}

export async function readBoundedFile(
    file,
    maxBytes = MAX_DICTIONARY,
    message = 'Raw dictionary required: 1 byte–8 MiB'
) {
    // Nonblocking open lets us reject pipes/devices instead of waiting indefinitely for a writer.
    const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
        const info = await handle.stat();
        if (!info.isFile() || info.size === 0 || info.size > maxBytes) throw new Error(message);
        // One extra byte detects growth after stat without ever allocating an unbounded buffer.
        const buffer = Buffer.allocUnsafe(info.size + 1);
        let size = 0;
        while (size < buffer.length) {
            const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
            if (bytesRead === 0) break;
            size += bytesRead;
        }
        if (size === 0 || size > info.size) throw new Error(message);
        return buffer.subarray(0, size);
    } finally {
        await handle.close();
    }
}

/** Validate before any build tool can empty the output directory. Does not write to disk. */
export async function validateStoreDirectory({ outDir, storeDir }) {
    const dictionaryDir = path.join(storeDir, 'dictionaries');
    const [realOutput, realStore, realDictionaries] = await Promise.all([
        resolveDirectory(outDir),
        resolveDirectory(storeDir),
        resolveDirectory(dictionaryDir),
    ]);
    if (isPathInsideDirectory(outDir, storeDir) || isPathInsideDirectory(realOutput, realStore)) {
        throw new Error('storeDir must be outside outDir so Vite cannot remove dictionary history');
    }
    if (
        isPathInsideDirectory(outDir, dictionaryDir) ||
        isPathInsideDirectory(dictionaryDir, outDir) ||
        isPathInsideDirectory(realOutput, realDictionaries) ||
        isPathInsideDirectory(realDictionaries, realOutput)
    ) {
        throw new Error('outDir must not overlap storeDir/dictionaries so Vite cannot remove dictionary history');
    }
    await confinedPath(storeDir, dictionaryDir);
    await confinedPath(outDir, path.join(outDir, '.cdt'));
}

export function validateKey(key) {
    if (typeof key !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(key)) {
        throw new Error('key must contain 1–100 characters: letters, digits, _, ., or -');
    }
    return key;
}

export function validatePath(value, pattern = false) {
    const allowed = pattern ? /^\/[A-Za-z0-9/_.~*-]*$/ : /^\/[A-Za-z0-9/_.~-]*$/;
    if (
        typeof value !== 'string' ||
        !allowed.test(value) ||
        value.startsWith('//') ||
        value.split('/').some((part) => part === '.' || part === '..')
    ) {
        throw new Error(
            `Invalid ${pattern ? 'match' : 'URL'} path: ${value}. Use an absolute same-origin path; only * is allowed in patterns.`
        );
    }
    return value;
}

export function matches(pattern, pathname) {
    const parts = pattern.split('*');
    if (parts.length === 1) return pattern === pathname;
    const first = parts[0];
    const last = parts[parts.length - 1];
    const end = pathname.length - last.length;
    if (!pathname.startsWith(first) || !pathname.endsWith(last) || end < first.length) return false;
    // Consume literal segments once, without regex backtracking across adjacent wildcards.
    let offset = first.length;
    for (const part of parts.slice(1, -1)) {
        if (!part) continue;
        const index = pathname.indexOf(part, offset);
        if (index === -1 || index + part.length > end) return false;
        offset = index + part.length;
    }
    return true;
}

export async function readJSON(file, fallback, root) {
    try {
        const bytes = await readBoundedFile(
            await confinedPath(root, file),
            MAX_METADATA,
            `Metadata must be a nonempty regular file no larger than 64 MiB: ${file}`
        );
        const value = JSON.parse(bytes.toString('utf8'));
        if (value.schemaVersion !== 1) throw new Error(`Unsupported schema: ${file}`);
        return value;
    } catch (error) {
        if (error.code === 'ENOENT' && fallback !== undefined) return fallback;
        throw error;
    }
}

export async function writeFileAtomically(filePath, content, rootDirectory) {
    const destinationPath = await confinedPath(rootDirectory, filePath);
    const destinationDirectory = path.dirname(destinationPath);
    await mkdir(destinationDirectory, { recursive: true });

    // Keep staging on the destination filesystem and clean up only the directory this write owns.
    const temporaryDirectory = await mkdtemp(path.join(destinationDirectory, '.cdt-write-'));
    try {
        const temporaryPath = path.join(temporaryDirectory, 'content');
        await writeFile(temporaryPath, content);
        await rename(temporaryPath, destinationPath);
    } finally {
        await rm(temporaryDirectory, { recursive: true, force: true });
    }
}

export async function writeJSON(file, value, root) {
    const bytes = `${JSON.stringify(value, null, 2)}\n`;
    if (Buffer.byteLength(bytes) > MAX_METADATA) throw new Error(`Metadata exceeds the 64 MiB limit: ${file}`);
    return writeFileAtomically(file, bytes, root);
}

// Serialize callers within a process; reject overlapping processes instead of losing updates.
const queues = new Map();
async function withDirectoryLock(key, label, callback) {
    const previous = queues.get(key) ?? Promise.resolve();
    const task = previous
        .catch(() => {})
        .then(async () => {
            const lockPath = path.join(key, '.write.lock');
            let lock;
            try {
                lock = await open(lockPath, 'wx');
            } catch (error) {
                if (error.code === 'EEXIST')
                    throw new Error(
                        `${label} is busy: ${lockPath}. Serialize builds. After a crash, remove the lock only when no build is active.`,
                        { cause: error }
                    );
                throw error;
            }
            try {
                await lock.writeFile(String(process.pid));
                return await callback();
            } finally {
                try {
                    await lock.close();
                } finally {
                    await rm(lockPath, { force: true });
                }
            }
        });
    queues.set(key, task);
    try {
        return await task;
    } finally {
        if (queues.get(key) === task) queues.delete(key);
    }
}

async function withLocks(resources, callback) {
    const directories = new Map();
    for (const [root, file, label] of resources) {
        const directory = await confinedPath(root, file);
        await mkdir(directory, { recursive: true });
        directories.set(await realpath(directory), label);
    }
    // Canonical paths share a queue even through symlinks. A fixed order avoids deadlocks.
    const keys = [...directories.keys()].sort();
    const acquire = (index) =>
        index === keys.length
            ? callback()
            : withDirectoryLock(keys[index], directories.get(keys[index]), () => acquire(index + 1));
    return acquire(0);
}

export function withStoreLock(storeDir, callback) {
    return withLocks([[storeDir, storeDir, 'Store']], callback);
}

export function withOutputLock(outDir, callback) {
    return withLocks([[outDir, path.join(outDir, '.cdt'), 'Output']], callback);
}

export function withExportLock(targetDir, callback) {
    return withLocks([[targetDir, targetDir, 'Export']], callback);
}

export function withAssetLocks(storeDir, outDir, callback) {
    return withLocks(
        [
            [storeDir, storeDir, 'Store'],
            [outDir, path.join(outDir, '.cdt'), 'Output'],
        ],
        callback
    );
}

/** Asset responses must remain eligible for dictionary reuse under HTTP freshness rules. */
export function validateDictionaryCacheControl(value) {
    if (typeof value !== 'string' || /[\r\n]/.test(value)) {
        throw new Error('Invalid Cache-Control');
    }
    const directives = new Map();
    for (const part of value.split(',')) {
        const [name, ...rest] = part.trim().toLowerCase().split('=');
        if (directives.has(name)) {
            throw new Error('Duplicate Cache-Control directive: ' + name);
        }
        directives.set(name, rest.join('='));
    }
    const seconds = (name) => {
        const text = directives.get(name)?.replace(/^"([0-9]+)"$/, '$1');
        return /^[0-9]+$/.test(text ?? '') ? Number(text) : 0;
    };
    if (
        directives.has('no-store') ||
        directives.has('no-cache') ||
        !(seconds('max-age') > 0 || (!directives.has('must-revalidate') && seconds('stale-while-revalidate') > 0))
    ) {
        throw new Error(
            'Asset dictionary cacheControl must allow reuse: use positive max-age on versioned URLs, or dictionaryDelivery separate'
        );
    }
}
