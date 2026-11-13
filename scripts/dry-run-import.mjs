#!/usr/bin/env node
// Strictly offline, conservative private-source migration preflight.
// Default stdout has aggregate counts only; never echo a sermon title or raw row.
import { readFile, writeFile, realpath } from 'node:fs/promises';
import { resolve, sep, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

export { parseCsv, normalizeDate, inspectHistory } from '../src/import/normalizer.mjs';
import { inspectHistory } from '../src/import/normalizer.mjs';

export async function preflightFile(input, tab = 'All History') {
  const stat = await readFile(input);
  if (stat.byteLength > 10 * 1024 * 1024) throw new Error('Source exceeds 10 MiB safety limit');
  return inspectHistory(stat.toString('utf8'), { tab });
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!['--input','--tab','--private-output'].includes(key) || !argv[i + 1]) {
      throw new Error('Usage: --input /private/history.csv [--tab "All History"] [--private-output /private/review.json]');
    }
    out[key.slice(2)] = argv[++i];
  }
  if (!out.input) throw new Error('Missing --input');
  return out;
}

export async function main(argv) {
  const args = parseArgs(argv);
  const result = await preflightFile(args.input, args.tab || 'All History');
  if (args['private-output']) {
    const path = resolve(args['private-output']);
    const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
    const parent = await realpath(dirname(path));
    const canonicalOutput = resolve(parent, basename(path));
    if (canonicalOutput === repo || canonicalOutput.startsWith(repo + sep)) {
      throw new Error('Refusing to write private review data inside the public source repository');
    }
    await writeFile(canonicalOutput, JSON.stringify(result, null, 2), { mode: 0o600, flag: 'wx' });
  }
  // Avoid source titles, venues, row contents, and source paths in logs.
  console.log(JSON.stringify({ ...result.summary, source_sha256: result.summary.source_sha256.slice(0, 12) }, null, 2));
  return result.summary;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch(err => {
    console.error('Import preflight failed: ' + (err instanceof Error ? err.message : 'unknown error'));
    process.exitCode = 1;
  });
}
