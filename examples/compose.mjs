import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { prepareAsset } from 'compression-dictionary-toolkit';

export async function compose({ partsDir, outDir, storeDir }) {
    const [a, b] = await Promise.all([
        readFile(path.join(partsDir, 'part-a.js'), 'utf8'),
        readFile(path.join(partsDir, 'part-b.js'), 'utf8'),
    ]);
    const content = `${a}\n;\n${b}\n`;
    const hash = createHash('sha256').update(content).digest('hex').slice(0, 12);
    const file = `fixed/composed-${hash}.js`;
    const input = path.join(outDir, file);
    await mkdir(path.dirname(input), { recursive: true });
    // IIFEs are independently scoped. A semicolon also prevents ASI concatenation bugs.
    // Arbitrary ESM chunks cannot safely be concatenated this way.
    await writeFile(input, content);

    // This is deliberately after composition. No dictionary is made for either partial output.
    return prepareAsset({
        input,
        outDir,
        storeDir,
        url: `/${file}`,
        key: 'demo-composed',
        match: '/fixed/composed-*.js',
        dictionaryDelivery: 'asset',
        historyLimit: 3,
    });
}
