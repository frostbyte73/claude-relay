// Unified diff between two SKILL.md texts, emitted with git-style headers so it parses with
// src/git/diff-parser.ts and renders through the same vocabulary as every other diff in the
// PWA. Hand-rolled rather than pulling in a diff dependency for ~80 lines, and computed on
// read rather than stored — bodies are the source of truth, so a persisted diff would be
// redundant state that can disagree with them.

const DEFAULT_CONTEXT = 3;
const DEFAULT_MAX_LINES = 2000;

interface Op {
  op: ' ' | '-' | '+';
  text: string;
}

export interface SkillDiffOpts {
  context?: number;
  maxLines?: number;
}

// 'a\n' is one line, not one line plus an empty one.
function splitLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function lcsOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const table = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * width + j] = a[i] === b[j]
        ? table[(i + 1) * width + (j + 1)]! + 1
        : Math.max(table[(i + 1) * width + j]!, table[i * width + (j + 1)]!);
    }
  }

  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ op: ' ', text: a[i]! });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * width + j]! >= table[i * width + (j + 1)]!) {
      ops.push({ op: '-', text: a[i]! });
      i += 1;
    } else {
      ops.push({ op: '+', text: b[j]! });
      j += 1;
    }
  }
  while (i < n) ops.push({ op: '-', text: a[i++]! });
  while (j < m) ops.push({ op: '+', text: b[j++]! });
  return ops;
}

function render(ops: Op[], context: number): string {
  const changed: number[] = [];
  ops.forEach((o, idx) => { if (o.op !== ' ') changed.push(idx); });
  if (changed.length === 0) return '';

  // Line numbers each op sits at on its own side.
  const oldNo: number[] = [];
  const newNo: number[] = [];
  let o = 1;
  let n = 1;
  for (const op of ops) {
    oldNo.push(o);
    newNo.push(n);
    if (op.op !== '+') o += 1;
    if (op.op !== '-') n += 1;
  }

  // Cluster changes whose context windows would touch, so adjacent edits share one hunk.
  const clusters: Array<[number, number]> = [];
  let start = changed[0]!;
  let end = start;
  for (const idx of changed.slice(1)) {
    if (idx - end - 1 <= 2 * context) { end = idx; continue; }
    clusters.push([start, end]);
    start = idx;
    end = idx;
  }
  clusters.push([start, end]);

  const out: string[] = ['diff --git a/SKILL.md b/SKILL.md', '--- a/SKILL.md', '+++ b/SKILL.md'];
  for (const [first, last] of clusters) {
    const from = Math.max(0, first - context);
    const to = Math.min(ops.length - 1, last + context);
    const slice = ops.slice(from, to + 1);
    const oldLines = slice.filter((x) => x.op !== '+').length;
    const newLines = slice.filter((x) => x.op !== '-').length;
    // A pure insertion has no old lines, and git anchors that at the line before it — which
    // is also what makes an empty `before` render as `-0,0`.
    const oldStart = oldLines > 0 ? oldNo[from]! : oldNo[from]! - 1;
    const newStart = newLines > 0 ? newNo[from]! : newNo[from]! - 1;
    out.push(`@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`);
    for (const x of slice) out.push(`${x.op}${x.text}`);
  }
  return `${out.join('\n')}\n`;
}

export function unifiedSkillDiff(before: string, after: string, opts: SkillDiffOpts = {}): string {
  if (before === after) return '';
  const context = opts.context ?? DEFAULT_CONTEXT;
  const maxLines = opts.maxLines ?? DEFAULT_MAX_LINES;
  const a = before === '' ? [] : splitLines(before);
  const b = after === '' ? [] : splitLines(after);

  if (a.length > maxLines || b.length > maxLines) {
    const ops: Op[] = [
      ...a.map((text): Op => ({ op: '-', text })),
      ...b.map((text): Op => ({ op: '+', text })),
    ];
    return render(ops, 0);
  }
  return render(lcsOps(a, b), context);
}
