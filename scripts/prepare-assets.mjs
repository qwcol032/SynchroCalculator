import { mkdir, copyFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
await mkdir('public/solver', { recursive: true });

await copyFile(require.resolve('highs').replace(/build\/highs.js$/, 'LICENSE'), 'public/solver/LICENSE.txt');
