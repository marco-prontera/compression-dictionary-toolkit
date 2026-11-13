import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const directory = fileURLToPath(new URL('.', import.meta.url));
export const results = path.join(directory, 'test-results');
export const versions = ['v1', 'v2', 'v3', 'v4'];
export const store = path.join(results, 'store');
export const releaseDirectory = (version) => path.join(results, 'releases', version);
export const packageRoot = path.join(directory, 'node_modules/compression-dictionary-toolkit');
const resolved = fileURLToPath(import.meta.resolve('compression-dictionary-toolkit'));
assert.ok(
    resolved.startsWith(packageRoot + path.sep),
    'Install the package in this consumer; repository self-imports are not allowed'
);
export const metadata = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
export async function report(section, value) {
    await mkdir(results, { recursive: true });
    const file = path.join(results, 'report-' + metadata.version + '.json');
    const previous = await readFile(file, 'utf8')
        .then(JSON.parse)
        .catch((error) => {
            if (error.code !== 'ENOENT') throw error;
            return {};
        });
    await writeFile(
        file,
        JSON.stringify(
            { ...previous, package: metadata.name, version: metadata.version, node: process.version, [section]: value },
            null,
            4
        ) + '\n'
    );
    console.log('Report: test-results/report-' + metadata.version + '.json');
}
