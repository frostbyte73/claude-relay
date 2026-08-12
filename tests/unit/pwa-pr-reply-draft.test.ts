// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { isReplyDraft, replyAcceptLabel, replyBodyOf, replyCallsByComment } from '../../src/pwa/components/work/reply-draft.js';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { renderPrBlockHtml } from '../../src/pwa/components/work/pr-block.js';

const REPLY_ACTION = 'code.reply-pr-comments';

const comment = (over: Record<string, unknown> = {}) => ({
  id: 'review:ABC', author: 'octocat', body: 'rename this', file: 'a.ts', line: 3,
  createdAt: 1000, ...over,
});

const jsonCall = (over: Record<string, unknown> = {}) => ({
  label: 'review:ABC',
  bash: 'gh api --method POST "repos/{owner}/{repo}/pulls/comments/9/replies" --input /tmp/outpost-reply-1.json',
  files: { '/tmp/outpost-reply-1.json': '{"body": "renamed in `abc123`"}' },
  ...over,
});

const draft = (over: Record<string, unknown> = {}) => ({
  id: 'd1', action: REPLY_ACTION, raisedBy: { kind: 'controller' },
  summary: 'Post 1 reply on acme/widgets#7', calls: [jsonCall()], requestedAt: 1,
  ...over,
});

const step = (over: Record<string, unknown> = {}) => ({
  id: 's1', title: 'Ship it', sessionId: 'ctrl-sess',
  workspace: { kind: 'writable', repoCwd: '/tmp/repo', branch: 'outpost/abc' },
  prUrl: 'https://github.com/acme/widgets/pull/7',
  comments: [comment()],
  ...over,
});

describe('replyBodyOf — where the reviewable prose lives', () => {
  // The `--input` payload is the endpoint's JSON body, so the prose is one key inside it.
  // Handing the user the raw `{"body": …}` is what this whole path exists to avoid.
  it('unwraps a .json file to its `body` string', () => {
    expect(replyBodyOf(jsonCall())).toEqual({
      path: '/tmp/outpost-reply-1.json', text: 'renamed in `abc123`', jsonKey: 'body', editable: true,
    });
  });

  // Told apart by the extension the command names, never by sniffing the content — a markdown
  // reply that opens with `{` is ordinary prose, not a payload to parse.
  it('takes a .md file as the reply itself, with no jsonKey', () => {
    const call = { bash: 'gh pr comment 7 --body-file /tmp/outpost-reply-2.md', files: { '/tmp/outpost-reply-2.md': '{not json}' } };
    expect(replyBodyOf(call)).toEqual({ path: '/tmp/outpost-reply-2.md', text: '{not json}', editable: true });
  });

  it('accepts the quoting and --method/-X spellings of the same command', () => {
    const files = { '/tmp/outpost-reply-1.json': '{"body": "ok"}' };
    expect(replyBodyOf({ bash: 'gh api -X POST repos/{owner}/{repo}/pulls/comments/9/replies --input "/tmp/outpost-reply-1.json"', files })?.text).toBe('ok');
  });

  it('returns null for a shape it cannot read — two files, non-{body} json', () => {
    expect(replyBodyOf({ bash: 'gh pr comment 7 --body-file /tmp/a.md', files: { '/tmp/a.md': 'a', '/tmp/b.md': 'b' } })).toBeNull();
    expect(replyBodyOf({ ...jsonCall(), files: { '/tmp/outpost-reply-1.json': '{"text": "wrong key"}' } })).toBeNull();
    expect(replyBodyOf({ ...jsonCall(), files: { '/tmp/outpost-reply-1.json': 'not json at all' } })).toBeNull();
  });

  // Showing only the reply text is a claim about what the command does; anything the canonical
  // pattern doesn't cover gets shown as its command instead, because nothing has vouched for it.
  it('returns null for a command that is not one of the two canonical shapes', () => {
    const files = { '/tmp/outpost-reply-1.json': '{"body": "ok"}' };
    expect(replyBodyOf({ bash: 'gh api --method PUT "repos/{owner}/{repo}/pulls/comments/9/replies" --input /tmp/outpost-reply-1.json', files })).toBeNull();
    expect(replyBodyOf({ bash: 'gh api --method POST "repos/octo/evil/pulls/comments/9/replies" --input /tmp/outpost-reply-1.json', files })).toBeNull();
    expect(replyBodyOf({ bash: 'gh api --method POST "repos/{owner}/{repo}/pulls/comments/9/replies" --input /tmp/outpost-reply-1.json; rm -rf /', files })).toBeNull();
  });

  // The text shown has to be the text that posts: a command reading a different file than the
  // one drafted would put unreviewed bytes on a public PR under a body the user did approve.
  it('returns null when the drafted file is not the one the command reads', () => {
    expect(replyBodyOf({
      bash: 'gh pr comment 7 --body-file /tmp/outpost-reply-2.md',
      files: { '/tmp/outpost-reply-9.md': 'a different body' },
    })).toBeNull();
  });

  // Drafts raised before the `files` convention carry the body in the command. It reads fine;
  // it just can't be edited back in, since the allowlist has no spelling for a body with an
  // apostrophe or a newline.
  it('reads an inline body, and marks it not editable', () => {
    expect(replyBodyOf({ bash: "gh pr comment 16434 --body 'Ack — holding the merge.'" }))
      .toEqual({ text: 'Ack — holding the merge.', editable: false });
    expect(replyBodyOf({ bash: 'gh api --method POST "repos/{owner}/{repo}/pulls/comments/9/replies" -f body="done"' }))
      .toEqual({ text: 'done', editable: false });
  });
});

