// Which slice of a PR's diff to show under an inline review comment.
//
// GitHub's `diff_hunk` field on a review comment is the hunk from its START through the
// COMMENTED LINE — which is wrong at both ends for reading a comment. On a newly added file
// the hunk starts at line 1, so a comment on line 302 arrives carrying 302 lines of file body;
// and because it stops at the comment, it never contains a single line of what comes AFTER,
// which is often the half that says what the comment is about.
//
// So the hunk text is the fallback, not the source. Given the file's real patch (from
// `pulls/:n/files`) we locate the commented line inside it and take a symmetric window —
// lines before AND after, the way the Files-changed tab reads. Either way the result is
// bounded and carries the elision counts, so the card can offer the rest behind an expander
// instead of dumping it.

const CONTEXT_BEFORE = 5;
const CONTEXT_AFTER = 5;

// One `@@ -a,b +c,d @@ section` header. `section` is git's enclosing-context text (usually the
// function signature) — real orientation, and the one thing a truncated window can't rebuild.
function parseHunkHeader(line) {
  const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: ?(.*))?$/);
  if (!m) return null;
  return {
    text: line,
    oldStart: Number(m[1]),
    oldLines: m[2] === undefined ? 1 : Number(m[2]),
    newStart: Number(m[3]),
    newLines: m[4] === undefined ? 1 : Number(m[4]),
    section: m[5] ?? '',
  };
}

// Parse hunk-shaped diff text: starts at `@@`, no `diff --git`/`---`/`+++` preamble. That's
// the shape of BOTH a comment's `diff_hunk` and a `pulls/:n/files` entry's `patch`, which is
// why this can't just be src/git/diff-parser.ts (that one keys off `diff --git` headers).
export function parseHunks(text) {
  const out = [];
  let current = null;
  let oldLine = 0;
  let newLine = 0;
  for (const raw of String(text ?? '').split('\n')) {
    if (raw.startsWith('@@')) {
      const header = parseHunkHeader(raw);
      if (!header) continue;
      current = { ...header, rows: [] };
      oldLine = header.oldStart;
      newLine = header.newStart;
      out.push(current);
      continue;
    }
    if (!current) continue;
    if (raw.startsWith('\\')) continue; // "\ No newline at end of file"
    const op = raw[0];
    const content = raw.slice(1);
    if (op === ' ') current.rows.push({ op: ' ', content, oldLine: oldLine++, newLine: newLine++ });
    else if (op === '-') current.rows.push({ op: '-', content, oldLine: oldLine++ });
    else if (op === '+') current.rows.push({ op: '+', content, newLine: newLine++ });
    else if (raw === '') continue; // trailing-newline split artifact
    else current = null; // unknown leader — stop consuming until the next @@
  }
  return out;
}

// A deletion is commented on the LEFT (old) side, everything else on the RIGHT (new) side.
function lineOf(row, side) {
  return side === 'LEFT' ? row.oldLine : row.newLine;
}

function findAnchor(hunks, line, side) {
  for (const hunk of hunks) {
    for (let i = 0; i < hunk.rows.length; i++) {
      if (lineOf(hunk.rows[i], side) === line) return { hunk, index: i };
    }
  }
  return null;
}

// The window the card should render, plus everything it needs to offer the rest.
//
// Returns `{ header, section, rows, start, end, anchor, source }`: `rows` is the WHOLE hunk, and
// `start`/`end` bound the slice to show — so expanding is a pure client-side toggle over data
// already in hand, never a second fetch. `anchor` is the index of the commented row (null when
// it couldn't be located, e.g. an outdated comment whose `line` GitHub reports as null).
//
// `source` is 'patch' when the real file diff placed the comment (lines on both sides of it) and
// 'hunk' when this fell back to `diff_hunk` (tail only — there is nothing after the comment in
// that payload to show).
export function windowForComment({ patch, diffHunk, line, startLine, side } = {}) {
  const wantSide = side === 'LEFT' ? 'LEFT' : 'RIGHT';

  if (patch && typeof line === 'number') {
    const hit = findAnchor(parseHunks(patch), line, wantSide);
    if (hit) {
      // A multi-line comment (`start_line`..`line`) is ABOUT its whole range, so the range wins
      // over the fixed lead-in — never show the end of a span whose beginning got cropped off.
      const from = typeof startLine === 'number'
        ? hit.hunk.rows.findIndex((r) => lineOf(r, wantSide) === startLine)
        : -1;
      const lead = from >= 0 ? Math.min(from, hit.index - CONTEXT_BEFORE) : hit.index - CONTEXT_BEFORE;
      return {
        header: hit.hunk.text,
        section: hit.hunk.section,
        rows: hit.hunk.rows,
        start: Math.max(0, lead),
        end: Math.min(hit.hunk.rows.length, hit.index + CONTEXT_AFTER + 1),
        anchor: hit.index,
        source: 'patch',
      };
    }
  }

  // Fallback: the comment's own `diff_hunk`. It ends AT the commented line, so the last row is
  // the anchor by construction and the window is its tail — GitHub's conversation-tab reading.
  const hunks = parseHunks(diffHunk);
  const hunk = hunks[hunks.length - 1];
  if (!hunk || !hunk.rows.length) return null;
  const anchor = hunk.rows.length - 1;
  return {
    header: hunk.text,
    section: hunk.section,
    rows: hunk.rows,
    start: Math.max(0, anchor - CONTEXT_BEFORE),
    end: hunk.rows.length,
    anchor,
    source: 'hunk',
  };
}
