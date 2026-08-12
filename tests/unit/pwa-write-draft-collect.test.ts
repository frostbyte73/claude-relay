// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

// wireWriteDraft reaches the daemon through state/work.js and toasts through app-bridge.js;
// neither is under test here — what is, is the payload Accept assembles out of the edited DOM.
// jsdom ships no CSS.escape; every real target has it. Draft ids are `d<n>`, so identity is a
// faithful stand-in here.
if (typeof CSS === 'undefined') (globalThis as any).CSS = { escape: (s: string) => s };

const acceptDraft = vi.fn(async () => {});
vi.mock('../../src/pwa/state/work.js', () => ({ work: { acceptDraft, reviseDraft: vi.fn(), denyDraft: vi.fn() } }));
vi.mock('../../src/pwa/app-bridge.js', () => ({ showStatusToast: vi.fn() }));

// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
const { renderWriteDraft, wireWriteDraft } = await import('../../src/pwa/components/work/write-draft-card.js');
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
const { renderReplyCallHtml } = await import('../../src/pwa/components/work/reply-draft.js');

const call = {
  label: 'review:ABC',
  bash: 'gh api --method POST "repos/{owner}/{repo}/pulls/comments/9/replies" --input /tmp/outpost-reply-1.json',
  files: { '/tmp/outpost-reply-1.json': '{"body": "original", "in_reply_to": 9}' },
};
const draft = { id: 'd1', action: 'code.reply-pr-comments', summary: 'Post 1 reply', calls: [call], requestedAt: 1 };

function mountReply() {
  const root = document.createElement('div');
  // The shape pr-block.js builds: the draft's card wrapped around a reply field rendered by
  // reply-draft.js rather than around write-draft-card's own generic call fieldsets.
  root.innerHTML = `<div class="wd-card" data-draft-id="d1">${renderReplyCallHtml(draft, call, 0)}
    <div class="wd-error work-error" data-wd-error hidden></div>
    <div class="step-actions"><button data-wd-action="accept">Accept</button></div></div>`;
  document.body.replaceChildren(root);
  wireWriteDraft(root, { jobId: 'j1', stepId: 's1', draft });
  return root;
}

beforeEach(() => acceptDraft.mockClear());

