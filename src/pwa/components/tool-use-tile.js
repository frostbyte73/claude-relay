import { escapeHtml } from '../util.js';
import { sessions } from '../state/sessions.js';
import { renderMarkdown } from '../markdown.js';

// Path context is passed explicitly by callers as `{ cwd, worktreePath }` —
// there is deliberately no shared/global "current session" pointer here.
// Multiple sessions can have their tool tiles rendered concurrently (Tracked's
// inline-session previews, the agents sheet, the Sessions rail's docked
// subagent cards), so each render call must carry the cwd/worktreePath of the
// session it's actually rendering, not whichever session happened to be
// painted last. Callers that genuinely don't know their session (rare) get a
// best-effort fallback to the mobile-only `currentSessionCwd` pointer.
function resolvePathCtx(ctx) {
  if (ctx !== undefined) {
    const cwd = ctx?.cwd ?? null;
    const spawnCwd = ctx?.worktreePath ?? null;
    return { cwd, worktreePath: (spawnCwd && spawnCwd !== cwd) ? spawnCwd : null };
  }
  const s = sessions.get();
  const cwd = s.currentSessionCwd ?? null;
  const live = s.currentSessionSpawnCwd;
  if (live && live !== cwd) return { cwd, worktreePath: live };
  const sid = s.currentSessionId;
  if (sid) {
    for (const p of s.projects || []) {
      for (const ss of p.sessions || []) {
        if (ss.id === sid && ss.worktreePath) return { cwd, worktreePath: ss.worktreePath };
      }
    }
  }
  return { cwd, worktreePath: null };
}

// must stay in sync with the matching constant in src/session-store.ts
export const TASK_TOOL_NAMES = new Set(['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']);

// Mirrors --permission-mode=acceptEdits; Bash/Read/Grep stay user-approvable.
export const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);

export function isHighDetailTool(toolName) {
  return toolName === 'Bash' || EDIT_TOOLS.has(toolName);
}

// claude code re-serializes tool_input with different key order between stream and hook
export function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}
export function diffLines(oldText, newText) {
  const a = String(oldText ?? '').split('\n');
  const b = String(newText ?? '').split('\n');
  const m = a.length, n = b.length;
  const CAP = 800;
  if (m === 0 && n === 0) return [];
  if (m > CAP || n > CAP) {
    return [
      ...a.map((t) => ({ op: '-', text: t })),
      ...b.map((t) => ({ op: '+', text: t })),
    ];
  }
  const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { out.push({ op: ' ', text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ op: '-', text: a[i] }); i++; }
    else { out.push({ op: '+', text: b[j] }); j++; }
  }
  while (i < m) out.push({ op: '-', text: a[i++] });
  while (j < n) out.push({ op: '+', text: b[j++] });
  return out;
}

// Inline shell-style render for Bash/Grep/Glob — replaces the full tool card with a
// slim verb + body line modeled on readLineHtml. The card chrome (border, label header,
// expand/collapse) wasted vertical space and cropped the command's horizontal width;
// these tools have shallow, terminal-y inputs that read better as a single mono line.
export function shellLineHtml(toolName, input, ctx) {
  if (toolName === 'Bash') return bashShellHtml(input, ctx);
  if (toolName === 'Grep') return grepShellHtml(input, ctx);
  if (toolName === 'Glob') return globShellHtml(input, ctx);
  if (toolName === 'WebFetch') return webFetchShellHtml(input);
  if (toolName === 'WebSearch') return webSearchShellHtml(input);
  if (toolName === 'Skill') return skillShellHtml(input);
  if (toolName === 'ToolSearch') return toolSearchShellHtml(input);
  return '';
}

