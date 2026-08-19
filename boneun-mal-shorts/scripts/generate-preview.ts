import path from 'node:path';
import { spawn } from 'node:child_process';
import { P } from '../src/util/paths.js';

// Convenience wrapper: the preview render, with placeholders where a verified
// KSL clip is still missing. Same pipeline, never a fake sign.
//   npx tsx scripts/generate-preview.ts --topic "커피"

const args = process.argv.slice(2);
if (!args.includes('--preview')) args.push('--preview');

const child = spawn(process.execPath, [
  path.join(P.root, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
  path.join(P.root, 'src', 'index.ts'),
  ...args,
], { stdio: 'inherit' });

child.on('exit', (code) => process.exit(code ?? 1));