describe('collectCalls — a reply edited as prose, pinned as the file it lives in', () => {
  it('re-serializes the edit onto the original JSON, keeping its other keys', () => {
    const root = mountReply();
    root.querySelector<HTMLTextAreaElement>('[data-kind="file"]')!.value = 'edited reply';
    root.querySelector<HTMLButtonElement>('[data-wd-action="accept"]')!.click();
    expect(acceptDraft).toHaveBeenCalledOnce();
    const [, , , calls] = acceptDraft.mock.calls[0] as unknown as [string, string, string, any[]];
    expect(JSON.parse(calls[0].files['/tmp/outpost-reply-1.json'])).toEqual({ body: 'edited reply', in_reply_to: 9 });
  });

  // reply-draft.js renders the command read-only, so there is no [data-kind="bash"] field to
  // read — the drafted text has to survive that, or Accept would pin an empty command.
  it('falls back to the drafted command when the layout offers no bash field', () => {
    const root = mountReply();
    root.querySelector<HTMLButtonElement>('[data-wd-action="accept"]')!.click();
    const [, , , calls] = acceptDraft.mock.calls[0] as unknown as [string, string, string, any[]];
    expect(calls[0].bash).toBe(call.bash);
    expect(calls[0].label).toBe('review:ABC');
  });

  it('blocks Accept when the drafted file is no longer reassemblable', () => {
    const bad = { ...draft, calls: [{ ...call, files: { '/tmp/outpost-reply-1.json': 'not json' } }] };
    const root = document.createElement('div');
    root.innerHTML = `<div class="wd-card" data-draft-id="d1">
      <fieldset class="wd-call" data-call-idx="0">
        <textarea id="wd-f-d1-0-file-x" data-call-idx="0" data-arg-key="/tmp/outpost-reply-1.json" data-kind="file" data-file-json-key="body">hi</textarea>
      </fieldset>
      <div class="wd-error work-error" data-wd-error hidden></div>
      <div class="step-actions"><button data-wd-action="accept">Accept</button></div></div>`;
    wireWriteDraft(root, { jobId: 'j1', stepId: 's1', draft: bad });
    root.querySelector<HTMLButtonElement>('[data-wd-action="accept"]')!.click();
    expect(acceptDraft).not.toHaveBeenCalled();
    expect(root.querySelector('[data-wd-error]')!.textContent).toContain('no longer valid JSON');
  });

  // The whole point of the per-call verdict: answering "post this one, not that one" in the
  // submission the user is already making, instead of a redraft round-trip.
  it('marks a ticked reply as skipped and sends its drafted payload untouched', () => {
    const root = mountReply();
    root.querySelector<HTMLTextAreaElement>('[data-kind="file"]')!.value = 'half-typed edit';
    root.querySelector<HTMLInputElement>('[data-kind="skip"]')!.checked = true;
    root.querySelector<HTMLButtonElement>('[data-wd-action="accept"]')!.click();
    const [, , , calls] = acceptDraft.mock.calls[0] as unknown as [string, string, string, any[]];
    expect(calls[0]).toEqual({ label: 'review:ABC', bash: call.bash, skip: true });
  });

  // A call the user has already decided not to run must not be able to block the ones they did
  // approve — reading its fields back at all is what would let a bad edit do that.
  it('does not validate the fields of a skipped call', () => {
    const bad = { ...draft, calls: [{ ...call, files: { '/tmp/outpost-reply-1.json': 'not json' } }] };
    const root = document.createElement('div');
    root.innerHTML = `<div class="wd-card" data-draft-id="d1">
      <fieldset class="wd-call" data-call-idx="0">
        <input type="checkbox" id="wd-f-d1-0-skip" data-call-idx="0" data-arg-key="skip!" data-kind="skip" checked />
        <textarea id="wd-f-d1-0-file-x" data-call-idx="0" data-arg-key="/tmp/outpost-reply-1.json" data-kind="file" data-file-json-key="body">hi</textarea>
      </fieldset>
      <div class="wd-error work-error" data-wd-error hidden></div>
      <div class="step-actions"><button data-wd-action="accept">Accept</button></div></div>`;
    wireWriteDraft(root, { jobId: 'j1', stepId: 's1', draft: bad });
    root.querySelector<HTMLButtonElement>('[data-wd-action="accept"]')!.click();
    expect(acceptDraft).toHaveBeenCalledOnce();
    expect(root.querySelector<HTMLElement>('[data-wd-error]')!.hidden).toBe(true);
  });

  // An inline body has no allowlisted spelling that can hold an arbitrary edit, so editing one
  // moves it to the form built for arbitrary bodies. Untouched, it stays exactly as drafted —
  // approving a reply you didn't change shouldn't run a different command than the action wrote.
  describe('an inline-body reply, made editable by rewriting the call', () => {
    const inline = {
      label: 'issue:IC_1',
      bash: "gh pr comment 16434 --body 'Holding until Aug 12.'",
    };
    const inlineDraft = { ...draft, calls: [inline] };
    const mount = () => {
      const root = document.createElement('div');
      root.innerHTML = `<div class="wd-card" data-draft-id="d1">${renderReplyCallHtml(inlineDraft, inline, 0)}
        <div class="wd-error work-error" data-wd-error hidden></div>
        <div class="step-actions"><button data-wd-action="accept">Accept</button></div></div>`;
      wireWriteDraft(root, { jobId: 'j1', stepId: 's1', draft: inlineDraft });
      return root;
    };

    it('pins the drafted command untouched when the text is not changed', () => {
      const root = mount();
      root.querySelector<HTMLButtonElement>('[data-wd-action="accept"]')!.click();
      const [, , , calls] = acceptDraft.mock.calls[0] as unknown as [string, string, string, any[]];
      expect(calls[0]).toEqual({ label: 'issue:IC_1', bash: inline.bash });
    });

    it('moves an edited body to the file-referencing form, keeping the command prefix', () => {
      const root = mount();
      // An apostrophe and a newline: exactly what `--body '…'` has no legal spelling for.
      root.querySelector<HTMLTextAreaElement>('[data-kind="rewrite"]')!.value = "Won't merge yet.\nSecond line.";
      root.querySelector<HTMLButtonElement>('[data-wd-action="accept"]')!.click();
      const [, , , calls] = acceptDraft.mock.calls[0] as unknown as [string, string, string, any[]];
      expect(calls[0].bash).toBe('gh pr comment 16434 --body-file /tmp/outpost-reply-d1-0.md');
      expect(calls[0].files).toEqual({ '/tmp/outpost-reply-d1-0.md': "Won't merge yet.\nSecond line." });
    });

    it('wraps an edited threaded reply as the endpoint\'s JSON body', () => {
      const api = {
        label: 'review:PRRC_1',
        bash: 'gh api --method POST "repos/{owner}/{repo}/pulls/comments/9/replies" -f body=\'ok\'',
      };
      const d = { ...draft, calls: [api] };
      const root = document.createElement('div');
      root.innerHTML = `<div class="wd-card" data-draft-id="d1">${renderReplyCallHtml(d, api, 0)}
        <div class="wd-error work-error" data-wd-error hidden></div>
        <div class="step-actions"><button data-wd-action="accept">Accept</button></div></div>`;
      wireWriteDraft(root, { jobId: 'j1', stepId: 's1', draft: d });
      root.querySelector<HTMLTextAreaElement>('[data-kind="rewrite"]')!.value = "Won't do it that way.";
      root.querySelector<HTMLButtonElement>('[data-wd-action="accept"]')!.click();
      const [, , , calls] = acceptDraft.mock.calls[0] as unknown as [string, string, string, any[]];
      expect(calls[0].bash).toBe('gh api --method POST "repos/{owner}/{repo}/pulls/comments/9/replies" --input /tmp/outpost-reply-d1-0.json');
      expect(JSON.parse(calls[0].files['/tmp/outpost-reply-d1-0.json'])).toEqual({ body: "Won't do it that way." });
    });

    it('still honours the skip verdict over any rewrite', () => {
      const root = mount();
      root.querySelector<HTMLTextAreaElement>('[data-kind="rewrite"]')!.value = 'edited';
      root.querySelector<HTMLInputElement>('[data-kind="skip"]')!.checked = true;
      root.querySelector<HTMLButtonElement>('[data-wd-action="accept"]')!.click();
      const [, , , calls] = acceptDraft.mock.calls[0] as unknown as [string, string, string, any[]];
      expect(calls[0]).toEqual({ label: 'issue:IC_1', bash: inline.bash, skip: true });
    });
  });

  it('leaves a plain (non-json-keyed) files field as raw bytes', () => {
    const md = {
      ...draft,
      calls: [{ bash: 'gh pr comment 7 --body-file /tmp/outpost-reply-2.md', files: { '/tmp/outpost-reply-2.md': 'orig' } }],
    };
    const root = document.createElement('div');
    root.innerHTML = renderWriteDraft(md);
    wireWriteDraft(root, { jobId: 'j1', stepId: 's1', draft: md });
    root.querySelector<HTMLTextAreaElement>('[data-kind="file"]')!.value = '# edited';
    root.querySelector<HTMLButtonElement>('[data-wd-action="accept"]')!.click();
    const [, , , calls] = acceptDraft.mock.calls[0] as unknown as [string, string, string, any[]];
    expect(calls[0].files['/tmp/outpost-reply-2.md']).toBe('# edited');
  });
});
