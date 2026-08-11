// The PR-reply flavour of a write draft. `code.reply-pr-comments` drafts one call per reply,
// and a reply only makes sense next to the comment it answers — so pr-block.js drops each
// call into its own thread card instead of stacking them in a generic approval card, and this
// module is the translation layer: which comment a call answers, and where inside it the prose
// the user actually reviews lives.
//
// The join key is the call's `label`, which the action sets to the comment id verbatim (see
// actions/code/reply-pr-comments/SKILL.md, Step 3). The body is always routed through a `files`
// entry rather than inlined in the command, for the same reason: a shell-quoted body can't be
// handed to a textarea and read back without re-quoting it, and getting that wrong on a public
// PR is not a recoverable mistake.

import { cssId, fileFieldHtml } from './write-draft-card.js';

function escapeHtml(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }

export const REPLY_ACTION = 'code.reply-pr-comments';

export function isReplyDraft(draft) {
  return !!draft && !draft.approvedAt && draft.action === REPLY_ACTION;
}

// The two commands SKILL.md prescribes, and nothing else. Matching one exactly is what
// licenses showing the user the reply text ALONE: the command is then fully determined — it
// posts the named file to the thread this reply is rendered under, and there is nothing left
// in it worth reading. A call that deviates by so much as a flag is shown as its raw command
// instead, because at that point the daemon cannot tell them what it does. Quoting of the
// endpoint/path and the `--method`/`-X` spelling are the only slack; both are the same command.
const CANONICAL_REPLY = [
  /^gh api (?:--method|-X) POST "?repos\/\{owner\}\/\{repo\}\/pulls\/comments\/\d+\/replies"? --input ("?)(\/tmp\/[A-Za-z0-9_][A-Za-z0-9._-]*\.json)\1$/,
  /^gh pr comment \d+ --body-file ("?)(\/tmp\/[A-Za-z0-9_][A-Za-z0-9._-]*\.md)\1$/,
];

function canonicalReplyPath(bash) {
  const text = String(bash ?? '').trim();
  for (const re of CANONICAL_REPLY) {
    const m = text.match(re);
    if (m) return m[2];
  }
  return null;
}

// The prose a call will post, and where it sits in the drafted file. `--input` takes the
// endpoint's JSON body (`{"body": …}`), `--body-file` takes the markdown itself — told apart by
// the extension the command itself names, not by sniffing the content, so a reply that
// legitimately opens with `{` doesn't get read as JSON.
//
// Returns null unless the whole call is accounted for: a canonical command, exactly one drafted
// file, and that file being the one the command actually reads. Without the last check the
// daemon would be showing the user one body while the command posts another.
export function replyBodyOf(call) {
  const path = canonicalReplyPath(call?.bash);
  if (!path) return null;
  const entries = Object.entries(call?.files ?? {});
  if (entries.length !== 1 || entries[0][0] !== path) return null;
  const content = entries[0][1];
  if (!path.endsWith('.json')) return { path, text: content };
  let parsed;
  try { parsed = JSON.parse(content); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof parsed.body !== 'string') return null;
  return { path, text: parsed.body, jsonKey: 'body' };
}

// commentId -> {call, idx}. First label wins: two calls answering one comment would post twice
// into the same thread, and the second has nowhere of its own to render — pr-block.js surfaces
// the unclaimed one alongside the threads, as its raw command, rather than dropping it.
export function replyCallsByComment(draft) {
  const map = new Map();
  (draft?.calls ?? []).forEach((call, idx) => {
    if (typeof call.label === 'string' && call.label && !map.has(call.label)) map.set(call.label, { call, idx });
  });
  return map;
}

// The per-reply verdict. A checkbox rather than a toggle button on purpose: detail.js's
// snapshotUi/restoreUi preserves `.wd-card [id^="wd-f-"]` fields across a store-driven repaint
// (checkboxes by `checked`), so an "ignore this one" survives a sibling step's unrelated
// progress tick — a button's pressed state would not. `data-arg-key` is what keys that
// snapshot; `skip!` can't collide with a `files` path, which is always `/tmp/…`.
function skipFieldHtml(draftId, idx) {
  const id = `wd-f-${cssId(draftId)}-${idx}-skip`;
  return `
    <label class="thread-reply-skip field-check">
      <input type="checkbox" id="${id}" data-call-idx="${idx}" data-arg-key="skip!" data-kind="skip" />
      <span>Ignore — don't post this one</span>
    </label>`;
}

// One reply, sitting in the conversation directly under the comment it answers. When the call
// is canonical (see CANONICAL_REPLY) the whole thing is just the text — the command carries no
// information the thread it's nested in doesn't already give — plus the skip box, which is the
// answer to "this comment doesn't need a reply".
//
// The `.wd-call` / `data-call-idx` / `data-kind` shape is load-bearing: collectCalls
// (write-draft-card.js) reads the edited payload and the verdict back off exactly these
// attributes, and the command is deliberately NOT a `[data-kind="bash"]` textarea, so it reads
// back as the drafted text untouched however it is displayed.
//
// `label` names the comment when the reply is rendered outside its thread (nothing on this PR
// matches its id) — inside a thread the thread itself is the label.
export function renderReplyCallHtml(draft, call, idx, { label } = {}) {
  const body = replyBodyOf(call);
  const head = label ? `Reply to ${label}` : 'Reply';
  // A call this module can't fully account for — an inline `-f body=…` from before the files
  // convention, or any command that isn't one of the two canonical shapes — is still the
  // user's to skip or approve, so it keeps the frame and the verdict. It just shows the raw
  // payload, since that's the only honest thing to show for a command nothing has vouched for.
  if (!body) {
    return `
      <fieldset class="wd-call thread-reply thread-reply--raw" data-call-idx="${idx}" data-call-kind="bash">
        <legend class="o-sr-only">${escapeHtml(head)}</legend>
        <div class="thread-reply-head o-microhead" aria-hidden="true">${escapeHtml(head)} — unrecognised command</div>
        <pre class="thread-reply-cmd-text">${escapeHtml(call.bash ?? JSON.stringify(call.tool ?? {}))}</pre>
        ${skipFieldHtml(draft.id, idx)}
      </fieldset>`;
  }
  return `
    <fieldset class="wd-call thread-reply" data-call-idx="${idx}" data-call-kind="bash">
      <legend class="o-sr-only">${escapeHtml(head)}</legend>
      ${label ? `<div class="thread-reply-head o-microhead" aria-hidden="true">${escapeHtml(head)}</div>` : ''}
      ${fileFieldHtml(draft.id, idx, body.path, call.files[body.path], {
    label: head,
    labelClass: 'o-sr-only',
    className: 'thread-reply-input',
    value: body.text,
    jsonKey: body.jsonKey,
  })}
      ${skipFieldHtml(draft.id, idx)}
    </fieldset>`;
}

// What Accept will actually do, given how many replies are currently ignored. Named rather
// than left as "Accept": with a per-call verdict in play, the button's job changes as the
// boxes are ticked, and "Accept" would read as approving the ones you just crossed out.
export function replyAcceptLabel(total, skipped) {
  const posting = total - skipped;
  if (posting <= 0) return 'Post nothing';
  if (!skipped) return posting === 1 ? 'Post reply' : `Post ${posting} replies`;
  return `Post ${posting} of ${total}`;
}

// Keeps the Accept button honest as the skip boxes are ticked. Everything else about the
// draft — Accept itself, Propose changes, the error slot — is wireWriteDraft's, unchanged.
export function wireReplyDraft(root, draft) {
  const card = root.querySelector(`.wd-card[data-draft-id="${CSS.escape(draft.id)}"]`);
  if (!card) return;
  const accept = card.querySelector('[data-wd-action="accept"]');
  if (!accept) return;
  const boxes = [...card.querySelectorAll('[data-kind="skip"]')];
  const sync = () => {
    accept.textContent = replyAcceptLabel(draft.calls.length, boxes.filter((b) => b.checked).length);
  };
  boxes.forEach((b) => b.addEventListener('change', sync));
  sync();
}
