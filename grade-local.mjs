// Local grade: run main.ts on a trial instance's checks and compare with reference/expected.json.
// usage: node grade-local.mjs <trial-dir>  (trial dir holds input/env/checks.json and reference/expected.json)
import { readFileSync } from 'node:fs';
import { runCheck } from './runner.ts';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node grade-local.mjs <trial-dir>');
  process.exit(2);
}
const { checks } = JSON.parse(readFileSync(`${dir}/input/env/checks.json`, 'utf8'));
const exp = JSON.parse(readFileSync(`${dir}/reference/expected.json`, 'utf8'));
const want = new Map(exp.checks.map((c) => [c.id, c]));
let pass = 0;
const bad = [];
for (const c of checks) {
  const w = want.get(c.id);
  const got = runCheck({ id: c.id, argv: c.argv, stdin: c.stdin ?? null, files: c.files ?? {} });
  const wfiles = { ...(w.files ?? {}) };
  for (const [k, v] of Object.entries(w.changes ?? {})) {
    if (v === null) delete wfiles[k];
    else wfiles[k] = v;
  }
  const why = [];
  if (got.exit !== w.exit) why.push(`exit ${got.exit} != ${w.exit}`);
  if (got.stdout !== w.stdout) why.push(`stdout ${JSON.stringify(got.stdout)} != ${JSON.stringify(w.stdout)}`);
  for (const p of new Set([...Object.keys(wfiles), ...Object.keys(got.files)])) {
    if (got.files[p] === undefined) why.push(`${p} missing`);
    else if (wfiles[p] === undefined) why.push(`${p} should not exist`);
    else if (got.files[p] !== wfiles[p]) why.push(`${p} differs`);
  }
  if (why.length === 0) pass += 1;
  else bad.push(`${c.id}(${why.join('; ')})`);
}
console.log(`${pass} of ${checks.length} passed: trial score ${Math.round((1000 * pass) / checks.length)}`);
if (bad.length > 0) console.log(bad.join('\n'));
