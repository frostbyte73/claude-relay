// Per-session context/usage meter strip (CTX/5H/7D cells + collapsible
// breakdown). Mobile-only chrome — desktop hides this region via CSS and
// keeps its own usage widget at the sidebar foot instead (shell/sidebar.js).
//
// Ported from the legacy mobile-session-view.js singleton (D7 convergence).
// Two differences from the original: (1) reads statuslineBySession/
// lastUsageBySession by sessionId instead of the global "current session"
// snapshot, matching how session-view's renderModelChip already sources model
// info — correct even though today only one session-view is ever mounted at a
// time; (2) tier coloring comes from utils/usage-bar.js's unified 70/90
// thresholds (D8) instead of this module's old private 60/80 cutoffs.
import { escapeHtml } from '../../util.js';
import { usage } from '../../state/usage.js';
import { fmtCtxSize, fmtResetAt, fmtRemaining, fmtNumber } from '../../utils/formatting.js';
import { usageTier, clampPct } from '../../utils/usage-bar.js';

// 1M-context Opus advertises with the [1m] suffix; unknown ids fall back to 200k.
const CONTEXT_WINDOWS = {
  'claude-opus-4-7[1m]': 1_000_000,
  'claude-opus-4-7': 200_000,
  'claude-sonnet-4-6': 200_000,
  'claude-haiku-4-5-20251001': 200_000,
  _default: 200_000,
};

export function lookupContextWindow(modelId) {
  if (!modelId) return CONTEXT_WINDOWS._default;
  return CONTEXT_WINDOWS[modelId] ?? CONTEXT_WINDOWS._default;
}

// `claude-opus-4-7[1m]` → "Opus 4.7 (1M)". statusLine's display_name doesn't
// fire in --print mode, so we derive from the model id.
export function prettyModelName(id) {
  if (typeof id !== 'string' || !id) return null;
  const m = id.match(/^claude-(opus|sonnet|haiku)-(\d+)-(\d+)(?:-\d+)?(\[1m\])?$/i);
  if (!m) return id;
  const family = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
  const suffix = m[4] ? ' (1M)' : '';
  return `${family} ${m[2]}.${m[3]}${suffix}`;
}

function cellHtml(label, pct, hasValue, ariaLabel) {
  if (!hasValue || typeof pct !== 'number') {
    return `<div class="meter-cell" data-tier="ok" data-empty="true" aria-label="${escapeHtml(ariaLabel)}">
      <div class="meter-cell-head"><span class="meter-cell-label">${label}</span><span class="meter-cell-pct">—</span></div>
      <div class="meter-cell-bar"><span class="meter-cell-fill" style="width:0%"></span></div>
    </div>`;
  }
  const clamped = clampPct(pct);
  const tier = usageTier(clamped) ?? 'ok';
  return `<div class="meter-cell" data-tier="${tier}" aria-label="${escapeHtml(ariaLabel)}">
    <div class="meter-cell-head"><span class="meter-cell-label">${label}</span><span class="meter-cell-pct">${Math.round(clamped)}%</span></div>
    <div class="meter-cell-bar"><span class="meter-cell-fill" style="width:${clamped}%"></span></div>
  </div>`;
}

