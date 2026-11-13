import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { digestHeader } from 'compression-dictionary-toolkit';
import { encodingQuality, parseAvailableDictionary } from 'compression-dictionary-toolkit/server';

for (const header of ['Accept-Encoding', 'Available-Dictionary'])
    test(`${header} parsing cannot block on malformed whitespace`, async () => {
        // Amplify the same malformed suffix that blocks real 15 KiB requests. Run it in a
        // child so a quadratic-time regression can be killed without blocking the runner.
        const module = import.meta.resolve('compression-dictionary-toolkit/server');
        const { stdout } = await promisify(execFile)(
            process.execPath,
            [
                '--input-type=module',
                '-e',
                `import { encodingQuality, parseAvailableDictionary } from ${JSON.stringify(module)};
                 const padding = ' \\t'.repeat(100_000);
                 const result = ${
                     header === 'Accept-Encoding'
                         ? "encodingQuality('gzip' + padding + '!', 'gzip')"
                         : "parseAvailableDictionary(':' + Buffer.alloc(32).toString('base64') + ':' + padding + '!')"
                 };
                 console.log(JSON.stringify(result));`,
            ],
            { timeout: 5000, killSignal: 'SIGKILL' }
        );
        assert.equal(stdout.trim(), header === 'Accept-Encoding' ? '0' : 'null');
    });

test('Accept-Encoding preserves whitespace, quality, exclusions, and malformed-token handling', () => {
    for (const [header, encoding, expected] of [
        [' \tgzip \t', 'gzip', 1],
        [' \tbr \t; \tq \t= \t0.7 \t, gzip;q=0.5', 'br', 0.7],
        ['gzip;q=0, gzip;q=1', 'gzip', 0],
        ['gzip;q=1.001, br;q=0.8', 'gzip', 0],
        ['gzip   !, br;q=0.8', 'br', 0.8],
        ['gzip \t; q=0.5 !', 'gzip', 0],
        ['*;q=0.4', 'br', 0.4],
        ['*;q=0.4', 'dcb', 0],
        ['*;q=0', 'identity', 0],
        ['', 'identity', 1],
    ])
        assert.equal(encodingQuality(header, encoding), expected, `${header}: ${encoding}`);
});

test('Available-Dictionary accepts padded and unpadded SHA-256 byte sequences', () => {
    const hash = 'ff'.repeat(32);
    const canonical = digestHeader(hash);
    for (const header of [canonical, canonical.replace('=:', ':'), ` \t${canonical}\t `])
        assert.equal(parseAvailableDictionary(header), hash);
});

test('Available-Dictionary tolerates non-zero Base64 pad bits per Structured Fields', () => {
    const hash = 'ff'.repeat(32);
    // The two unused low bits do not change the decoded 32-byte digest.
    const nonCanonical = digestHeader(hash).replace('8=:', '9=:');
    assert.equal(parseAvailableDictionary(nonCanonical), hash);
    assert.equal(parseAvailableDictionary(nonCanonical.replace('=:', ':')), hash);
});

test('Available-Dictionary accepts Structured Fields parameters without changing the digest', () => {
    const hash = 'ab'.repeat(32);
    const canonical = digestHeader(hash);
    const parameters = [
        ';flag',
        ';foo=bar',
        '; count=42;enabled=?1',
        ';empty=""',
        ';message="a;b,c"',
        String.raw`;escaped="quote \" and slash \\"`,
        ';v=-999999999999999',
        ';v=999999999999.999',
        ';v=-0.001',
        ';v=@-62135596800',
        ';v=@253402214400',
        ';v=?0',
        ';v=:aGVsbG8=:',
        ';v=:aGVsbG8:',
        ';v=::',
        ";v=Token/With:punctuation!#$%&'*+-.^_`|~",
        ';*ext_1.foo-bar=*',
        ';v=%"caf%c3%a9"',
        String.raw`;v=%"quote %22 and backslash \"`,
        ';foo;foo=?0;foo="overridden"',
        Array.from({ length: 256 }, (_, i) => `;p${i}=1`).join(''),
    ];
    for (const digest of [canonical, canonical.replace('=:', ':')])
        for (const suffix of parameters)
            assert.equal(parseAvailableDictionary(` \t${digest}${suffix}\t `), hash, suffix);
});

test('Available-Dictionary rejects malformed parameters and trailing field members', () => {
    const canonical = digestHeader('ab'.repeat(32));
    for (const suffix of [
        ';',
        '; ',
        ';Upper=1',
        ';1key=1',
        ';foo=',
        ';foo= bar',
        ';foo =bar',
        ';\tfoo=bar',
        ';foo=bar ;next=1',
        ';flag;;next=1',
        ';v=?2',
        ';v=?10',
        ';v=1000000000000000',
        ';v=-1000000000000000',
        ';v=1000000000000.1',
        ';v=1.1234',
        ';v=1.',
        ';v=+1',
        ';v=@1.5',
        ';v=@1000000000000000',
        ';v=:a:',
        ';v=:====:',
        ';v="unterminated',
        ';v="café"',
        String.raw`;v="invalid \q"`,
        ';v=%"bad%ff"',
        ';v=%"bad%C3%A9"',
        ';v=%"bad%2"',
        ';v=%"café"',
        ';v=(one two)',
        `;flag, ${canonical}`,
        `;flag ${canonical}`,
    ])
        assert.equal(parseAvailableDictionary(canonical + suffix), null, suffix);
    for (const whitespace of ['\n', '\r', '\u00a0']) {
        assert.equal(parseAvailableDictionary(whitespace + canonical), null);
        assert.equal(parseAvailableDictionary(canonical + whitespace), null);
    }
});

test('Available-Dictionary rejects malformed values, multiple hashes, and incorrect digest lengths', () => {
    const canonical = digestHeader('ff'.repeat(32));
    for (const header of [
        undefined,
        null,
        [canonical],
        123,
        '',
        'ff'.repeat(32),
        canonical.slice(1),
        canonical.slice(0, -1),
        canonical.replace('=:', '==:'),
        canonical.replaceAll('/', '_'),
        canonical.replace('/', '!'),
        canonical.replace('/', ' '),
        canonical.replace('/', '\n'),
        `${canonical},${canonical}`,
        `${canonical} ${canonical}`,
        `:${Buffer.alloc(31).toString('base64')}:`,
        `:${Buffer.alloc(33).toString('base64')}:`,
    ])
        assert.equal(parseAvailableDictionary(header), null, String(header));
});