// Walk a bash command and insert a literal newline after every top-level `&&` or `;`,
// preserving any whitespace/heredoc/quoted regions where those tokens aren't actual
// separators. Keeps the source's existing newlines intact (won't double them up).
//
// Tracked state: single quotes, double quotes (with \-escape), backticks, $( … ) subshell
// depth, and <<TAG / <<-TAG / <<'TAG' heredocs. Edge cases that don't matter in practice
// (case ;; — preserved since we only split on a lone `;` — and `||`, which we don't split
// on at all since the user only asked for `&&` and `;`).
export function formatBashCommandText(cmd) {
  const out = [];
  const n = cmd.length;
  let i = 0;
  let inSingle = false, inDouble = false, inBacktick = false;
  let parenDepth = 0;
  let heredocTag = null;

  while (i < n) {
    const c = cmd[i];

    if (heredocTag) {
      out.push(c);
      if (c === '\n') {
        const rest = cmd.slice(i + 1);
        const m = rest.match(/^(\s*)([A-Za-z_]\w*)/);
        if (m && m[2] === heredocTag) {
          const after = i + 1 + m[0].length;
          if (after === n || cmd[after] === '\n') {
            out.push(m[0]);
            i = after;
            heredocTag = null;
            continue;
          }
        }
      }
      i++;
      continue;
    }

    if (inSingle) {
      out.push(c);
      if (c === "'") inSingle = false;
      i++;
      continue;
    }
    if (inDouble) {
      if (c === '\\' && i + 1 < n) { out.push(c, cmd[i + 1]); i += 2; continue; }
      out.push(c);
      if (c === '"') inDouble = false;
      i++;
      continue;
    }
    if (inBacktick) {
      if (c === '\\' && i + 1 < n) { out.push(c, cmd[i + 1]); i += 2; continue; }
      out.push(c);
      if (c === '`') inBacktick = false;
      i++;
      continue;
    }

    if (c === '\\' && i + 1 < n) {
      out.push(c, cmd[i + 1]);
      i += 2;
      continue;
    }

    const hd = cmd.slice(i).match(/^<<-?\s*['"]?([A-Za-z_]\w*)['"]?/);
    if (hd) {
      out.push(hd[0]);
      heredocTag = hd[1];
      i += hd[0].length;
      continue;
    }

    if (c === "'") { inSingle = true; out.push(c); i++; continue; }
    if (c === '"') { inDouble = true; out.push(c); i++; continue; }
    if (c === '`') { inBacktick = true; out.push(c); i++; continue; }

    if (cmd[i] === '$' && cmd[i + 1] === '(') {
      out.push('$(');
      parenDepth++;
      i += 2;
      continue;
    }
    if (parenDepth > 0) {
      if (c === '(') { parenDepth++; out.push(c); i++; continue; }
      if (c === ')') { parenDepth--; out.push(c); i++; continue; }
    }

    if (parenDepth === 0) {
      if (c === '&' && cmd[i + 1] === '&') {
        out.push('&&');
        i += 2;
        while (i < n && (cmd[i] === ' ' || cmd[i] === '\t')) i++;
        if (i < n && cmd[i] !== '\n') out.push('\n');
        continue;
      }
      if (c === ';' && cmd[i + 1] !== ';') {
        out.push(';');
        i++;
        while (i < n && (cmd[i] === ' ' || cmd[i] === '\t')) i++;
        if (i < n && cmd[i] !== '\n') out.push('\n');
        continue;
      }
    }

    out.push(c);
    i++;
  }
  return out.join('');
}

// Bash inline tile — a single $-prompt line with `&&`/`;` broken onto their own lines.
// Description (Claude's natural-language summary) rides above as a `# comment` row when
// present. Background + timeout become small uppercase chips below — same pattern as the
// old expanded view, just inline.
export function bashShellHtml(input, ctx) {
  const cmd = String(input?.command ?? '');
  const desc = String(input?.description ?? '');
  const formatted = projectifyText(formatBashCommandText(cmd), ctx);

  const descLine = desc
    ? `<div class="shell-line shell-line-comment"><span class="shell-prompt">#</span><span class="shell-cmd">${escapeHtml(projectifyText(desc, ctx))}</span></div>`
    : '';
  const cmdLine = cmd
    ? `<div class="shell-line"><span class="shell-prompt">$</span><span class="shell-cmd">${escapeHtml(formatted)}</span></div>`
    : '';

  const flags = [];
  if (input?.run_in_background) flags.push('background');
  if (input?.timeout) flags.push(`timeout ${input.timeout}ms`);
  const flagsHtml = flags.length
    ? `<div class="shell-flags">${flags.map((f) => `<span class="shell-flag">${escapeHtml(f)}</span>`).join('')}</div>`
    : '';

  return (
    `<div class="msg msg-shell">` +
      `<div class="shell-body">${descLine}${cmdLine}${flagsHtml}</div>` +
    `</div>`
  );
}

// Grep inline tile — renders as the `rg` command-line equivalent (same construction as
// renderGrepSearch, just embedded in the slim shell-line frame instead of a card).
export function grepShellHtml(input, ctx) {
  const parts = ['rg'];
  if (input?.['-i']) parts.push('-i');
  if (input?.['-n']) parts.push('-n');
  if (input?.multiline) parts.push('-U');
  if (input?.output_mode === 'files_with_matches') parts.push('-l');
  else if (input?.output_mode === 'count') parts.push('-c');
  if (input?.['-A'] != null) parts.push(`-A ${input['-A']}`);
  if (input?.['-B'] != null) parts.push(`-B ${input['-B']}`);
  if (input?.['-C'] != null) parts.push(`-C ${input['-C']}`);
  if (input?.type) parts.push(`--type ${shellQuote(String(input.type))}`);
  if (input?.glob) parts.push(`-g ${shellQuote(String(input.glob))}`);
  const pattern = shellQuote(String(input?.pattern ?? ''));
  const suffix = [];
  if (input?.path) suffix.push(shellQuote(projectRelativePath(String(input.path), ctx)));
  let tail = suffix.length ? ` ${suffix.join(' ')}` : '';
  if (input?.head_limit) tail += ` | head -${input.head_limit}`;
  const cmdHtml =
    `${escapeHtml(parts.join(' '))} ` +
    `<span class="shell-grep-pattern">${escapeHtml(pattern)}</span>` +
    `${escapeHtml(tail)}`;
  return (
    `<div class="msg msg-shell">` +
      `<div class="shell-body">` +
        `<div class="shell-line"><span class="shell-prompt">$</span><span class="shell-cmd">${cmdHtml}</span></div>` +
      `</div>` +
    `</div>`
  );
}

// Glob inline tile — `* <pattern>` with the glob wildcard itself as the marker.
// Optional "in <path>" aside renders below, same shape as WebSearch's domain hints.
export function globShellHtml(input, ctx) {
  const pattern = String(input?.pattern ?? '');
  const path = input?.path ? `in ${projectRelativePath(String(input.path), ctx)}` : '';
  const aside = path ? `<div class="shell-aside">${escapeHtml(path)}</div>` : '';
  return (
    `<div class="msg msg-shell">` +
      `<div class="shell-body">` +
        `<div class="shell-line"><span class="shell-prompt">*</span><span class="shell-cmd">${escapeHtml(pattern)}</span></div>` +
        aside +
      `</div>` +
    `</div>`
  );
}

// WebFetch inline tile — `# <prompt>` riding above `<< <url>`. Shell-line-comment
// dims/italicizes the prompt to read as a shell comment; the URL row keeps full
// contrast and the URL is tappable when http(s):// (same posture as the markdown
// link renderer — anything else falls back to plain text).
export function webFetchShellHtml(input) {
  const url = String(input?.url ?? '');
  const prompt = compactWs(input?.prompt);
  const safeUrl = /^https?:\/\//i.test(url) ? url : '';
  const urlInner = safeUrl
    ? `<a href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`
    : escapeHtml(url);
  const promptLine = prompt
    ? `<div class="shell-line shell-line-comment"><span class="shell-prompt">#</span><span class="shell-cmd">${escapeHtml(prompt)}</span></div>`
    : '';
  const urlLine = url
    ? `<div class="shell-line"><span class="shell-prompt">&lt;&lt;</span><span class="shell-cmd">${urlInner}</span></div>`
    : '';
  return (
    `<div class="msg msg-shell">` +
      `<div class="shell-body">${promptLine}${urlLine}</div>` +
    `</div>`
  );
}

// WebSearch inline tile — `? <query>`. Optional allowed/blocked domain lists
// render as muted asides below, same shape as Glob's "in <path>".
export function webSearchShellHtml(input) {
  const query = String(input?.query ?? '');
  const asides = [];
  if (Array.isArray(input?.allowed_domains) && input.allowed_domains.length) {
    asides.push(`only ${input.allowed_domains.join(', ')}`);
  }
  if (Array.isArray(input?.blocked_domains) && input.blocked_domains.length) {
    asides.push(`exclude ${input.blocked_domains.join(', ')}`);
  }
  const asideHtml = asides
    .map((a) => `<div class="shell-aside">${escapeHtml(a)}</div>`)
    .join('');
  return (
    `<div class="msg msg-shell">` +
      `<div class="shell-body">` +
        `<div class="shell-line"><span class="shell-prompt">?</span><span class="shell-cmd">${escapeHtml(query)}</span></div>` +
        asideHtml +
      `</div>` +
    `</div>`
  );
}

// Skill inline tile — `/ <skill-name>` mirrors the slash-command syntax users
// type to invoke skills. Args (when present) wrap on the same line as a single
// pre-wrap string, matching how /skill arg1 arg2 reads in the terminal.
export function skillShellHtml(input) {
  const name = String(input?.skill ?? '');
  const args = compactWs(input?.args);
  const cmd = args ? `${name} ${args}` : name;
  return (
    `<div class="msg msg-shell">` +
      `<div class="shell-body">` +
        `<div class="shell-line"><span class="shell-prompt">/</span><span class="shell-cmd">${escapeHtml(cmd)}</span></div>` +
      `</div>` +
    `</div>`
  );
}

// ToolSearch inline tile — `@ <query>` reads as "look up by name". `select:A,B`
// queries unfold to the bare tool list since the `select:` prefix is a wire-
// format detail, not user-meaningful; the `@` already says "look these up".
export function toolSearchShellHtml(input) {
  const q = String(input?.query ?? '');
  const sel = q.match(/^select:(.+)$/);
  const cmd = sel ? sel[1].split(',').map((s) => s.trim()).filter(Boolean).join(', ') : q;
  return (
    `<div class="msg msg-shell">` +
      `<div class="shell-body">` +
        `<div class="shell-line"><span class="shell-prompt">@</span><span class="shell-cmd">${escapeHtml(cmd)}</span></div>` +
      `</div>` +
    `</div>`
  );
}

// Slim one-liner for Read tool calls. Replaces the standard tool tile because the input
// is shallow (file path + optional line range) and the user mostly wants a live signal
// that something's happening. Active when this is the most recent message in its feed —
// animates an ellipsis to indicate the read is in flight; once anything else lands after
// it the dots freeze and the verb switches to past tense.
export function readLineHtml(input, ctx) {
  const path = projectRelativePath(String(input?.file_path ?? ''), ctx);
  const range = readRangeSuffix(input);
  // Single label "Read" in accent — the thinking strip already shows "Reading…" in
  // flight, so the transcript tile doesn't need to mirror that state.
  const rangeLine = range
    ? `<span class="read-range">${escapeHtml(range)}</span>`
    : '';
  return (
    `<div class="msg msg-read">` +
      `<span class="read-verb">&lt;&lt;</span>` +
      `<span class="read-target">${escapeHtml(path)}</span>` +
      rangeLine +
    `</div>`
  );
}

// Human-readable range subtitle for the read line ("lines 60-75" / "line 60+" /
// "pages 1-5"). Returns '' when no range info is present so the line just shows the
// bare path with no second-line subtitle.
export function readRangeSuffix(input) {
  if (input?.pages) return `pages ${input.pages}`;
  const off = Number(input?.offset);
  if (!Number.isFinite(off) || off <= 0) return '';
  const lim = Number(input?.limit);
  if (Number.isFinite(lim) && lim > 0) return `lines ${off}-${off + lim - 1}`;
  return `line ${off}+`;
}

// The diff rows alone (no header, no box) — shared by the approval-card view
// (renderEditDiff) and the card-less feed tile (editWriteTileHtml).
export function editDiffRowsHtml(input) {
  const diff = diffLines(input?.old_string ?? '', input?.new_string ?? '');
  const rows = diff.map(({ op, text }) => {
    const cls = op === '+' ? 'diff-add' : op === '-' ? 'diff-del' : 'diff-eq';
    const prefix = op;
    // Render empty lines as a single non-breaking space so the row still has visible height
    // and the user can tell that a blank line is part of the diff.
    const body = text === '' ? ' ' : text;
    return `<div class="diff-line ${cls}"><span class="diff-mark">${escapeHtml(prefix)}</span><span class="diff-text">${escapeHtml(body)}</span></div>`;
  }).join('');
  return rows;
}

export function renderEditDiff(input, ctx) {
  const path = projectRelativePath(String(input?.file_path ?? ''), ctx);
  // Header bar — filename styled like the top line of a git diff, attached to the diff
  // body via shared border-left + bottom-only divider. The collapsed summary above is
  // hidden when expanded (see CSS) so the path appears only once.
  const flag = input?.replace_all ? `<span class="diff-head-flag">replace-all</span>` : '';
  const head = `<div class="diff-head"><span class="diff-head-marker">~</span>${escapeHtml(path)}${flag}</div>`;
  return `<div class="tool-diff">${head}<div class="diff-body">${editDiffRowsHtml(input)}</div></div>`;
}

// Card-less feed tile for Edit / Write. The `~ path` (Edit) or `+ path` (Write)
// header row that used to live inside the expanded card is now the always-visible
// feed row, and doubles as the expand/collapse toggle; the diff / file-content
// body collapses beneath it. Defaults to expanded — the tool_use id is seeded into
// the slice's expandedTools when the call lands (appendTranscript) or a session's
// history loads (see app.js), so edits read inline without a tap while a manual
// collapse still sticks. Approval cards keep the full labeled card (renderEditDiff
// / renderWriteContent via renderToolExpandedBody) — this is transcript-only.
export function editWriteTileHtml(m, opts = {}) {
  const ctx = opts.ctx;
  const input = (m.toolInput && typeof m.toolInput === 'object') ? m.toolInput : {};
  const isWrite = m.toolName === 'Write';
  const id = typeof m.toolUseId === 'string' ? m.toolUseId : '';
  const expandable = !!id && m.toolInput !== undefined;
  const expandedTools = opts.expandedTools ?? sessions.currentSlice().expandedTools;
  const expanded = expandable && expandedTools.has(id);
  const cls = `msg msg-editwrite${expandable ? ' tool_use-expandable' : ''}${expanded ? ' tool_use-expanded' : ''}`;
  const idAttr = expandable ? ` data-tool-id="${escapeHtml(id)}"` : '';
  const chev = expandable ? `<span class="tool-chev" aria-hidden="true"></span>` : '';
  const path = projectRelativePath(String(input.file_path ?? ''), ctx);
  const marker = isWrite ? '+' : '~';
  const flag = isWrite
    ? `<span class="diff-head-flag">${writeLineCount(input).toLocaleString()} lines</span>`
    : input.replace_all ? `<span class="diff-head-flag">replace-all</span>` : '';
  const head =
    `<div class="diff-head">` +
      `<span class="diff-head-marker">${marker}</span>` +
      `<span class="editwrite-path">${escapeHtml(path)}</span>` +
      flag + chev +
    `</div>`;
  // Same lazy rule as toolUseHtml: the diff/content body is display:none while
  // collapsed, so building it would only cost DOM. A collapsed tile that isn't
  // expandable at all (no tool_use_id) can never reveal it, so it stays out too.
  let body = '';
  if (expanded) {
    if (isWrite) {
      if (isMarkdownPath(input.file_path) && writeLineCount(input) <= MD_RENDER_MAX_LINES) {
        body = writeMarkdownBodyHtml(input);
      } else {
        const { rows, overflowRow } = writeContentRowsHtml(input);
        body = `<div class="tool-write"><div class="write-body">${rows}${overflowRow}</div></div>`;
      }
    } else {
      body = `<div class="tool-diff"><div class="diff-body">${editDiffRowsHtml(input)}</div></div>`;
    }
  }
  return `<div class="${cls}"${idAttr}>${head}${body}</div>`;
}

// Grep's input is structured (pattern, path, glob, type, flags, output_mode, context)
// and the most natural way to show it is the ripgrep command-line equivalent — same
// shell-style block we use for Bash. Anyone who's used grep/rg can read it at a glance.
export function renderGrepSearch(input, ctx) {
  // Build the command in two halves so we can highlight the search pattern in
  // accent-2 — it's the one token that matters most and is otherwise hard to spot
  // amid the flags + paths.
  const prefix = ['rg'];
  if (input?.['-i']) prefix.push('-i');
  if (input?.['-n']) prefix.push('-n');
  if (input?.multiline) prefix.push('-U');
  if (input?.output_mode === 'files_with_matches') prefix.push('-l');
  else if (input?.output_mode === 'count') prefix.push('-c');
  if (input?.['-A'] != null) prefix.push(`-A ${input['-A']}`);
  if (input?.['-B'] != null) prefix.push(`-B ${input['-B']}`);
  if (input?.['-C'] != null) prefix.push(`-C ${input['-C']}`);
  if (input?.type) prefix.push(`--type ${shellQuote(String(input.type))}`);
  if (input?.glob) prefix.push(`-g ${shellQuote(String(input.glob))}`);
  const pattern = shellQuote(String(input?.pattern ?? ''));
  const suffix = [];
  if (input?.path) suffix.push(shellQuote(projectRelativePath(String(input.path), ctx)));
  let tail = suffix.length ? ` ${suffix.join(' ')}` : '';
  if (input?.head_limit) tail += ` | head -${input.head_limit}`;
  const cmdHtml =
    `${escapeHtml(prefix.join(' '))} ` +
    `<span class="bash-grep-pattern">${escapeHtml(pattern)}</span>` +
    `${escapeHtml(tail)}`;
  return `
    <div class="tool-bash">
      <div class="bash-cmd"><span class="bash-prompt">$</span><span class="bash-cmd-text">${cmdHtml}</span></div>
    </div>
  `;
}

// Minimal shell-style quoting. Safe-glob characters pass unquoted; anything else gets
// single-quoted (and falls back to double-quoting with escapes if the value contains a
// single quote). Tuned for readability over canonical correctness — the user is reading,
// not piping the output into bash.
export function shellQuote(s) {
  if (s === '') return "''";
  if (/^[A-Za-z0-9_./@%+=:,~-]+$/.test(s)) return s;
  if (!s.includes("'")) return `'${s}'`;
  return `"${s.replace(/(["\\$`])/g, '\\$1')}"`;
}

