import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
try {
    console.log(`Node ${process.versions.node}`);
    for (const [name, executable] of [
        ['zstd', process.env.ZSTD_BIN ?? 'zstd'],
        ['brotli', process.env.BROTLI_BIN ?? 'brotli'],
    ]) {
        const version = await exec(executable, ['--version'], { timeout: 10000 });
        console.log((version.stdout + version.stderr).trim());
        if (name === 'brotli') {
            const help = await exec(executable, ['--help'], { timeout: 10000 });
            if (!(help.stdout + help.stderr).includes('--dictionary'))
                throw new Error('This Brotli CLI does not support --dictionary; use Brotli >=1.1, preferably 1.2.0.');
        }
    }
    console.log('dcb and dcz encoders are available. Run npm test for full verification.');
} catch (error) {
    console.error(`${error.message}\nInstallation: docs/installation.md. Custom paths: BROTLI_BIN and ZSTD_BIN.`);
    process.exitCode = 1;
}
