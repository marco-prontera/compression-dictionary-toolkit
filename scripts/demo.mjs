import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const project = fileURLToPath(new URL('..', import.meta.url));

export function buildDemo(version) {
    return new Promise((resolve, reject) => {
        const args = ['playground/product/build.mjs', `--version=${version}`];
        const child = spawn(process.execPath, args, { cwd: project, stdio: 'inherit' });
        child.on('error', reject);
        child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Build ${version}: ${code}`))));
    });
}
