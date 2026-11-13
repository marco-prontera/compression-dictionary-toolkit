import { build } from 'vite';
import sharedDictionary from 'compression-dictionary-toolkit/vite';

/** Keep test-specific build and plugin settings visible at the call site. */
export function buildVite(fixture, { build: output, ...config } = {}) {
    return build({
        root: fixture.root,
        configFile: false,
        logLevel: 'silent',
        plugins: [sharedDictionary({ storeDir: fixture.storeDir })],
        ...config,
        build: { outDir: fixture.outDir, ...output },
    });
}
