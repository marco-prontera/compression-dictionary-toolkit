import zlib from 'node:zlib';
import { syncBuiltinESMExports } from 'node:module';

// Model a runtime upgrade at the native codec boundary, without requiring two Node installations.
// Both encoders still produce real streams, but different valid bytes for the same input.
const gzip = zlib.gzip;
const brotliCompress = zlib.brotliCompress;
zlib.gzip = (input, options, callback) => gzip(input, { ...options, level: 1 }, callback);
zlib.brotliCompress = (input, options, callback) =>
    brotliCompress(
        input,
        {
            ...options,
            params: { ...options.params, [zlib.constants.BROTLI_PARAM_QUALITY]: 4 },
        },
        callback
    );
syncBuiltinESMExports();

const { prepareAsset } = await import('compression-dictionary-toolkit');
console.log(JSON.stringify(await prepareAsset(JSON.parse(process.argv[2]))));