export function renderBashCommand(input, ctx) {
  const cmd = String(input?.command ?? '');
  const bg = input?.run_in_background ? '<span class="bash-flag">background</span>' : '';
  const timeout = input?.timeout
    ? `<span class="bash-flag">timeout ${escapeHtml(String(input.timeout))}ms</span>`
    : '';
  const flags = (bg || timeout) ? `<div class="bash-flags">${bg}${timeout}</div>` : '';
  // formatBashCommandText drops a newline after every top-level `&&` and `;` so chained
  // commands read top-to-bottom instead of running off the right edge. The pre-wrap CSS
  // on .bash-cmd-text preserves those breaks along with any heredoc/embedded newlines.
  const formatted = projectifyText(formatBashCommandText(cmd), ctx);
  return `
    <div class="tool-bash">
      <div class="bash-cmd"><span class="bash-prompt">$</span><span class="bash-cmd-text">${escapeHtml(formatted)}</span></div>
      ${flags}
    </div>
  `;
}

// Write's expanded view shows the actual file content with line numbers — the JSON dump
// is unreadable for any file of size (the entire content lands as a single escaped
// string). 500-line cap keeps a 10k-line generated file from locking the main thread; the
// rest reads as a footer note. Content is just escaped text rather than syntax-
// highlighted — matching the diff renderer, which is honest about being a payload preview.
// Total line count of a Write payload — drives the "N lines" header flag.
export function writeLineCount(input) {
  return String(input?.content ?? '').split('\n').length;
}