describe('isReplyDraft', () => {
  it('claims only an unapproved draft from the reply action', () => {
    expect(isReplyDraft(draft())).toBe(true);
    expect(isReplyDraft(draft({ action: 'code.merge-pr' }))).toBe(false);
    expect(isReplyDraft(draft({ approvedAt: 5 }))).toBe(false);
    expect(isReplyDraft(undefined)).toBe(false);
  });
});

describe('replyCallsByComment', () => {
  it('keys calls by their label and keeps the first of a duplicate', () => {
    const d = draft({ calls: [jsonCall(), jsonCall({ label: 'issue:12' }), jsonCall({ files: { '/tmp/outpost-reply-3.json': '{"body":"second"}' } })] });
    const map = replyCallsByComment(d, ['review:ABC', 'issue:12']);
    expect(map.get('review:ABC').idx).toBe(0);
    expect(map.get('issue:12').idx).toBe(1);
    expect(map.size).toBe(2);
  });

  // The label is prose written by a model and it decorates in practice. Demanding equality made
  // every real draft unmatched, which is what pushed all the replies out of the threads and
  // into the leftovers block.
  it('resolves a label that names the comment id alongside other text', () => {
    const d = draft({ calls: [jsonCall({ label: 'issue:IC_kwDO123 — reply to milos-lk (merge-timing ack)' })] });
    expect(replyCallsByComment(d, ['issue:IC_kwDO123']).get('issue:IC_kwDO123')?.idx).toBe(0);
  });

  it('prefers the longer id when a label could name either', () => {
    const d = draft({ calls: [jsonCall({ label: 'review:PRRC_abc123 needs an answer' })] });
    const map = replyCallsByComment(d, ['review:PRRC_abc', 'review:PRRC_abc123']);
    expect(map.has('review:PRRC_abc123')).toBe(true);
    expect(map.has('review:PRRC_abc')).toBe(false);
  });

  it('matches nothing when the label names no comment on this PR', () => {
    const d = draft({ calls: [jsonCall({ label: 'review:GONE' })] });
    expect(replyCallsByComment(d, ['review:ABC']).size).toBe(0);
  });
});

// The button has to say what it will do as the skip boxes are ticked — left as "Accept" it
// would read as approving the replies you just crossed out.
describe('replyAcceptLabel', () => {
  it('counts what will actually be posted', () => {
    expect(replyAcceptLabel(1, 0)).toBe('Post reply');
    expect(replyAcceptLabel(3, 0)).toBe('Post 3 replies');
    expect(replyAcceptLabel(3, 1)).toBe('Post 2 of 3');
    expect(replyAcceptLabel(3, 3)).toBe('Post nothing');
  });
});

