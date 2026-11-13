import { buildProduct } from './product/build.mjs';
import { releases } from './product/releases.mjs';
import { startPlayground } from './server.mjs';

for (const version of Object.keys(releases)) await buildProduct(version);
await startPlayground();