// A Write to a markdown file is prose, not source — the numbered-line code view forces
// the reader to parse `##`/`-`/`|` by eye. When a spec/plan skill writes a `.md`, render
// its expanded feed body as formatted markdown instead (edits keep their diff — a diff of
// rendered markdown would be unreadable). Guarded by a line cap so a giant generated `.md`
// can't lock the main thread on renderMarkdown's regex pass; over the cap it falls back to
// the numbered rows.
export const MD_RENDER_MAX_LINES = 2000;
export function isMarkdownPath(path) {
  return /\.(?:md|markdown)$/i.test(String(path ?? ''));
}
export function writeMarkdownBodyHtml(input) {
  const md = renderMarkdown(String(input?.content ?? ''));
  return `<div class="tool-write tool-write-md"><div class="write-md">${md}</div></div>`;
}

// The numbered content rows + overflow footer (no header, no box) — shared by the
// approval-card view (renderWriteContent) and the card-less feed tile.
export function writeContentRowsHtml(input) {
  const lines = String(input?.content ?? '').split('\n');
  const MAX = 500;
  const visible = lines.slice(0, MAX);
  const overflow = lines.length - visible.length;
  const rows = visible.map((line, i) => {
    // Empty rows still need visible height so blank lines read correctly. A trailing
    // space is enough to give the row its line-height without disturbing wrapping.
    const text = line === '' ? ' ' : line;
    return `<div class="write-line"><span class="write-ln">${i + 1}</span><span class="write-text">${escapeHtml(text)}</span></div>`;
  }).join('');
  const overflowRow = overflow > 0
    ? `<div class="write-overflow">+ ${overflow.toLocaleString()} more lines</div>`
    : '';
  return { rows, overflowRow };
}

