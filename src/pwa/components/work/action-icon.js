// Per-category glyphs for the action catalog + picker. 18×18 viewBox, currentColor
// stroke so they pick up the theme's `--text` / `--text-mute` tokens at the call site.

const ICONS = {
  read: `<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 9c2-3.5 5-5.5 8-5.5s6 2 8 5.5c-2 3.5-5 5.5-8 5.5s-6-2-8-5.5z"/><circle cx="9" cy="9" r="2.2"/></svg>`,
  write: `<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 2L8 10"/><path d="M16 2L11 16L8 10L2 7L16 2z"/></svg>`,
  code: `<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 5L1.5 9L6 13"/><path d="M12 5L16.5 9L12 13"/></svg>`,
  human: `<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="6" r="2.5"/><path d="M3 16c0-3 2.5-5.5 6-5.5s6 2.5 6 5.5"/></svg>`,
  meta: `<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 1.5L16.5 5.5L9 9.5L1.5 5.5L9 1.5z"/><path d="M1.5 9L9 13L16.5 9"/><path d="M1.5 12.5L9 16.5L16.5 12.5"/></svg>`,
};

const FALLBACK = `<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><circle cx="9" cy="9" r="3.5"/></svg>`;

export function actionIconHtml(category) {
  return ICONS[category] ?? FALLBACK;
}

// Strips the "<category>." prefix from an action name.
export function actionDisplayName(name) {
  const i = String(name ?? '').indexOf('.');
  return i < 0 ? String(name ?? '') : String(name).slice(i + 1);
}

const CATEGORIES = new Set(Object.keys(ICONS));

// The category half of an action name, normalized to the taxonomy the category
// palette is keyed on (primitives.css's [data-cat] block).
export function actionCategory(name) {
  const i = String(name ?? '').indexOf('.');
  const cat = i < 0 ? '' : String(name).slice(0, i);
  return CATEGORIES.has(cat) ? cat : 'custom';
}
