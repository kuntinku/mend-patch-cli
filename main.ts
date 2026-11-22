// main.ts is mend, the CLI SPEC.md specifies. Node 22, standard library alone.
// It reads a patch in one of four formats (unified diff, SEARCH/REPLACE, V4A, JSON edits),
// matches the lines each edit names at the first of three tiers, and writes every change
// or none. In a trial (MAKEFUN_ENV_URL set) it hands over to runner.ts, as the kit ships it.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

// ---- file lines (SPEC.md section 3) ----

/** A file's text as lines with its own line break and final-break flag. */
interface FileText {
  lines: string[];
  br: string;
  final: boolean;
}
function splitFile(text: string): FileText {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  let lines: string[];
  let final: boolean;
  if (nl < 0) {
    lines = [text];
    final = false;
  } else {
    lines = text.split(br);
    final = text.endsWith(br);
    if (final) lines.pop();
  }
  return { lines, br, final };
}
function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

const isSpaceTab = (c: string): boolean => c === ' ' || c === '\t';
function leading(s: string): string {
  let i = 0;
  while (i < s.length && isSpaceTab(s[i]!)) i += 1;
  return s.slice(0, i);
}
function trimTrailing(s: string): string {
  let e = s.length;
  while (e > 0 && isSpaceTab(s[e - 1]!)) e -= 1;
  return s.slice(0, e);
}

// ---- matching (SPEC.md section 5) ----

type TierFn = (s: string) => string;
const TIERS: TierFn[] = [(s) => s, (s) => trimTrailing(s), (s) => s.trim()];

