import { createDictionaryServer } from 'compression-dictionary-toolkit/server';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { versions, releaseDirectory } from './project.mjs';

export async function startServer({ version = 'v1', port = 0 } = {}) {
    if (!versions.includes(version)) throw new Error('Use v1, v2, v3, or v4');
    let active = version;
    const server = createDictionaryServer({
        root: () => releaseDirectory(active),
        allowInsecureLocalhost: true,
        serverTiming: true,
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
    });
    return {
        server,
        origin: 'http://localhost:' + server.address().port,
        setVersion(next) {
            if (!versions.includes(next)) throw new Error('Unknown version');
            active = next;
        },
        close: () =>
            new Promise((resolve) => {
                server.close(resolve);
                server.closeAllConnections();
            }),
    };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const { values } = parseArgs({
        options: { version: { type: 'string', default: 'v1' }, port: { type: 'string', default: '4180' } },
    });
    const { origin } = await startServer({ version: values.version, port: Number(values.port) });
    console.log('Serving ' + values.version + ' at ' + origin);
}
