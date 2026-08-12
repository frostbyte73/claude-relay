// Textareas that size to what's typed. `data-autogrow` has been on the timeline's four
// composers since they were written, but nothing ever read it — so every one of them sat
// at its CSS `min-height` forever, and the orchestrated card's "Message the controller"
// box cost ~140px of every live step whether or not you were writing in it.
//
// The floor stays with CSS (`min-height`), so a composer that opens deliberately — a
// write draft's revise/deny box — still opens full-size, and only the collapsed ones
// start at one line.

const MAX_H = 220;

function fit(ta) {
  // A composer revealed later (the gate/draft boxes start `hidden`) measures 0 while it
  // has no layout box, which would pin it shut at 0px. Leave it to CSS until it's on
  // screen — every later call comes from an input/focus event, so it's visible by then.
  if (ta.offsetParent === null) return;
  ta.style.height = 'auto';
  const next = Math.min(ta.scrollHeight, MAX_H);
  ta.style.height = `${next}px`;
  ta.style.overflowY = ta.scrollHeight > MAX_H ? 'auto' : 'hidden';
}

export function wireAutogrow(root) {
  root.querySelectorAll('textarea[data-autogrow]').forEach((ta) => {
    if (ta.__autogrow) return;
    ta.__autogrow = true;
    ta.addEventListener('input', () => fit(ta));
    ta.addEventListener('focus', () => fit(ta));
    fit(ta);
  });
}