/** All positions where O matches the file's lines at the given tier. */
function occAt(file: string[], o: string[], tier: number): number[] {
  const f = TIERS[tier]!;
  const out: number[] = [];
  const fo = file.map(f);
  const oo = o.map(f);
  outer: for (let i = 0; i + oo.length <= fo.length; i += 1) {
    for (let j = 0; j < oo.length; j += 1) if (fo[i + j] !== oo[j]) continue outer;
    out.push(i);
  }
  return out;
}
/** The first tier (0,1,2 or 0 only when strict) at which O occurs, with its positions. */
function findTier(file: string[], o: string[], strict: boolean): { tier: number; pos: number[] } | null {
  const top = strict ? 1 : 3;
  for (let t = 0; t < top; t += 1) {
    const pos = occAt(file, o, t);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}
/** One line of N: either a context line (index into O's context order) or a new line. */
type NLine = { ctx: number } | { new: string };
/** O's index of each context line, in order. */
function ctxOIdx(o: { text: string; ctx: boolean }[]): number[] {
  const out: number[] = [];
  o.forEach((l, i) => {
    if (l.ctx) out.push(i);
  });
  return out;
}
function buildN(n: NLine[], ctxIdx: number[], file: string[], pos: number, o: string[], tier: number): string[] {
  if (tier !== 2) return n.map((l) => (l.ctx === undefined ? (l as { new: string }).new : file[pos + ctxIdx[l.ctx]!]!));
  const F = file.length > 0 ? leading(file[pos]!) : '';
  const P = o.length > 0 ? leading(o[0]!) : '';
  return n.map((l) => {
    if (l.ctx !== undefined) return file[pos + ctxIdx[l.ctx]!]!;
    let s = (l as { new: string }).new;
    if (s.trim() === '') return s;
    if (s.startsWith(P)) s = F + s.slice(P.length);
    return s;
  });
}

// ---- the tree (as the starter ships it, plus move tracking) ----

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** move edits that succeeded: new path -> old path */
  readonly moves = new Map<string, string>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  /** The current lines of p; null when p does not exist. */
  file(p: string): FileText | null {
    const t = this.get(p);
    return t === null ? null : splitFile(t);
  }
  setFile(p: string, ft: FileText): void {
    this.now.set(p, joinFile(ft.lines, ft.br, ft.final));
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---- JSON edits (section 9), as the starter ships it ----

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- unified diffs (section 6) ----

interface Hunk {
  a: number;
  body: { kind: 'ctx' | 'old' | 'new' | 'bs'; text: string }[];
}
interface Section {
  oldPath: string | null;
  newPath: string | null;
  creation: boolean;
  deletion: boolean;
  move: boolean;
  hunks: Hunk[];
}

function gitPaths(line: string, n: number): { x: string; y: string } {
  const rest = line.slice('diff --git '.length);
  const at = rest.lastIndexOf(' b/');
  const m = /^a\/.* b\/.*$/.test(rest) && at > 2;
  if (!m) throw new Exit2(`error: parse ${n}`);
  return { x: rest.slice(2, at), y: rest.slice(at + 3) };
}

function afterPrefix(p: string): string {
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}
function headerPath(rest: string): string | null {
  const upTo = rest.split('\t')[0]!;
  const t = upTo.trim();
  return t === '/dev/null' ? null : afterPrefix(t);
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHunks = false;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const { x, y } = gitPaths(l, i + 1);
      cur = { oldPath: x, newPath: y, creation: false, deletion: false, move: x !== y, hunks: [] };
      sections.push(cur);
      inHunks = false;
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ') && (cur === null || cur.hunks.length > 0)) {
      const op = headerPath(l.slice(4));
      const np = headerPath(lines[i + 1]!.slice(4));
      cur = { oldPath: op, newPath: np, creation: op === null, deletion: np === null, move: op !== null && np !== null && op !== np, hunks: [] };
      sections.push(cur);
      inHunks = false;
      i += 2;
      continue;
    }
    if (cur !== null && !inHunks) {
      // section header
      if (l.startsWith('--- ') && !(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('--- ')) {
        const op = headerPath(l.slice(4));
        const np = headerPath(lines[i + 1]!.slice(4));
        cur.oldPath = op;
        cur.newPath = np;
        cur.creation = op === null;
        cur.deletion = np === null;
        cur.move = op !== null && np !== null && op !== np;
        i += 2;
        continue;
      }
      const rm = l.match(/^rename (from|to) (.*)$/);
      if (rm) {
        const p = rm[2]!.trim();
        if (rm[1] === 'from') {
          if (cur.oldPath === null || cur.oldPath === cur.newPath) {
            cur.oldPath = p;
            cur.move = cur.newPath !== null && cur.newPath !== p;
          }
        } else {
          if (cur.newPath === null || cur.oldPath === cur.newPath) {
            cur.newPath = p;
            cur.move = cur.oldPath !== null && cur.oldPath !== p;
          }
        }
        i += 1;
        continue;
      }
      if (l.startsWith('new file mode')) {
        cur.creation = true;
        i += 1;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        cur.deletion = true;
        i += 1;
        continue;
      }
      if (l.startsWith('@@')) {
        const h = hunkHeader(l, i + 1);
        cur.hunks.push(h);
        inHunks = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    if (cur !== null && inHunks) {
      if (l.startsWith('@@')) {
        const h = hunkHeader(l, i + 1);
        cur.hunks.push(h);
        i += 1;
        continue;
      }
      if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\') || l === '') {
        cur.hunks[cur.hunks.length - 1]!.body.push(bodyLine(l));
        i += 1;
        continue;
      }
      // a body-ending other line: prose, ignored
      inHunks = false;
      i += 1;
      continue;
    }
    i += 1;
  }
  // trim trailing empty lines of each hunk body, then build edits
  if (sections.length === 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  for (const s of sections) {
    for (const h of s.hunks) {
      while (h.body.length > 0 && h.body[h.body.length - 1]!.kind === 'ctx' && h.body[h.body.length - 1]!.text === '') h.body.pop();
    }
    edits.push(unifiedEdit(s, strict));
  }
  return edits;
}

function bodyLine(l: string): { kind: 'ctx' | 'old' | 'new' | 'bs'; text: string } {
  if (l === '') return { kind: 'ctx', text: '' };
  if (l.startsWith('\\')) return { kind: 'bs', text: l };
  return { kind: l[0] === ' ' ? 'ctx' : l[0] === '-' ? 'old' : 'new', text: l.slice(1) };
}

function hunkHeader(l: string, n: number): Hunk {
  const m = l.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
  if (!m) throw new Exit2(`error: parse ${n}`);
  return { a: parseInt(m[1]!, 10), body: [] };
}

function applyHunks(path: string, ft: FileText, hunks: Hunk[], strict: boolean): void {
  let d = 0;
  for (const h of hunks) {
    const o: { text: string; ctx: boolean }[] = [];
    const n: NLine[] = [];
    const ctxN: number[] = [];
    let ctxCount = 0;
    for (const b of h.body) {
      if (b.kind === 'ctx') {
        o.push({ text: b.text, ctx: true });
        n.push({ ctx: ctxCount });
        ctxCount += 1;
      } else if (b.kind === 'old') o.push({ text: b.text, ctx: false });
      else if (b.kind === 'new') n.push({ new: b.text });
    }
    const ctxIdx = ctxOIdx(o);
    const oLines = o.map((x) => x.text);
    let pos: number;
    let endAtEof = false;
    if (oLines.length === 0) {
      pos = Math.min(h.a + d, ft.lines.length);
      endAtEof = pos === ft.lines.length;
      const ins = buildN(n, ctxIdx, ft.lines, 0, oLines, 0);
      ft.lines.splice(pos, 0, ...ins);
      d += ins.length;
    } else {
      const f = findTier(ft.lines, oLines, strict);
      if (f === null) throw new Fail('no-match', path);
      let best = f.pos[0]!;
      const target = h.a - 1 + d;
      for (const p of f.pos) if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      pos = best;
      endAtEof = pos + oLines.length === ft.lines.length;
      const ins = buildN(n, ctxIdx, ft.lines, pos, oLines, f.tier);
      ft.lines.splice(pos, oLines.length, ...ins);
      d += ins.length - oLines.length;
    }
    if (endAtEof) {
      const last = lastCtxOrNew(h.body);
      const bs = hasBackslashAfter(h.body, last);
      ft.final = !bs;
    }
  }
}

function lastCtxOrNew(body: { kind: string }[]): number {
  for (let i = body.length - 1; i >= 0; i -= 1) if (body[i]!.kind === 'ctx' || body[i]!.kind === 'new') return i;
  return -1;
}
function hasBackslashAfter(body: { kind: string }[], after: number): boolean {
  for (let i = after + 1; i < body.length; i += 1) if (body[i]!.kind === 'bs') return true;
  return false;
}

function unifiedEdit(s: Section, strict: boolean): Edit {
  return (tree: Tree) => {
    if (s.creation) {
      const p = s.newPath!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let bsAfterLastPlus = false;
      for (const h of s.hunks) {
        for (const b of h.body) {
          if (b.kind === 'new') plus.push(b.text);
          else if (b.kind === 'bs') bsAfterLastPlus = true;
        }
      }
      // a `\` line follows the last `+` line only when it comes after it and nothing else
      const all: { kind: string }[] = s.hunks.flatMap((h) => h.body);
      const lastPlus = (() => {
        for (let i = all.length - 1; i >= 0; i -= 1) if (all[i]!.kind === 'new') return i;
        return -1;
      })();
      const final = !hasBackslashAfter(all as { kind: string }[], lastPlus);
      tree.now.set(p, plus.length === 0 && !final ? '' : plus.join('\n') + (final ? '\n' : ''));
      return;
    }
    const old = s.oldPath!;
    if (!safe(old)) throw new Fail('unsafe', old);
    const ft = tree.file(old);
    if (ft === null) throw new Fail('missing', old);
    if (s.deletion) {
      tree.now.set(old, null);
      return;
    }
    const np = s.newPath!;
    if (s.move) {
      if (!safe(np)) throw new Fail('unsafe', np);
      if (tree.get(np) !== null) throw new Fail('exists', np);
    }
    applyHunks(old, ft, s.hunks, strict);
    if (s.move) {
      tree.now.set(old, null);
      tree.now.set(np, joinFile(ft.lines, ft.br, ft.final));
      tree.moves.set(np, old);
    } else {
      tree.setFile(old, ft);
    }
  };
}

// ---- SEARCH/REPLACE blocks (section 7) ----

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevReplace = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') continue;
    // path: nearest qualifying line before the SEARCH line, after the previous block
    let path: string | null = null;
    for (let j = i - 1; j > prevReplace; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${i + 1}`);
    // old lines to =======
    let sep = -1;
    let end = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        sep = j;
        break;
      }
    }
    if (sep < 0) throw new Exit2(`error: parse ${i + 1}`);
    for (let j = sep + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${i + 1}`);
    const oldLines = lines.slice(i + 1, sep);
    const newLines = lines.slice(sep + 1, end);
    prevPath = path;
    prevReplace = end;
    edits.push(srEdit(path, oldLines, newLines, strict));
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function srEdit(p: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree: Tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (oldLines.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const ft = tree.file(p);
    if (ft === null) throw new Fail('missing', p);
    const f = findTier(ft.lines, oldLines, strict);
    if (f === null) throw new Fail('no-match', p);
    if (f.pos.length > 1) throw new Fail('ambiguous', p);
    const pos = f.pos[0]!;
    const n = newLines.map((s) => ({ new: s }) as NLine);
    const ins = buildN(n, [], ft.lines, pos, oldLines, f.tier);
    ft.lines.splice(pos, oldLines.length, ...ins);
    tree.setFile(p, ft);
  };
}

// ---- V4A patches (section 8) ----

interface Chunk {
  anchor: string | null;
  eof: boolean;
  body: { kind: 'ctx' | 'old' | 'new'; text: string }[];
}
type V4ASection =
  | { kind: 'add'; path: string; lines: string[] }
  | { kind: 'del'; path: string }
  | { kind: 'upd'; path: string; moveTo: string | null; chunks: Chunk[] };

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1)
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4ASection[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    let m = l.match(/^\*\*\* Add File: (.*)$/);
    if (m) {
      const p = m[1]!.trim();
      const body: string[] = [];
      i += 1;
      while (i < last) {
        const b = lines[i]!;
        if (b.startsWith('*** ')) break;
        if (b === '' || b.startsWith('+')) {
          body.push(b);
          i += 1;
        } else throw new Exit2(`error: parse ${i + 1}`);
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      sections.push({ kind: 'add', path: p, lines: body.map((b) => (b === '' ? '' : b.slice(1))) });
      continue;
    }
    m = l.match(/^\*\*\* Delete File: (.*)$/);
    if (m) {
      const p = m[1]!.trim();
      i += 1;
      while (i < last && blank(lines[i]!)) i += 1;
      sections.push({ kind: 'del', path: p });
      continue;
    }
    m = l.match(/^\*\*\* Update File: (.*)$/);
    if (m) {
      const p = m[1]!.trim();
      const updLine = i + 1;
      i += 1;
      let moveTo: string | null = null;
      const mm = lines[i]?.match(/^\*\*\* Move to: (.*)$/);
      if (mm) {
        moveTo = mm[1]!.trim();
        i += 1;
      }
      const chunks: Chunk[] = [];
      while (i < last) {
        const b = lines[i]!;
        if (b.trim() === '*** End of File') {
          if (chunks.length === 0) throw new Exit2(`error: parse ${i + 1}`);
          {
            const bb = chunks[chunks.length - 1]!.body;
            while (bb.length > 0 && bb[bb.length - 1]!.kind === 'ctx' && bb[bb.length - 1]!.text.trim() === '') bb.pop();
          }
          chunks[chunks.length - 1]!.eof = true;
          i += 1;
          continue;
        }
        if (b.startsWith('*** ')) {
          if (chunks.length > 0) {
            const bb = chunks[chunks.length - 1]!.body;
            while (bb.length > 0 && bb[bb.length - 1]!.kind === 'ctx' && bb[bb.length - 1]!.text.trim() === '') bb.pop();
          }
          break;
        }
        if (b.startsWith('@@')) {
          if (chunks.length > 0) {
            const bb = chunks[chunks.length - 1]!.body;
            while (bb.length > 0 && bb[bb.length - 1]!.kind === 'ctx' && bb[bb.length - 1]!.text.trim() === '') bb.pop();
          }
          const anchor = b.slice(2).trim();
          chunks.push({ anchor: anchor === '' ? null : anchor, eof: false, body: [] });
          i += 1;
          continue;
        }
        if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+')) {
          if (chunks.length === 0) chunks.push({ anchor: null, eof: false, body: [] });
          chunks[chunks.length - 1]!.body.push({ kind: b === '' ? 'ctx' : (b[0] as ' ' | '-' | '+') === ' ' ? 'ctx' : (b[0] === '-' ? 'old' : 'new'), text: b === '' ? '' : b.slice(1) });
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      if (chunks.length > 0) {
        const bb = chunks[chunks.length - 1].body;
        while (bb.length > 0 && bb[bb.length - 1].kind === 'ctx' && bb[bb.length - 1].text.trim() === '') bb.pop();
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updLine}`);
      sections.push({ kind: 'upd', path: p, moveTo, chunks });
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => v4aEdit(s, strict));
}

function v4aEdit(s: V4ASection, strict: boolean): Edit {
  return (tree: Tree) => {
    if (s.kind === 'add') {
      const p = s.path;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, s.lines.length === 0 ? '' : s.lines.join('\n') + '\n');
      return;
    }
    if (s.kind === 'del') {
      const p = s.path;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const p = s.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    const ft = tree.file(p);
    if (ft === null) throw new Fail('missing', p);
    const np = s.moveTo;
    if (np !== null) {
      if (!safe(np)) throw new Fail('unsafe', np);
      if (tree.get(np) !== null) throw new Fail('exists', np);
    }
    let cursor = 0;
    for (const c of s.chunks) {
      if (c.anchor !== null) {
        let found = -1;
        for (let t = 0; t < 3 && found < 0; t += 1) {
          for (let j = cursor; j < ft.lines.length; j += 1) if (TIERS[t](ft.lines[j]!) === TIERS[t](c.anchor)) { found = j; break; }
        }
        if (found < 0) throw new Fail('no-match', p);
        cursor = found + 1;
      }
      const o: { text: string; ctx: boolean }[] = [];
      const n: NLine[] = [];
      let ctxCount = 0;
      for (const b of c.body) {
        if (b.kind === 'ctx') {
          o.push({ text: b.text, ctx: true });
          n.push({ ctx: ctxCount });
          ctxCount += 1;
        } else if (b.kind === 'old') o.push({ text: b.text, ctx: false });
        else n.push({ new: b.text });
      }
      const ctxIdx = ctxOIdx(o);
      const oLines = o.map((x) => x.text);
      const atEof = (pos: number, len: number): boolean => pos + len === ft.lines.length;
      let pos: number;
      if (oLines.length === 0) {
        pos = c.eof ? ft.lines.length : cursor;
        const ins = buildN(n, ctxIdx, ft.lines, 0, oLines, 0);
        ft.lines.splice(pos, 0, ...ins);
        cursor = pos + ins.length;
      } else {
        const start = cursor;
        let found: { pos: number; tier: number } | null = null;
        for (let t = 0; t < 3 && found === null; t += 1) {
          for (let j = start; j + oLines.length <= ft.lines.length; j += 1) {
            if (!c.eof || atEof(j, oLines.length)) {
              let ok = true;
              for (let k = 0; k < oLines.length; k += 1) if (TIERS[t](ft.lines[j + k]!) !== TIERS[t](oLines[k]!)) { ok = false; break; }
              if (ok) {
                found = { pos: j, tier: t };
                break;
              }
            }
          }
        }
        if (found === null) throw new Fail('no-match', p);
        pos = found.pos;
        const ins = buildN(n, ctxIdx, ft.lines, pos, oLines, found.tier);
        ft.lines.splice(pos, oLines.length, ...ins);
        cursor = pos + ins.length;
      }
    }
    if (np !== null) {
      tree.now.set(p, null);
      tree.now.set(np, joinFile(ft.lines, ft.br, ft.final));
      tree.moves.set(np, p);
    } else {
      tree.setFile(p, ft);
    }
  };
}

// ---- run (sections 1, 2, 10) ----

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? parseUnified(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = new Map(tree.moves);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.clear();
      for (const [k, v] of beforeMoves) tree.moves.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0)
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: string[] = [];
  const movedFrom = new Set(tree.moves.values());
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (movedFrom.has(p)) continue; // its D line folds into the move's R line
    const moveOld = tree.moves.get(p);
    if (
      moveOld !== undefined &&
      tree.original(moveOld) !== null &&
      tree.now.get(moveOld) === null &&
      was === null &&
      now !== null
    ) {
      rows.push(`R ${moveOld} -> ${p}`);
      if (check) continue;
      rmSync(moveOld, { force: true });
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
      continue;
    }
    rows.push(`${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
