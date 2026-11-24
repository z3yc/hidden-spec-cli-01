// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
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
}

type Edit = ((tree: Tree) => void) & { move?: [string, string] };

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

/** Section 3: a file's lines, its line break and whether it ends with one. */
interface FileModel {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  let final = false;
  if (text.endsWith(br)) {
    lines.pop();
    final = true;
  }
  return { lines, br, final };
}

function joinFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.final ? m.br : '');
}

const leadingWS = (s: string): string => s.match(/^[ \t]*/)?.[0] ?? '';

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  const t = s.replace(/[ \t]+$/, '');
  return tier === 1 ? t : t.replace(/^[ \t]+/, '');
}

function occurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > lines.length) return out;
  const on = o.map((l) => normLine(l, tier));
  for (let i = 0; i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (normLine(lines[i + j]!, tier) !== on[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** One body line of a unified hunk (section 6). `noNL` when a `\` line follows it. */
interface BodyLine {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  noNL: boolean;
  empty: boolean;
}

interface Hunk {
  a: number;
  body: BodyLine[];
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  create: boolean;
  remove: boolean;
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: |$)/;
const DIFF_RE = /^diff --git a\/(\S+) b\/(\S+)$/;

function headerPath(s: string): string {
  const t = s.slice(4).split('\t')[0]!.trim();
  if (t.startsWith('a/')) return t.slice(2);
  if (t.startsWith('b/')) return t.slice(2);
  return t;
}

/** Parse one hunk body starting at lines[i]; returns the index after it. */
function parseHunkBody(lines: string[], i: number, hunk: Hunk): number {
  const n = lines.length;
  const body: BodyLine[] = [];
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') {
      body.push({ kind: 'ctx', text: '', noNL: false, empty: true });
      i += 1;
      continue;
    }
    const c = l[0]!;
    if (c === ' ') {
      body.push({ kind: 'ctx', text: l.slice(1), noNL: false, empty: false });
      i += 1;
    } else if (c === '-') {
      body.push({ kind: 'old', text: l.slice(1), noNL: false, empty: false });
      i += 1;
    } else if (c === '+') {
      body.push({ kind: 'new', text: l.slice(1), noNL: false, empty: false });
      i += 1;
    } else if (c === '\\') {
      if (body.length > 0) body[body.length - 1]!.noNL = true;
      i += 1;
    } else break;
  }
  while (body.length > 0 && body[body.length - 1]!.empty) body.pop();
  hunk.body = body;
  return i;
}

/** Parse one section's header and hunks starting at lines[i]; returns the index after it. */
function parseSection(lines: string[], i: number, sec: Section): number {
  const n = lines.length;
  const parseErr = (lineNo: number): never => {
    throw new Exit2(`error: parse ${lineNo}`);
  };
  let inHeader = true;
  let pairOld: string | null = null;
  let pairNew: string | null = null;
  let renOld: string | null = null;
  let renNew: string | null = null;
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) break;
    if (inHeader) {
      if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        if (pairOld === null) {
          pairOld = headerPath(l);
          pairNew = headerPath(lines[i + 1]!);
        }
        i += 2;
        continue;
      }
      if (l.startsWith('--- ')) parseErr(i + 2);
      if (l.startsWith('rename from ')) {
        if (renOld === null) renOld = l.slice(12).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('rename to ')) {
        if (renNew === null) renNew = l.slice(10).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('new file mode')) {
        sec.create = true;
        i += 1;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        sec.remove = true;
        i += 1;
        continue;
      }
      if (l.startsWith('@@')) {
        const m = HUNK_RE.exec(l);
        if (!m) parseErr(i + 1);
        const hunk: Hunk = { a: parseInt(m[1]!, 10), body: [] };
        sec.hunks.push(hunk);
        inHeader = false;
        i = parseHunkBody(lines, i + 1, hunk);
        continue;
      }
      i += 1;
    } else {
      if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
      if (l.startsWith('@@')) {
        const m = HUNK_RE.exec(l);
        if (!m) parseErr(i + 1);
        const hunk: Hunk = { a: parseInt(m[1]!, 10), body: [] };
        sec.hunks.push(hunk);
        i = parseHunkBody(lines, i + 1, hunk);
        continue;
      }
      i += 1;
    }
  }
  if (pairOld !== null) sec.oldPath = pairOld;
  else if (renOld !== null) sec.oldPath = renOld;
  if (pairNew !== null) sec.newPath = pairNew;
  else if (renNew !== null) sec.newPath = renNew;
  if (sec.oldPath === '/dev/null') sec.oldPath = null;
  if (sec.newPath === '/dev/null') sec.newPath = null;
  return i;
}

/** Apply one hunk to the model; returns N.length - O.length. */
function applyHunk(model: FileModel, hunk: Hunk, d: number, strict: boolean, path: string): number {
  const oEntries = hunk.body.filter((b) => b.kind !== 'new');
  const nEntries = hunk.body.filter((b) => b.kind !== 'old');
  const O = oEntries.map((b) => b.text);
  const N = nEntries.map((b) => b.text);
  const delta = N.length - O.length;
  if (O.length === 0) {
    const pos = Math.min(Math.max(hunk.a + d, 0), model.lines.length);
    model.lines.splice(pos, 0, ...N);
    if (pos + N.length === model.lines.length) {
      const last = nEntries[nEntries.length - 1];
      if (last !== undefined) model.final = !last.noNL;
    }
    return delta;
  }
  let tier = -1;
  let occ: number[] = [];
  for (const t of strict ? [0] : [0, 1, 2]) {
    occ = occurrences(model.lines, O, t);
    if (occ.length > 0) {
      tier = t;
      break;
    }
  }
  if (tier < 0) throw new Fail('no-match', path);
  const target = hunk.a - 1 + d;
  let best = occ[0]!;
  let bestDist = Math.abs(best - target);
  for (const p of occ) {
    const dist = Math.abs(p - target);
    if (dist < bestDist) {
      best = p;
      bestDist = dist;
    }
  }
  const matchPos = best;
  const F = leadingWS(model.lines[matchPos]!);
  const P = leadingWS(O[0]!);
  const oCtxIndices: number[] = [];
  oEntries.forEach((e, idx) => {
    if (e.kind === 'ctx') oCtxIndices.push(idx);
  });
  const repl: string[] = [];
  let ctxCount = 0;
  for (const e of nEntries) {
    if (e.kind === 'ctx') {
      repl.push(model.lines[matchPos + oCtxIndices[ctxCount]!]!);
      ctxCount += 1;
    } else {
      let text = e.text;
      if (tier === 2 && text !== '' && text.trim() !== '' && text.startsWith(P)) text = F + text.slice(P.length);
      repl.push(text);
    }
  }
  const touchesEnd = matchPos + O.length === model.lines.length;
  model.lines.splice(matchPos, O.length, ...repl);
  if (touchesEnd) {
    const last = nEntries[nEntries.length - 1];
    model.final = last === undefined ? true : !last.noNL;
  }
  return delta;
}

function sectionEdit(sec: Section, strict: boolean): Edit {
  const edit: Edit = (tree: Tree) => {
    const isCreate = sec.oldPath === null || sec.create;
    const isDelete = !isCreate && (sec.newPath === null || sec.remove);
    if (isCreate) {
      const p = sec.newPath;
      if (p === null || !safe(p)) throw new Fail('unsafe', p ?? '');
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: BodyLine[] = [];
      for (const h of sec.hunks) for (const b of h.body) if (b.kind === 'new') plus.push(b);
      const lines = plus.map((b) => b.text);
      const fin = plus.length === 0 ? false : !plus[plus.length - 1]!.noNL;
      tree.now.set(p, lines.length === 0 ? '' : lines.join('\n') + (fin ? '\n' : ''));
      return;
    }
    if (isDelete) {
      const p = sec.oldPath!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const oldP = sec.oldPath!;
    const newP = sec.newPath!;
    const isMove = oldP !== newP;
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    if (isMove && !safe(newP)) throw new Fail('unsafe', newP);
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    if (isMove && tree.get(newP) !== null) throw new Fail('exists', newP);
    const model = splitFile(before);
    let d = 0;
    for (const h of sec.hunks) d += applyHunk(model, h, d, strict, oldP);
    const out = joinFile(model);
    if (isMove) {
      tree.now.set(oldP, null);
      tree.now.set(newP, out);
      edit.move = [oldP, newP];
    } else {
      tree.now.set(oldP, out);
    }
  };
  return edit;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = DIFF_RE.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const sec: Section = { oldPath: m[1]!, newPath: m[2]!, create: false, remove: false, hunks: [] };
      i = parseSection(lines, i + 1, sec);
      sections.push(sec);
    } else if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const sec: Section = { oldPath: null, newPath: null, create: false, remove: false, hunks: [] };
      i = parseSection(lines, i, sec);
      sections.push(sec);
    } else if (l.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i += 1;
    }
  }
  return sections.map((s) => sectionEdit(s, strict));
}

/** One line of an old/new pair, with whether it is a context line (section 5). */
interface RL {
  text: string;
  ctx: boolean;
}

/** Replace O at `pos` by N in the model, with the section 5 tier-2 re-indent rule. */
function applyReplace(model: FileModel, pos: number, O: RL[], N: RL[], tier: number): void {
  const F = leadingWS(model.lines[pos]!);
  const P = leadingWS(O[0]!.text);
  const oCtxPos: number[] = [];
  O.forEach((e, idx) => {
    if (e.ctx) oCtxPos.push(idx);
  });
  const repl: string[] = [];
  let ci = 0;
  for (const e of N) {
    if (e.ctx) {
      repl.push(model.lines[pos + oCtxPos[ci]!]!);
      ci += 1;
    } else {
      let t = e.text;
      if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(P)) t = F + t.slice(P.length);
      repl.push(t);
    }
  }
  model.lines.splice(pos, O.length, ...repl);
}

/** First tier with an occurrence of O at or after `from` (end-of-file only when `eof`). */
function findTier(lines: string[], O: string[], strict: boolean, from: number, eof = false): { tier: number; occ: number[] } | null {
  for (const t of strict ? [0] : [0, 1, 2]) {
    let occ = occurrences(lines, O, t).filter((p) => p >= from);
    if (eof) occ = occ.filter((p) => p + O.length === lines.length);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

function srEdit(p: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree: Tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (oldLines.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const model = splitFile(before);
    const found = findTier(model.lines, oldLines, strict, 0);
    if (found === null) throw new Fail('no-match', p);
    if (found.occ.length > 1) throw new Fail('ambiguous', p);
    applyReplace(
      model,
      found.occ[0]!,
      oldLines.map((t) => ({ text: t, ctx: false })),
      newLines.map((t) => ({ text: t, ctx: false })),
      found.tier,
    );
    tree.now.set(p, joinFile(model));
  };
}

/** Parse SEARCH/REPLACE blocks (section 7) into edits. */
function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i + 1;
    let p: string | null = null;
    for (let j = i - 1; j > prevEnd; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      p = t;
      break;
    }
    if (p === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
      p = prevPath;
    }
    let eq = -1;
    for (let j = i + 1; j < n; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine}`);
    let rep = -1;
    for (let j = eq + 1; j < n; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine}`);
    edits.push(srEdit(p, lines.slice(i + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = p;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

interface VChunk {
  anchor: string | null;
  body: { kind: 'ctx' | 'old' | 'new'; text: string }[];
  eof: boolean;
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  lines: string[];
  chunks: VChunk[];
  lineNo: number;
}

/** Apply one V4A chunk to the model; returns the cursor just after the lines written. */
function applyVChunk(model: FileModel, ch: VChunk, cursor: number, strict: boolean, path: string): number {
  if (ch.anchor !== null) {
    const a = ch.anchor;
    let found = -1;
    for (const t of strict ? [0] : [0, 1, 2]) {
      for (let i = cursor; i < model.lines.length; i += 1) {
        if (normLine(model.lines[i]!, t) === normLine(a, t)) {
          found = i;
          break;
        }
      }
      if (found >= 0) break;
    }
    if (found < 0) throw new Fail('no-match', path);
    cursor = found + 1;
  }
  const O = ch.body.filter((b) => b.kind !== 'new');
  const N = ch.body.filter((b) => b.kind !== 'old');
  if (O.length === 0) {
    const pos = ch.eof ? model.lines.length : cursor;
    model.lines.splice(pos, 0, ...N.map((b) => b.text));
    return pos + N.length;
  }
  const found = findTier(
    model.lines,
    O.map((b) => b.text),
    strict,
    cursor,
    ch.eof,
  );
  if (found === null) throw new Fail('no-match', path);
  const pos = found.occ[0]!;
  applyReplace(
    model,
    pos,
    O.map((b) => ({ text: b.text, ctx: b.kind === 'ctx' })),
    N.map((b) => ({ text: b.text, ctx: b.kind === 'ctx' })),
    found.tier,
  );
  return pos + N.length;
}

function vSectionEdit(sec: VSection, strict: boolean): Edit {
  const edit: Edit = (tree: Tree) => {
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.kind === 'add') {
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, sec.lines.length === 0 ? '' : sec.lines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const before = tree.get(sec.path);
    if (before === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const model = splitFile(before);
    let cursor = 0;
    for (const ch of sec.chunks) cursor = applyVChunk(model, ch, cursor, strict, sec.path);
    const out = joinFile(model);
    if (sec.moveTo !== null) {
      tree.now.set(sec.path, null);
      tree.now.set(sec.moveTo, out);
      edit.move = [sec.path, sec.moveTo];
    } else {
      tree.now.set(sec.path, out);
    }
  };
  return edit;
}

/** Parse V4A patches (section 8) into edits. */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    let kind: 'add' | 'delete' | 'update' | null = null;
    let path = '';
    if (l.startsWith('*** Add File: ')) {
      kind = 'add';
      path = l.slice(14).trim();
    } else if (l.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = l.slice(17).trim();
    } else if (l.startsWith('*** Update File: ')) {
      kind = 'update';
      path = l.slice(17).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const sec: VSection = { kind, path, moveTo: null, lines: [], chunks: [], lineNo: i + 1 };
    i += 1;
    if (kind === 'add') {
      while (i < last && !isSectionStart(lines[i]!)) {
        const b = lines[i]!;
        if (b.startsWith('+')) sec.lines.push(b.slice(1));
        else if (b === '') sec.lines.push('');
        else throw new Exit2(`error: parse ${i + 1}`);
        i += 1;
      }
      while (sec.lines.length > 0 && sec.lines[sec.lines.length - 1] === '') sec.lines.pop();
    } else if (kind === 'delete') {
      while (i < last && !isSectionStart(lines[i]!)) {
        if (!blank(lines[i]!)) throw new Exit2(`error: parse ${i + 1}`);
        i += 1;
      }
    } else {
      while (i < last && blank(lines[i]!)) i += 1;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        sec.moveTo = lines[i]!.slice(13).trim();
        i += 1;
      }
      let cur: VChunk | null = null;
      const closeChunk = (): void => {
        cur = null;
      };
      while (i < last && !isSectionStart(lines[i]!)) {
        const b = lines[i]!;
        if (b === '') {
          if (cur !== null) cur.body.push({ kind: 'ctx', text: '' });
          i += 1;
          continue;
        }
        if (b.startsWith('@@')) {
          cur = { anchor: b.slice(2).trim() === '' ? null : b.slice(2).trim(), body: [], eof: false };
          sec.chunks.push(cur);
          i += 1;
          continue;
        }
        if (b === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
          cur.eof = true;
          closeChunk();
          i += 1;
          continue;
        }
        const c = b[0]!;
        if (c === ' ' || c === '-' || c === '+') {
          if (cur === null) {
            if (sec.chunks.length > 0) throw new Exit2(`error: parse ${i + 1}`);
            cur = { anchor: null, body: [], eof: false };
            sec.chunks.push(cur);
          }
          cur.body.push({ kind: c === ' ' ? 'ctx' : c === '-' ? 'old' : 'new', text: b.slice(1) });
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      const lastChunk = sec.chunks[sec.chunks.length - 1];
      if (lastChunk !== undefined) {
        while (lastChunk.body.length > 0) {
          const tail = lastChunk.body[lastChunk.body.length - 1]!;
          if (tail.kind === 'ctx' && tail.text === '') lastChunk.body.pop();
          else break;
        }
      }
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${sec.lineNo}`);
    }
    edits.push(vSectionEdit(sec, strict));
  }
  return edits;
}

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
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict) : kind === 'search-replace' ? srEdits(lines, strict) : kind === 'v4a' ? v4aEdits(lines, strict) : [];
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed: { key: string; line: string }[] = [];
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const e of edits) {
    const mv = e.move;
    if (!mv) continue;
    const [oldP, newP] = mv;
    const di = changed.findIndex((c) => c.line === `D ${oldP}`);
    const ai = changed.findIndex((c) => c.line === `A ${newP}`);
    if (di >= 0 && ai >= 0) {
      changed.splice(di, 1);
      changed.splice(
        changed.findIndex((c) => c.line === `A ${newP}`),
        1,
      );
      changed.push({ key: newP, line: `R ${oldP} -> ${newP}` });
    }
  }
  changed.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = changed.map((c) => c.line);
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
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
