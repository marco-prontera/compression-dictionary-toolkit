import { spawn } from 'node:child_process';
import { readBoundedFile, sha256 } from './utils.js';

export const DCZ_MAGIC = Buffer.from([0x5e, 0x2a, 0x4d, 0x18, 0x20, 0, 0, 0]);
export const DCB_MAGIC = Buffer.from([0xff, 0x44, 0x43, 0x42]);
const MAX_OUTPUT = 128 * 1024 * 1024;

function runCodec(name, args, input, binary) {
    const executable = binary ?? (name === 'zstd' ? process.env.ZSTD_BIN : process.env.BROTLI_BIN) ?? name;
    const setup =
        name === 'zstd'
            ? 'Install Zstandard >=1.5.5 or set ZSTD_BIN.'
            : 'Install Brotli >=1.1 with -D/--dictionary support or set BROTLI_BIN; see docs/installation.md.';
    return new Promise((resolve, reject) => {
        const child = spawn(executable, args, { shell: false, windowsHide: true });
        const chunks = [];
        let size = 0;
        let stderr = '';
        let failure;
        const timer = setTimeout(() => {
            failure = new Error(`${name}: timed out after 120 seconds`);
            child.kill();
        }, 120_000);
        child.on('error', (error) => {
            clearTimeout(timer);
            reject(new Error(`Cannot run ${name}. ${setup} ${error.message}`, { cause: error }));
        });
        child.stdout.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_OUTPUT) {
                failure = new Error(`${name} output exceeds the 128 MiB limit`);
                child.kill();
            } else chunks.push(chunk);
        });
        child.stderr.on('data', (chunk) => {
            if (stderr.length < 8000) stderr += chunk.toString();
        });
        child.stdin.on('error', (error) => {
            if (error.code !== 'EPIPE') failure = error;
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (failure) reject(failure);
            else if (code !== 0)
                reject(
                    new Error(
                        `${name} exited with code ${code}: ${stderr.trim()}${name === 'brotli' ? `\n${setup}` : ''}`
                    )
                );
            else resolve(Buffer.concat(chunks));
        });
        child.stdin.end(input);
    });
}

export async function compressDcz(input, dictionaryPath, options = {}) {
    const dictionary = await readBoundedFile(dictionaryPath);
    const hash = sha256(dictionary);
    // A trained Zstd dictionary is not an RFC 9842 raw dictionary.
    if (dictionary.subarray(0, 4).equals(Buffer.from([0x37, 0xa4, 0x30, 0xec]))) {
        throw new Error('A trained Zstd dictionary is not supported: provide raw JS/CSS bytes');
    }
    if (options.hash && options.hash !== hash) throw new Error('Hash does not match the dictionary bytes');
    const level = options.level ?? 10;
    if (!Number.isInteger(level) || level < 1 || level > 19)
        throw new Error('level must be an integer between 1 and 19');
    const body = await runCodec(
        'zstd',
        ['-q', '-c', `-${level}`, '--single-thread', '--no-dictID', '--zstd=wlog=23', '-D', dictionaryPath],
        Buffer.from(input),
        options.zstdBinary
    );
    return Buffer.concat([DCZ_MAGIC, Buffer.from(hash, 'hex'), body]);
}

export async function decompressDcz(input, dictionaryPath, options = {}) {
    const bytes = Buffer.from(input);
    if (bytes.length < 44 || !bytes.subarray(0, 8).equals(DCZ_MAGIC)) throw new Error('Invalid dcz header');
    const hash = sha256(await readBoundedFile(dictionaryPath));
    if (!bytes.subarray(8, 40).equals(Buffer.from(hash, 'hex'))) throw new Error('Dictionary hash mismatch');
    return runCodec(
        'zstd',
        ['-q', '-d', '-c', '-M128MB', '-D', dictionaryPath],
        bytes.subarray(40),
        options.zstdBinary
    );
}

/** RFC 9842: 4-byte magic + raw dictionary SHA-256 + Shared Brotli stream. */
export async function compressDcb(input, dictionaryPath, options = {}) {
    const dictionary = await readBoundedFile(dictionaryPath);
    const hash = sha256(dictionary);
    if (options.hash && options.hash !== hash) throw new Error('Hash does not match the dictionary bytes');
    const quality = options.quality ?? 9;
    if (!Number.isInteger(quality) || quality < 0 || quality > 11)
        throw new Error('quality must be an integer between 0 and 11');
    // lgwin=24: standard Shared Brotli window, at most 16 MiB. No large-window extension.
    const body = await runCodec(
        'brotli',
        ['-c', '-q', String(quality), '-w', '24', '-D', dictionaryPath],
        Buffer.from(input),
        options.brotliBinary
    );
    return Buffer.concat([DCB_MAGIC, Buffer.from(hash, 'hex'), body]);
}

export async function decompressDcb(input, dictionaryPath, options = {}) {
    const bytes = Buffer.from(input);
    if (bytes.length < 37 || !bytes.subarray(0, 4).equals(DCB_MAGIC)) throw new Error('Invalid dcb header');
    // This reserved WBITS prefix selects the CLI's large-window extension, outside RFC 9842's 16 MiB limit.
    if ((bytes[36] & 0x7f) === 0x11) throw new Error('Unsupported dcb Brotli window: large-window extension');
    const hash = sha256(await readBoundedFile(dictionaryPath));
    if (!bytes.subarray(4, 36).equals(Buffer.from(hash, 'hex'))) throw new Error('Dictionary hash mismatch');
    return runCodec('brotli', ['-d', '-c', '-D', dictionaryPath], bytes.subarray(36), options.brotliBinary);
}