describe('renderPrBlockHtml — a pending reply draft renders in the threads', () => {
  it('puts the reply body in its own comment thread, as a field, not as a command', () => {
    const html = renderPrBlockHtml({}, step(), { replyDraft: draft() });
    // The card wraps the threads region, so wireWriteDraft/collectCalls find it as usual.
    expect(html).toContain('class="wd-card wd-card--replies" data-draft-id="d1"');
    expect(html).toContain('data-wd-action="accept"');
    // The prose is the editable value; the JSON wrapper never reaches the user.
    expect(html).toContain('renamed in `abc123`');
    expect(html).not.toContain('{&quot;body&quot;');
    // …and it lands inside the thread for the comment it answers.
    const thread = html.slice(html.indexOf('data-comment-id="review:ABC"'));
    expect(thread.slice(0, thread.indexOf('</li>'))).toContain('thread-reply-input');
  });

  // A canonical call is fully described by the comment it sits under, so the command is noise.
  it('shows only the text for a canonical call, and the command for anything else', () => {
    const clean = renderPrBlockHtml({}, step(), { replyDraft: draft() });
    expect(clean).not.toContain('gh api --method POST');
    expect(clean).not.toContain('thread-reply--raw');

    const odd = renderPrBlockHtml({}, step(), {
      replyDraft: draft({ calls: [jsonCall({ bash: 'gh pr comment 7 --body "hi" && git push --force', files: undefined })] }),
    });
    expect(odd).toContain('thread-reply--raw');
    expect(odd).toContain('git push --force');
    expect(odd).toContain('data-kind="skip"');
  });

  // The exact shape of the draft that was pending when this was reported: decorated labels and
  // inline bodies, one reply per root comment. It rendered as comment, comment, reply, reply.
  it('interleaves a legacy draft — decorated labels, inline bodies — with its comments', () => {
    const html = renderPrBlockHtml({}, step({
      comments: [
        comment({ id: 'issue:IC_kwDO1', author: 'milos-lk', body: 'when does this merge?', file: undefined }),
        comment({ id: 'review:PRR_kwDO2', author: 'shawnfeldman', body: 'why both flags?', file: undefined, createdAt: 1100 }),
      ],
    }), {
      replyDraft: draft({
        calls: [
          { label: 'issue:IC_kwDO1 — reply to milos-lk (merge-timing ack)', bash: "gh pr comment 16434 --body 'Holding until Aug 12.'" },
          { label: 'review:PRR_kwDO2 — reply to shawnfeldman (why both flags)', bash: "gh pr comment 16434 --body 'They flip as a set.'" },
        ],
      }),
    });
    expect(html).not.toContain('pr-reply-unclaimed');
    const order = ['when does this merge?', 'Holding until Aug 12.', 'why both flags?', 'They flip as a set.']
      .map((s) => html.indexOf(s));
    expect(order.every((i) => i > -1)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  // Directly under the message it answers, not trailing the whole card — and each reply under
  // its own comment when a draft answers two messages in one thread.
  it('nests each reply beneath the comment it replies to', () => {
    const chain = [
      comment(),
      comment({ id: 'review:DEF', author: 'hubot', body: 'and this', inReplyTo: 'review:ABC', createdAt: 1100 }),
    ];
    const html = renderPrBlockHtml({}, step({ comments: chain }), {
      replyDraft: draft({
        calls: [
          jsonCall(),
          jsonCall({
            label: 'review:DEF',
            bash: 'gh api --method POST "repos/{owner}/{repo}/pulls/comments/10/replies" --input /tmp/outpost-reply-2.json',
            files: { '/tmp/outpost-reply-2.json': '{"body": "second answer"}' },
          }),
        ],
      }),
    });
    // Each reply sits between its own comment and the next one.
    const order = ['rename this', 'renamed in `abc123`', 'and this', 'second answer']
      .map((s) => html.indexOf(s));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((i) => i > -1)).toBe(true);
  });

  it('tags the field for read-back and repaint preservation', () => {
    const html = renderPrBlockHtml({}, step(), { replyDraft: draft() });
    const m = html.match(/<textarea[^>]*data-kind="file"[^>]*>/);
    expect(m?.[0]).toContain('id="wd-f-d1-0-file-_tmp_outpost-reply-1_json"');
    expect(m?.[0]).toContain('data-call-idx="0"');
    expect(m?.[0]).toContain('data-arg-key="/tmp/outpost-reply-1.json"');
    expect(m?.[0]).toContain('data-file-json-key="body"');
  });

  // The reply is the only thing waiting on the user; a resolved thread's collapsed disclosure
  // would hide a pending write behind a click.
  it('keeps a thread the draft answers out of the resolved disclosure', () => {
    const html = renderPrBlockHtml({}, step({ comments: [comment({ respondedAt: 2000 })] }), { replyDraft: draft() });
    const resolved = html.indexOf('pr-threads-resolved');
    expect(html.indexOf('data-comment-id="review:ABC"')).toBeGreaterThan(-1);
    expect(resolved).toBe(-1);
  });

  // A label naming no comment on this PR still posts if accepted, so it has to stay visible in
  // the payload the user is approving.
  it('shows a call whose label matches no thread as its raw command', () => {
    const html = renderPrBlockHtml({}, step(), {
      replyDraft: draft({ calls: [jsonCall({ label: 'review:GONE' })] }),
    });
    expect(html).toContain('pr-reply-unclaimed');
    // No thread is naming its target, so the reply names it itself.
    expect(html).toContain('Reply to review:GONE');
    expect(html).toContain('renamed in `abc123`');
  });

  // Denying the whole thing isn't a verdict that fits: drafting replies is always right once
  // there are new comments. Per-reply skip is the answer instead.
  it('offers a per-reply skip and no Deny', () => {
    const html = renderPrBlockHtml({}, step(), { replyDraft: draft() });
    expect(html).toContain('data-kind="skip"');
    expect(html).toContain('data-wd-action="toggle-revise"');
    expect(html).not.toContain('data-wd-action="toggle-deny"');
    expect(html).not.toContain('data-wd-action="submit-deny"');
  });

  it('names what Accept will actually post', () => {
    expect(renderPrBlockHtml({}, step(), { replyDraft: draft() })).toContain('>Post reply<');
  });

  it('leaves the threads untouched with no draft, and ignores another action\'s draft', () => {
    expect(renderPrBlockHtml({}, step())).not.toContain('wd-card');
    expect(renderPrBlockHtml({}, step(), { replyDraft: draft({ action: 'code.merge-pr' }) })).not.toContain('wd-card');
  });
});