export function renderWriteContent(input, ctx) {
  const path = projectRelativePath(String(input?.file_path ?? ''), ctx);
  const { rows, overflowRow } = writeContentRowsHtml(input);
  // Header bar mirrors Edit's diff-head — path in the bar so the collapsed summary
  // can be hidden when expanded. `+` marker (vs Edit's `~`) signals new content
  // rather than modification. Flag carries the size hint Edit's summary doesn't need.
  const flag = `<span class="diff-head-flag">${writeLineCount(input).toLocaleString()} lines</span>`;
  const head = `<div class="diff-head"><span class="diff-head-marker">+</span>${escapeHtml(path)}${flag}</div>`;
  return `<div class="tool-write">${head}<div class="write-body">${rows}${overflowRow}</div></div>`;
}

// Agent's `prompt` is the most interesting payload in the entire transcript — it's the
// brief Claude is handing to the subagent. Render it as markdown (using the existing
// renderMarkdown that already handles XSS-safety internally) so headings, lists, code
// blocks, etc. all read correctly. Subagent activity lives in the docked feed above
// the thinking strip (see session-view / app.js) and in the agents sheet; the Agent
// tile itself stays focused on the invocation's brief.
export function renderAgentPrompt(input) {
  const prompt = String(input?.prompt ?? '');
  if (!prompt) return '';
  return `<div class="tool-agent"><div class="agent-prompt">${renderMarkdown(prompt)}</div></div>`;
}

// WebFetch's URL gets first-class treatment in the expanded view: a method tag + the URL
// as an actual <a> so the user can tap straight through to the resource. The prompt is
// usually a markdown brief telling Claude what to extract; render it as markdown below.
export function renderWebFetch(input) {
  const url = String(input?.url ?? '');
  const prompt = String(input?.prompt ?? '');
  // Only allow http(s):// + relative URLs through to the anchor; anything else falls
  // back to plain text. Same conservative posture as the markdown link renderer.
  const safeUrl = /^https?:\/\//i.test(url) ? url : '';
  const urlBlock = url
    ? safeUrl
      ? `<div class="webfetch-url"><span class="webfetch-method">GET</span><a href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a></div>`
      : `<div class="webfetch-url"><span class="webfetch-method">GET</span><span class="webfetch-url-text">${escapeHtml(url)}</span></div>`
    : '';
  const promptBlock = prompt
    ? `<div class="webfetch-prompt">${renderMarkdown(prompt)}</div>`
    : '';
  return `<div class="tool-webfetch">${urlBlock}${promptBlock}</div>`;
}


// Parse the markdown blob produced by formatDiffReviewMessage back into a structured list
// of comments. Returns null on shape mismatch (the caller falls back to a generic render).
// Tolerant of the trailing whitespace + spacing variations that survive a JSONL round-trip.
export function toolUseHtml(m, opts = {}) {
  const f = formatToolUse(m.toolName, m.toolInput, m.text, opts.ctx);
  const id = typeof m.toolUseId === 'string' ? m.toolUseId : '';
  // alwaysExpanded tools render their payload statically — no chevron, no tap-to-toggle.
  // Used for Grep where the structured rg-style block is the *primary* representation;
  // a summary + collapsed/expanded toggle would just hide the most useful view.
  const alwaysExpanded = !!f.alwaysExpanded;
  const hasPayload = m.toolInput !== undefined;
  const expandable = !alwaysExpanded && id && hasPayload;
  // The multi-live session-view passes its slice's expandedTools set explicitly.
  // Mobile renderSession has no per-slice reference, so it falls back to the
  // current session's slice.
  const expandedTools = opts.expandedTools ?? sessions.currentSlice().expandedTools;
  const expanded = alwaysExpanded || (expandable && expandedTools.has(id));
  const cls = `msg tool_use${expandable ? ' tool_use-expandable' : ''}${expanded ? ' tool_use-expanded' : ''}`;
  const idAttr = expandable ? ` data-tool-id="${escapeHtml(id)}"` : '';
  const chev = expandable ? `<span class="tool-chev" aria-hidden="true"></span>` : '';
  // Per-tool expanded views — replace the default pretty-JSON dump with a format matched
  // to how the tool's input is meant to be read. Falls back to JSON for everything else.
  //
  // Only built while actually expanded. Collapsing is pure CSS (display:none on
  // .tool-agent/.tool-json/.tool-bash/…), so emitting it unconditionally put every
  // payload in the DOM invisibly — and an `Agent` call's payload is its whole subagent
  // prompt. In a session with ~60 subagents that was half the transcript's markup,
  // re-parsed and re-laid-out on every repaint.
  const expandedBody = (expanded && hasPayload) ? renderToolExpandedBody(m.toolName, m.toolInput, opts.ctx) : '';
  // alwaysExpanded tools skip the summary/detail rows: their formatter intentionally
  // returns no body/detail, and the structured payload below carries the same information
  // in a richer form.
  const detail = (!alwaysExpanded && f.detail) ? `<div class="tool-detail">${escapeHtml(f.detail)}</div>` : '';
  // Formatters can set body to an empty string when the label alone is enough (Edit, for
  // example, surfaces the filename in its expanded diff header rather than the summary).
  // bodyKind='code' marks the body as an identifier (path, regex, URL, query) — wrap in
  // <code> so it renders mono and announces correctly to assistive tech. Default is prose.
  const summary = (!alwaysExpanded && f.body)
    ? f.bodyKind === 'code'
      ? `<div class="tool-summary tool-summary-code"><code>${escapeHtml(f.body)}</code></div>`
      : f.bodyKind === 'path'
        ? `<div class="tool-summary tool-summary-path">${escapeHtml(f.body)}</div>`
        : `<div class="tool-summary">${escapeHtml(f.body)}</div>`
    : '';
  return (
    `<div class="${cls}"${idAttr}>` +
      `<span class="tool-label">${escapeHtml(f.label)}${chev}</span>` +
      `<div class="tool-content">` +
        summary +
        detail +
        expandedBody +
      `</div>` +
    `</div>`
  );
}

