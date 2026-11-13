#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createDictionary, prepareAsset, exportRelease } from './index.js';

try {
    const { values, positionals } = parseArgs({
        allowPositionals: true,
        options: {
            'input': { type: 'string' },
            'key': { type: 'string' },
            'match': { type: 'string' },
            'url': { type: 'string' },
            'store-dir': { type: 'string' },
            'out-dir': { type: 'string' },
            'brotli-quality': { type: 'string' },
            'brotli-bin': { type: 'string' },
            'zstd-bin': { type: 'string' },
            'dictionary-policy': { type: 'string' },
            'dictionary-delivery': { type: 'string' },
            'cache-control': { type: 'string' },
            'dictionary-epoch': { type: 'string' },
            'dictionary-input': { type: 'string' },
            'history-limit': { type: 'string' },
            'target-dir': { type: 'string' },
            'release-id': { type: 'string' },
            'base': { type: 'string' },
            'help': { type: 'boolean' },
        },
    });
    if (values.help) {
        console.log(
            'shared-dict <dictionary|prepare> --input app.js --key app --match "/assets/app-*.js" [--url /assets/app-v2.js] [--store-dir .dictionary-store] [--out-dir dist] [--dictionary-delivery asset|separate] [--dictionary-policy stable|rolling] [--dictionary-epoch v1] [--dictionary-input base.js] [--history-limit 3] [--cache-control VALUE] [--brotli-quality 9] [--brotli-bin PATH] [--zstd-bin PATH]\nprepare reuses versioned assets as dictionaries by default; use separate for dedicated bases.'
        );
        console.log('shared-dict export --out-dir dist --target-dir release --release-id build-123 [--base /app/]');
    } else if (positionals[0] === 'export') {
        console.log(
            JSON.stringify(
                await exportRelease({
                    outDir: values['out-dir'],
                    targetDir: values['target-dir'],
                    releaseId: values['release-id'],
                    base: values.base,
                }),
                null,
                2
            )
        );
    } else {
        if (!values.input || !values.key || !['dictionary', 'prepare'].includes(positionals[0]))
            throw new Error('Missing arguments. Run shared-dict --help');
        const options = {
            input: values.input,
            key: values.key,
            match: values.match,
            url: values.url,
            storeDir: values['store-dir'],
            outDir: values['out-dir'],
            brotliQuality: values['brotli-quality'] === undefined ? undefined : Number(values['brotli-quality']),
            brotliBinary: values['brotli-bin'],
            zstdBinary: values['zstd-bin'],
            dictionaryPolicy: values['dictionary-policy'],
            dictionaryDelivery: values['dictionary-delivery'],
            cacheControl: values['cache-control'],
            dictionaryEpoch: values['dictionary-epoch'],
            dictionaryInput: values['dictionary-input'],
            historyLimit: values['history-limit'] === undefined ? undefined : Number(values['history-limit']),
        };
        const result = await (positionals[0] === 'dictionary' ? createDictionary(options) : prepareAsset(options));
        console.log(JSON.stringify(result, null, 2));
    }
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}