// CTX number sources, in preference order:
//   1. usage.statuslineBySession[sessionId].contextWindow — authoritative from
//      claude's statusLine hook.
//   2. usage.lastUsageBySession[sessionId] + usage.contextWindow — fallback
//      estimate from message_start, seeded before the first statusLine fire.
//
// `dom` is session-view's per-mount DOM object; needs `.meter` (the region to
// render into) and `.composer` (so tapping the strip can restore composer
// focus without dismissing the on-screen keyboard).
export function renderMeterStrip(dom, sessionId) {
  const region = dom.meter;
  if (!region) return;
  const sl = usage.get().statuslineBySession.get(sessionId) ?? null;
  const slCtx = sl?.contextWindow;
  const slCur = slCtx?.current_usage;

  let ctxUsed, ctxTotal, ctxPct, breakdownTokens, modelLabel, modelDisplay;
  let ctxKnown = false;
  if (slCtx && typeof slCtx.context_window_size === 'number') {
    ctxTotal = slCtx.context_window_size;
    const inp = slCur?.input_tokens ?? 0;
    const out = slCur?.output_tokens ?? 0;
    const cc = slCur?.cache_creation_input_tokens ?? 0;
    const cr = slCur?.cache_read_input_tokens ?? 0;
    ctxUsed = (typeof slCtx.total_input_tokens === 'number' && typeof slCtx.total_output_tokens === 'number')
      ? slCtx.total_input_tokens + slCtx.total_output_tokens
      : inp + out + cc + cr;
    ctxPct = (typeof slCtx.used_percentage === 'number')
      ? clampPct(slCtx.used_percentage)
      : (ctxTotal > 0 ? clampPct((ctxUsed / ctxTotal) * 100) : 0);
    breakdownTokens = { input: inp, output: out, cacheCreate: cc, cacheRead: cr };
    modelDisplay = sl.model?.display_name ?? null;
    modelLabel = sl.model?.id ?? sl.model?.display_name ?? null;
    ctxKnown = true;
  } else {
    const u = usage.get().lastUsageBySession.get(sessionId) ?? null;
    if (u) {
      ctxUsed = u.inputTokens + u.outputTokens + u.cacheCreate + u.cacheRead;
      ctxTotal = usage.get().contextWindow || CONTEXT_WINDOWS._default;
      ctxPct = clampPct((ctxUsed / ctxTotal) * 100);
      breakdownTokens = { input: u.inputTokens, output: u.outputTokens, cacheCreate: u.cacheCreate, cacheRead: u.cacheRead };
      modelLabel = u.model ?? null;
      // API strips the [1m] suffix; retag so prettyModelName surfaces "(1M)".
      const labelForDisplay = (usage.get().projectContextWindow === 1_000_000
        && typeof modelLabel === 'string' && !modelLabel.endsWith('[1m]'))
        ? `${modelLabel}[1m]`
        : modelLabel;
      modelDisplay = prettyModelName(labelForDisplay);
      ctxKnown = true;
    } else {
      ctxUsed = 0;
      ctxTotal = usage.get().contextWindow || CONTEXT_WINDOWS._default;
      ctxPct = 0;
      breakdownTokens = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 };
      modelLabel = null;
      modelDisplay = null;
    }
  }

  // Account-usage poll (works for Team/Max) wins over statusLine rate_limits
  // (Pro/Max-only, absent until first API response).
  const au = usage.get().accountUsage;
  const r5 = au?.five_hour?.used_percentage ?? sl?.rateLimits?.five_hour?.used_percentage;
  const r5Reset = au?.five_hour?.resets_at ?? sl?.rateLimits?.five_hour?.resets_at;
  const r7 = au?.seven_day?.used_percentage ?? sl?.rateLimits?.seven_day?.used_percentage;
  const r7Reset = au?.seven_day?.resets_at ?? sl?.rateLimits?.seven_day?.resets_at;
  const cost = sl?.cost?.total_cost_usd;
  const effort = sl?.effort?.level;

  const cells = [
    cellHtml('CTX', ctxPct, ctxKnown, ctxKnown
      ? `Context window: ${fmtNumber(ctxUsed)} of ${fmtNumber(ctxTotal)} tokens (${Math.round(ctxPct)}%)`
      : 'No context-window data yet'),
    cellHtml(fmtRemaining(r5Reset) ?? '5H', r5, typeof r5 === 'number', typeof r5 === 'number' ? `5-hour rate limit: ${Math.round(r5)}%, resets ${fmtResetAt(r5Reset)}` : 'No 5-hour rate-limit data yet'),
    cellHtml(fmtRemaining(r7Reset) ?? '7D', r7, typeof r7 === 'number', typeof r7 === 'number' ? `7-day rate limit: ${Math.round(r7)}%, resets ${fmtResetAt(r7Reset)}` : 'No 7-day rate-limit data yet'),
  ].join('');

  const tagText = modelDisplay
    ? `<span class="meter-tag-model">${escapeHtml(modelDisplay)}</span>`
    : '';

  const ariaSummary = [
    ctxKnown ? `Context ${Math.round(ctxPct)} percent of ${fmtCtxSize(ctxTotal)}` : null,
    typeof r5 === 'number' ? `5-hour limit ${Math.round(r5)} percent` : null,
    typeof r7 === 'number' ? `7-day limit ${Math.round(r7)} percent` : null,
  ].filter(Boolean).join(', ');

  const breakdownContent = `
    <div class="meter-breakdown-section">
      <div class="meter-breakdown-head">Context</div>
      <div class="meter-breakdown-row"><span>Total</span><span>${fmtNumber(ctxUsed)} / ${fmtCtxSize(ctxTotal)}</span></div>
      <div class="meter-breakdown-row meter-row-indent"><span>Input</span><span>${fmtNumber(breakdownTokens.input)}</span></div>
      <div class="meter-breakdown-row meter-row-indent"><span>Cache read</span><span>${fmtNumber(breakdownTokens.cacheRead)}</span></div>
      <div class="meter-breakdown-row meter-row-indent"><span>Cache create</span><span>${fmtNumber(breakdownTokens.cacheCreate)}</span></div>
      <div class="meter-breakdown-row meter-row-indent"><span>Output</span><span>${fmtNumber(breakdownTokens.output)}</span></div>
    </div>
    ${(typeof r5 === 'number' || typeof r7 === 'number') ? `
    <div class="meter-breakdown-section">
      <div class="meter-breakdown-head">Limits</div>
      ${typeof r5 === 'number' ? `<div class="meter-breakdown-row"><span>5-hour</span><span>${Math.round(r5)}% · resets ${fmtResetAt(r5Reset)}</span></div>` : ''}
      ${typeof r7 === 'number' ? `<div class="meter-breakdown-row"><span>7-day</span><span>${Math.round(r7)}% · resets ${fmtResetAt(r7Reset)}</span></div>` : ''}
    </div>` : ''}
    ${(typeof cost === 'number' || effort || modelLabel) ? `
    <div class="meter-breakdown-section">
      <div class="meter-breakdown-head">Session</div>
      ${typeof cost === 'number' ? `<div class="meter-breakdown-row"><span>Cost</span><span>$${cost.toFixed(2)}</span></div>` : ''}
      ${effort ? `<div class="meter-breakdown-row"><span>Effort</span><span>${escapeHtml(effort)}</span></div>` : ''}
      ${modelLabel ? `<div class="meter-breakdown-row meter-model"><span>Model</span><span>${escapeHtml(modelLabel)}</span></div>` : ''}
    </div>` : ''}
  `;

  const openCls = usage.get().meterBreakdownOpen ? ' meter-breakdown-open' : '';
  region.innerHTML = `
    <button class="meter" type="button" aria-expanded="${usage.get().meterBreakdownOpen ? 'true' : 'false'}"
            aria-label="${escapeHtml(ariaSummary)}. Tap to expand.">
      ${tagText ? `<div class="meter-tag">${tagText}</div>` : ''}
      <div class="meter-cells">${cells}</div>
    </button>
    <div class="meter-breakdown${openCls}" aria-hidden="${usage.get().meterBreakdownOpen ? 'false' : 'true'}">
      <div class="meter-breakdown-inner">${breakdownContent}</div>
    </div>
  `;
  const btn = region.querySelector('.meter');
  const bd = region.querySelector('.meter-breakdown');
  const setOpen = (open) => {
    usage.setMeterBreakdownOpen(open);
    if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (bd) {
      bd.classList.toggle('meter-breakdown-open', open);
      bd.setAttribute('aria-hidden', open ? 'false' : 'true');
    }
  };
  // pointerdown.preventDefault blocks focus theft (would dismiss the iOS keyboard).
  let composerWasFocused = false;
  const captureFocus = () => { composerWasFocused = !!dom.composer && document.activeElement === dom.composer; };
  const restoreFocus = () => {
    if (!composerWasFocused) return;
    if (dom.composer && document.activeElement !== dom.composer) dom.composer.focus();
  };
  if (btn) {
    btn.onpointerdown = (e) => { captureFocus(); e.preventDefault(); };
    btn.onclick = (e) => { e.stopPropagation(); setOpen(!usage.get().meterBreakdownOpen); restoreFocus(); };
  }
  if (bd) {
    bd.onpointerdown = (e) => { captureFocus(); e.preventDefault(); };
    bd.onclick = () => { setOpen(false); restoreFocus(); };
  }
}