// Dispatch helper — given a tool name + its input, return the HTML for the expanded
// payload view. Used by both transcript tool tiles and approval cards, so they show the
// same diff / shell / file-content preview whether you're approving the call or reading
// it back in the transcript.
export function renderToolExpandedBody(toolName, toolInput, ctx) {
  if (toolName === 'Edit') return renderEditDiff(toolInput, ctx);
  if (toolName === 'Bash') return renderBashCommand(toolInput, ctx);
  if (toolName === 'Grep') return renderGrepSearch(toolInput, ctx);
  if (toolName === 'Write') return renderWriteContent(toolInput, ctx);
  if (toolName === 'Agent') return renderAgentPrompt(toolInput);
  if (toolName === 'WebFetch') return renderWebFetch(toolInput);
  return `<pre class="tool-json">${highlightJson(JSON.stringify(toolInput, null, 2))}</pre>`;
}

// Pretty-printed JSON with light syntax coloring. Runs ON the already-escaped text so the
// regex anchors match HTML entities (&quot; for quotes), which keeps the output XSS-safe.
// The token regexes are tuned for JSON.stringify(_, null, 2) output specifically — they
// don't need to handle every valid JSON edge case, just well-formed pretty output.
export function highlightJson(jsonStr) {
  const esc = escapeHtml(jsonStr);
  return esc
    // Keys: a quoted string followed by colon — match before plain strings so we don't
    // claim a key as a string.
    .replace(/(&quot;(?:[^&]|&(?!quot;))*?&quot;)(\s*:)/g, '<span class="json-key">$1</span>$2')
    // Strings: any remaining quoted string (values).
    .replace(/(&quot;(?:[^&]|&(?!quot;))*?&quot;)/g, '<span class="json-string">$1</span>')
    // Numbers, booleans, nulls — anchored by the preceding ": " or "[ " / ", " so we don't
    // touch literal sequences that happen to appear inside string values.
    .replace(/([:[,]\s*)(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g, '$1<span class="json-num">$2</span>')
    .replace(/([:[,]\s*)(true|false)\b/g, '$1<span class="json-bool">$2</span>')
    .replace(/([:[,]\s*)(null)\b/g, '$1<span class="json-null">$2</span>');
}

// ───────────────────── Tool-use formatters ─────────────────────
// Each formatter returns { label, body, detail? }:
//   label  — the small accent-tinted tag at the top ("Bash", "Edit", "Grafana · ...").
//   body   — the human-readable primary identifier (file path, command desc, URL, query).
//   detail — an optional mono line with the raw payload preview, dimmed.
// Unknown tools fall through to a generic JSON-truncate so we never lose information.

export function truncate(s, n) {
  s = String(s ?? '');
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}
export function compactWs(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}
export function shortenPath(path) {
  if (!path) return '';
  // Collapse home directory to ~ so transcripts read consistently across machines.
  const norm = String(path).replace(/^\/Users\/[^/]+\//, '~/').replace(/^\/home\/[^/]+\//, '~/');
  return norm.length > 90 ? '…' + norm.slice(-89) : norm;
}

// Like projectRelativePath but for arbitrary text — substitutes anywhere in the string,
// not just at the start. Used for Bash command/description text where paths appear
// inside argv tokens, heredocs, etc.
export function projectifyText(s, ctx) {
  if (!s) return '';
  const { cwd, worktreePath } = resolvePathCtx(ctx);
  let out = String(s);
  if (cwd && typeof cwd === 'string') {
    const projectRoot = cwd.replace(/\/+$/, '');
    const projectName = projectRoot.slice(projectRoot.lastIndexOf('/') + 1);
    const roots = [projectRoot];
    if (worktreePath) {
      const wtRoot = worktreePath.replace(/\/+$/, '');
      if (wtRoot !== projectRoot) roots.push(wtRoot);
    }
    for (const root of roots) out = out.split(root).join(projectName);
  }
  return out.replace(/\/Users\/[^/\s'"]+\//g, '~/').replace(/\/home\/[^/\s'"]+\//g, '~/');
}

// Project-anchored path: when the file is under the current session's cwd, strip
// everything up to (but not including) the project directory's basename. With cwd =
// /Users/alice/code/outpost, /Users/alice/code/outpost/src/pwa/app.js becomes
// "outpost/src/pwa/app.js". Worktree sessions get the same treatment — paths under
// ~/.outpost/worktrees/<id>/ are rewritten to <projectName>/… so transcripts read the
// same regardless of whether the session is spawned in the project cwd or a worktree.
// Falls back to shortenPath (just collapsing $HOME to ~) for files outside both —
// outpost is multi-project now, so each session carries its own cwd.
export function projectRelativePath(path, ctx) {
  if (!path) return '';
  const { cwd, worktreePath } = resolvePathCtx(ctx);
  if (cwd && typeof cwd === 'string') {
    const projectRoot = cwd.replace(/\/+$/, '');
    const projectName = projectRoot.slice(projectRoot.lastIndexOf('/') + 1);
    if (path === projectRoot) return projectName;
    if (path.startsWith(projectRoot + '/')) {
      return `${projectName}/${path.slice(projectRoot.length + 1)}`;
    }
    if (worktreePath) {
      const wtRoot = worktreePath.replace(/\/+$/, '');
      if (path === wtRoot) return projectName;
      if (path.startsWith(wtRoot + '/')) {
        return `${projectName}/${path.slice(wtRoot.length + 1)}`;
      }
    }
  }
  return shortenPath(path);
}
export function shortenUrl(url) {
  const s = String(url ?? '');
  if (s.length <= 120) return s;
  // Keep the protocol+host and the last bit of the path/query so the URL is still
  // recognizable. URL parsing tolerates partial inputs via the base-URL trick.
  try {
    const u = new URL(s, 'http://_');
    const host = u.host || '';
    const proto = u.protocol === 'http:' ? '' : `${u.protocol}//`;
    const pathQ = u.pathname + u.search;
    const tail = pathQ.length > 70 ? '…' + pathQ.slice(-69) : pathQ;
    return `${proto}${host}${tail}`;
  } catch {
    return s.slice(0, 60) + '…' + s.slice(-60);
  }
}

export const MCP_SERVER_NAMES = {
  'claude_ai_DataDog_MCP': 'Datadog',
  'claude_ai_Slack': 'Slack',
  'claude_ai_PostHog': 'PostHog',
  'claude_ai_Gmail': 'Gmail',
  'claude_ai_Google_Calendar': 'Calendar',
  'claude_ai_Google_Drive': 'Drive',
  'claude_ai_Figma': 'Figma',
  'claude_ai_Salesforce': 'Salesforce',
  'claude_ai_Linear': 'Linear',
  'claude_ai_Vercel': 'Vercel',
  'claude_ai_Pylon': 'Pylon',
  'claude_ai_Clay': 'Clay',
  'claude_ai_Common_Room': 'Common Room',
  'claude_ai_Kitt_Analyst': 'Kitt',
  'claude_ai_Sumble': 'Sumble',
  'claude_ai_Ramp': 'Ramp',
  'claude_ai_Ramp_Data': 'Ramp',
  'claude_ai_Intuit_QuickBooks': 'QuickBooks',
  'plugin_linear_linear': 'Linear',
  'incident-io': 'incident.io',
  'notion': 'Notion',
  'github': 'GitHub',
  'grafana': 'Grafana',
  'posthog': 'PostHog',
};
export function prettyMcpServer(server) {
  return MCP_SERVER_NAMES[server] ?? String(server).replace(/_/g, ' ');
}

// Heuristic: pull the most likely "primary identifier" string out of an arbitrary MCP
// input. The key order is tuned to surface the human-meaningful field across the most
// common server schemas — URL / query / id / name beat content / message / description
// because the former are usually the noun the tool is acting on.
export function pickPrimary(input) {
  if (!input || typeof input !== 'object') return '';
  const keys = ['query', 'endpoint', 'url', 'path', 'file_path', 'pattern', 'channel', 'channel_id', 'incident_id', 'ticket_id', 'id', 'name', 'subject', 'title', 'description', 'prompt', 'message', 'text', 'content'];
  for (const k of keys) {
    const v = input[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return '';
}

export const TOOL_FORMATTERS = {
  Bash(inp, ctx) {
    const cmd = projectifyText(String(inp.command ?? ''), ctx);
    const desc = projectifyText(String(inp.description ?? ''), ctx);
    const label = inp.run_in_background ? 'Bash · bg' : 'Bash';
    // With a description we have prose to lead with and the command goes in the mono
    // detail line. Without a description, the command IS the summary, so it should be
    // chip-styled like other identifiers (paths, queries) — otherwise short Bash calls
    // render as plain prose, breaking the visual rhythm of the surrounding tiles.
    if (desc) return { label, body: desc, detail: `$ ${truncate(cmd, 220)}` };
    return { label, body: truncate(cmd, 140), bodyKind: 'code' };
  },
  Read(inp, ctx) {
    const range = inp.offset != null
      ? `lines ${inp.offset}–${inp.offset + (inp.limit ?? 0) || inp.offset}`
      : inp.pages ? `pages ${inp.pages}` : null;
    return { label: 'Read', body: projectRelativePath(inp.file_path, ctx), bodyKind: 'code', detail: range };
  },
  Edit(inp, ctx) {
    // Collapsed: label + filename only. Expanded (renderEditDiff): the filename moves
    // into the diff's header bar and the collapsed summary is hidden — see the
    // .tool_use-expanded:has(.tool-diff) rule in CSS. The summary uses bodyKind='path'
    // for plain mono (no chip), matching the inline Read/Bash/Grep aesthetic.
    return {
      label: inp.replace_all ? 'Edit · all' : 'Edit',
      body: projectRelativePath(inp.file_path, ctx),
      bodyKind: 'path',
    };
  },
  Write(inp, ctx) {
    // Mirrors Edit: filename in the summary, full content lives in the expanded
    // header (renderWriteContent). The collapsed summary is hidden when expanded
    // via the :has(.tool-write) CSS rule so the path appears only once.
    return {
      label: 'Write',
      body: projectRelativePath(inp.file_path, ctx),
      bodyKind: 'path',
    };
  },
  Grep(_inp) {
    // Grep's primary representation is the rg-style command block — see renderGrepSearch.
    // Setting alwaysExpanded skips the summary/detail rows and the expand/collapse chrome
    // so the block reads as the tile's main content.
    return {
      label: 'Grep',
      alwaysExpanded: true,
    };
  },
  Glob(inp, ctx) {
    return {
      label: 'Glob',
      body: String(inp.pattern ?? ''),
      bodyKind: 'code',
      detail: inp.path ? `in ${projectRelativePath(inp.path, ctx)}` : null,
    };
  },
  ToolSearch(inp) {
    const q = String(inp.query ?? '');
    const sel = q.match(/^select:(.+)$/);
    if (sel) {
      const tools = sel[1].split(',').map((s) => s.trim()).filter(Boolean);
      const label = 'ToolSearch · load';
      if (tools.length === 1) return { label, body: tools[0], bodyKind: 'code' };
      return { label, body: `${tools.length} tools`, detail: tools.join(', ') };
    }
    return { label: 'ToolSearch', body: truncate(q, 140), bodyKind: 'code' };
  },
  WebFetch(inp) {
    // Two-line shell vocab: `# ` is the bash-comment marker for the extraction
    // brief (prose intent), `<< ` mirrors Read's slurp glyph for the URL being
    // fetched. With no prompt the URL takes the body line directly.
    const url = shortenUrl(inp.url);
    const prompt = compactWs(inp.prompt);
    if (prompt) {
      return {
        label: 'WebFetch',
        body: `# ${truncate(prompt, 140)}`,
        bodyKind: 'code',
        detail: `<< ${url}`,
      };
    }
    return { label: 'WebFetch', body: `<< ${url}`, bodyKind: 'code' };
  },
  WebSearch(inp) {
    // `? ` marker signals "query" — same shell-vocab family as Bash's `$`,
    // Read's `<<`, WebFetch's `# `/`<<`.
    return {
      label: 'WebSearch',
      body: `? ${truncate(String(inp.query ?? ''), 140)}`,
      bodyKind: 'code',
    };
  },
  Agent(inp) {
    const type = inp.subagent_type ? ` · ${inp.subagent_type}` : '';
    return { label: `Agent${type}`, body: compactWs(inp.description) };
  },
  AskUserQuestion(inp) {
    const qs = Array.isArray(inp.questions) ? inp.questions : [];
    const first = qs[0]?.question ?? '';
    const more = qs.length > 1 ? ` (+${qs.length - 1})` : '';
    return { label: 'Ask', body: truncate(String(first), 160) + more };
  },
  Skill(inp) {
    return {
      label: 'Skill',
      body: String(inp.skill ?? ''),
      detail: inp.args ? truncate(String(inp.args), 120) : null,
    };
  },
  ScheduleWakeup(inp) {
    const s = Number(inp.delaySeconds ?? 0);
    const dur = s >= 3600 ? `${(s / 3600).toFixed(1)}h` : s >= 60 ? `${Math.round(s / 60)}m` : `${s}s`;
    return {
      label: 'Wakeup',
      body: compactWs(inp.reason) || `in ${dur}`,
      detail: `wake in ${dur}`,
    };
  },
  Monitor(inp) {
    const id = inp.taskId ?? inp.shellId ?? inp.shell_id ?? '?';
    return { label: 'Monitor', body: `task ${id}` };
  },
  NotebookEdit(inp) {
    return { label: 'NotebookEdit', body: shortenPath(inp.notebook_path), bodyKind: 'code' };
  },
  ExitPlanMode(inp) {
    return { label: 'ExitPlanMode', body: truncate(compactWs(inp.plan), 160) };
  },
};

export function formatToolUse(name, input, fallback, ctx) {
  if (!name) return { label: 'Tool', body: fallback || '' };
  const inp = (input && typeof input === 'object') ? input : {};

  if (name.startsWith('mcp__')) {
    const parts = name.split('__');
    const server = parts[1] ?? '?';
    const tool = parts.slice(2).join('__');
    // telemetry.intent is a DataDog MCP convention: a natural-language sentence Claude
    // attaches to each call explaining WHY it's making it. When present it's strictly
    // better than any heuristic-picked input field — render it as prose, not code.
    const intent = (inp.telemetry && typeof inp.telemetry === 'object')
      ? inp.telemetry.intent
      : null;
    if (typeof intent === 'string' && intent.length > 0) {
      return {
        label: `${prettyMcpServer(server)} · ${tool}`,
        body: truncate(compactWs(intent), 240),
      };
    }
    // High-traffic MCP tools get bespoke handling so the body line reads naturally rather
    // than dumping a random field. Everything else falls back to the primary-field heuristic.
    if (name === 'mcp__grafana__grafana_api_request') {
      return {
        label: `Grafana · ${tool}`,
        body: `${inp.method ?? 'GET'} ${shortenUrl(inp.endpoint)}`,
        bodyKind: 'code',
      };
    }
    if (name === 'mcp__grafana__query_loki_logs' || name === 'mcp__grafana__query_loki_stats' || name === 'mcp__grafana__query_loki_patterns') {
      return { label: `Grafana · ${tool}`, body: truncate(String(inp.logql ?? inp.query ?? ''), 180), bodyKind: 'code' };
    }
    if (name === 'mcp__grafana__query_prometheus' || name === 'mcp__grafana__query_prometheus_histogram') {
      return { label: `Grafana · ${tool}`, body: truncate(String(inp.expr ?? inp.query ?? ''), 180), bodyKind: 'code' };
    }
    const primary = pickPrimary(inp);
    // MCP primary fields are almost always identifiers (query, endpoint, url, id, name).
    // Default to code; the rare prose-y field will look fine in mono too.
    return {
      label: `${prettyMcpServer(server)} · ${tool}`,
      body: primary ? truncate(compactWs(primary), 200) : truncate(JSON.stringify(inp), 120),
      bodyKind: 'code',
    };
  }

  const handler = TOOL_FORMATTERS[name];
  if (handler) {
    const out = handler(inp, ctx);
    return {
      label: out.label || name,
      body: out.body || '',
      detail: out.detail || null,
      // bodyKind needs to ride through this normalizer too — otherwise formatters can set
      // it but the renderer never sees it. (Was silently dropped, which is why Read/Edit/
      // Write/Grep/etc. weren't getting the inline-code chip even though they declared it.)
      bodyKind: out.bodyKind,
      // alwaysExpanded — formatters can opt out of the expand/collapse chrome and force
      // the structured payload to render as the tile's primary content (Grep does this).
      alwaysExpanded: out.alwaysExpanded,
    };
  }
  // Unknown tool: keep working, just dump compact JSON. Better than nothing.
  return { label: name, body: truncate(JSON.stringify(inp), 140) };
}
