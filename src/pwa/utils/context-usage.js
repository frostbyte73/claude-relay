// 1M-context Opus advertises with the [1m] suffix; unknown ids fall back to 200k.
export const CONTEXT_WINDOWS = {
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

// Derive context-window usage + model label for one session, statusline-first
// (authoritative from claude's statusLine hook) with a message_start lastUsage
// fallback. Pure: callers pass the slice's statusline/lastUsage and, for the
// fallback, the project's context-window total + whether to retag the model as
// 1M (the API strips the [1m] suffix, so we re-add it for the display name).
export function contextUsage(statusline, lastUsage, { fallbackTotal, retagTo1M } = {}) {
  const total0 = fallbackTotal || CONTEXT_WINDOWS._default;
  const slCtx = statusline?.contextWindow;
  const slCur = slCtx?.current_usage;
  if (slCtx && typeof slCtx.context_window_size === 'number') {
    const input = slCur?.input_tokens ?? 0;
    const output = slCur?.output_tokens ?? 0;
    const cacheCreate = slCur?.cache_creation_input_tokens ?? 0;
    const cacheRead = slCur?.cache_read_input_tokens ?? 0;
    const total = slCtx.context_window_size;
    const used = (typeof slCtx.total_input_tokens === 'number' && typeof slCtx.total_output_tokens === 'number')
      ? slCtx.total_input_tokens + slCtx.total_output_tokens
      : input + output + cacheCreate + cacheRead;
    const pct = (typeof slCtx.used_percentage === 'number')
      ? slCtx.used_percentage
      : (total > 0 ? (used / total) * 100 : 0);
    return {
      known: true, used, total, pct,
      breakdown: { input, output, cacheCreate, cacheRead },
      modelLabel: statusline.model?.id ?? statusline.model?.display_name ?? null,
      modelDisplay: statusline.model?.display_name ?? null,
    };
  }
  if (lastUsage) {
    const { inputTokens = 0, outputTokens = 0, cacheCreate = 0, cacheRead = 0 } = lastUsage;
    const used = inputTokens + outputTokens + cacheCreate + cacheRead;
    const raw = lastUsage.model ?? null;
    const retagged = (retagTo1M && typeof raw === 'string' && !raw.endsWith('[1m]')) ? `${raw}[1m]` : raw;
    return {
      known: true, used, total: total0, pct: total0 > 0 ? (used / total0) * 100 : 0,
      breakdown: { input: inputTokens, output: outputTokens, cacheCreate, cacheRead },
      modelLabel: raw, modelDisplay: prettyModelName(retagged),
    };
  }
  return {
    known: false, used: 0, total: total0, pct: 0,
    breakdown: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 },
    modelLabel: null, modelDisplay: null,
  };
}
