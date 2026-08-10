import { escapeHtml } from '../../util.js';

// epoch ms → the `YYYY-MM-DDTHH:mm` local-wall-clock string a datetime-local input wants.
function toDatetimeLocal(ms) {
  if (ms == null) return '';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// The debounce is persisted in ms; the editor works in whole hours (0 = no limit). A sub-hour
// value written by hand rounds up rather than down to 0 — dropping the cap silently would be
// the one wrong answer.
function debounceHours(trigger) {
  const ms = trigger.kind === 'token-opportunistic' ? trigger.debounceMs ?? 0 : 0;
  return ms > 0 ? Math.max(1, Math.round(ms / 3_600_000)) : 0;
}

const GUARD_KINDS = [
  { id: 'usage-threshold', label: 'Usage threshold' },
  { id: 'no-repo-changes', label: 'No repo changes' },
];

function guardFieldsHtml(kind, guard) {
  if (kind === 'usage-threshold') {
    const window = guard?.window ?? '7d';
    const op = guard?.op ?? '>';
    const value = guard?.value ?? 90;
    return `
      <select class="g-window">
        <option value="5h"${window === '5h' ? ' selected' : ''}>5h</option>
        <option value="7d"${window === '7d' ? ' selected' : ''}>7d</option>
      </select>
      <select class="g-op">
        <option value=">"${op === '>' ? ' selected' : ''}>&gt;</option>
        <option value=">="${op === '>=' ? ' selected' : ''}>&ge;</option>
      </select>
      <input class="g-value" type="number" min="0" max="100" value="${escapeHtml(String(value))}" />
      <span class="sched-form-unit">%</span>
    `;
  }
  return `<input class="g-repo" type="text" placeholder="owner/repo (blank = any)" value="${escapeHtml(guard?.repo ?? '')}" />`;
}

function readGuardRow(row) {
  const kind = row.querySelector('.g-kind').value;
  if (kind === 'usage-threshold') {
    return {
      kind,
      window: row.querySelector('.g-window').value,
      op: row.querySelector('.g-op').value,
      value: Number(row.querySelector('.g-value').value) || 0,
    };
  }
  const repo = row.querySelector('.g-repo').value.trim();
  return { kind, ...(repo ? { repo } : {}) };
}

function renderGuardRow(guard, onRemove) {
  const row = document.createElement('div');
  row.className = 'sched-guard-row';
  row.innerHTML = `
    <select class="g-kind">
      ${GUARD_KINDS.map((k) => `<option value="${k.id}"${k.id === guard.kind ? ' selected' : ''}>${k.label}</option>`).join('')}
    </select>
    <span class="g-fields">${guardFieldsHtml(guard.kind, guard)}</span>
    <button type="button" class="sched-guard-remove" aria-label="Remove guard">×</button>
  `;
  row.querySelector('.g-kind').addEventListener('change', (e) => {
    row.querySelector('.g-fields').innerHTML = guardFieldsHtml(e.target.value, {});
  });
  row.querySelector('.sched-guard-remove').addEventListener('click', () => onRemove(row));
  return row;
}

export function renderTriggerCard(schedule, detail, editState, repaint, onSave) {
  const card = document.createElement('div');
  card.className = 'o-section sched-card-detail';

  if (!editState.trigger) {
    card.innerHTML = `
      <div class="sched-card-hdr">
        <h3 class="o-microhead">◈ Trigger</h3>
        <button type="button" class="sched-edit-link">Edit</button>
      </div>
      <div class="sched-kv">
        <span class="k">When</span>
        <span class="v"><strong>${escapeHtml(detail.trigger.when)}</strong>${detail.trigger.tz ? ` <span class="sched-tz">${escapeHtml(detail.trigger.tz)}</span>` : ''}</span>
        <span class="k">${detail.trigger.sourceKind === 'event' ? 'Event' : detail.trigger.sourceKind === 'once' ? 'Once' : detail.trigger.sourceKind === 'token' ? 'Tokens' : 'Cron'}</span>
        <span class="v"><code>${escapeHtml(detail.trigger.descriptor)}</code></span>
        <span class="k">Next run</span>
        <span class="v">${detail.trigger.nextRunAbsolute ? `${escapeHtml(detail.trigger.nextRunAbsolute)} · <span class="sched-tz">${escapeHtml(detail.trigger.nextRunRelative ?? '')}</span>` : escapeHtml(detail.trigger.nextRunRelative ?? '—')}</span>
        <span class="k">Skip if</span>
        <span class="v">${detail.trigger.guards.length ? detail.trigger.guards.map((g) => `<span class="o-pill">${escapeHtml(g.label)}</span>`).join(' ') : '<span class="sched-tz">none</span>'}</span>
      </div>
    `;
    card.querySelector('.sched-edit-link').addEventListener('click', () => { editState.trigger = true; repaint(); });
    return card;
  }

  // ── Edit mode ──
  const trigger = schedule.trigger ?? { kind: 'cron', expr: '' };
  const guardRows = document.createElement('div');
  guardRows.className = 'sched-guard-rows';
  for (const g of schedule.guards ?? []) {
    guardRows.appendChild(renderGuardRow(g, (row) => row.remove()));
  }

  card.innerHTML = `
    <div class="sched-card-hdr">
      <h3 class="o-microhead">◈ Trigger</h3>
    </div>
    <div class="sched-form">
      <label class="sched-form-row">
        <span class="k">Kind</span>
        <select class="t-kind">
          <option value="cron"${trigger.kind === 'cron' || (trigger.kind !== 'event' && trigger.kind !== 'once' && trigger.kind !== 'token-opportunistic') ? ' selected' : ''}>Cron</option>
          <option value="once"${trigger.kind === 'once' ? ' selected' : ''}>Once</option>
          <option value="token"${trigger.kind === 'token-opportunistic' ? ' selected' : ''}>When tokens are free</option>
          <option value="event"${trigger.kind === 'event' ? ' selected' : ''}>Event</option>
        </select>
      </label>
      <div class="t-cron-fields" ${trigger.kind === 'cron' || (trigger.kind !== 'event' && trigger.kind !== 'once' && trigger.kind !== 'token-opportunistic') ? '' : 'hidden'}>
        <label class="sched-form-row"><span class="k">Cron expr</span><input class="t-expr" type="text" placeholder="0 9 * * 0" value="${escapeHtml(trigger.kind === 'cron' ? (trigger.expr ?? '') : '')}" /></label>
        <label class="sched-form-row"><span class="k">Timezone</span><input class="t-tz" type="text" placeholder="America/Los_Angeles" value="${escapeHtml(trigger.tz ?? '')}" /></label>
      </div>
      <div class="t-once-fields" ${trigger.kind === 'once' ? '' : 'hidden'}>
        <label class="sched-form-row"><span class="k">Run at</span><input class="t-at" type="datetime-local" value="${escapeHtml(trigger.kind === 'once' ? toDatetimeLocal(trigger.at) : '')}" /></label>
      </div>
      <div class="t-event-fields" ${trigger.kind === 'event' ? '' : 'hidden'}>
        <label class="sched-form-row"><span class="k">Event descriptor</span><input class="t-descriptor" type="text" placeholder="linear.issue.created" value="${escapeHtml(trigger.kind === 'event' ? (trigger.descriptor ?? '') : '')}" /></label>
      </div>
      <div class="t-token-fields" ${trigger.kind === 'token-opportunistic' ? '' : 'hidden'}>
        <p class="sched-form-hint">Runs when 5h + 7d usage leave spare capacity — aggressive near a reset, conservative early in a window. Add a usage-threshold guard below to cap it further.</p>
        <label class="sched-form-row">
          <span class="k">At most every</span>
          <span class="sched-form-inline">
            <input class="t-debounce" type="number" min="0" step="1" value="${escapeHtml(String(debounceHours(trigger)))}" />
            <span class="sched-form-unit">hours — counted from the last run, skips included (0 = no limit)</span>
          </span>
        </label>
      </div>
      <div class="sched-form-row">
        <span class="k">Skip if</span>
        <div class="sched-guard-list"></div>
      </div>
      <button type="button" class="sched-add-guard">+ Add guard</button>
      <div class="sched-form-error" hidden></div>
      <div class="sched-form-actions">
        <button type="button" class="o-btn o-btn--default sched-cancel">Cancel</button>
        <button type="button" class="o-btn o-btn--primary sched-save">Save</button>
      </div>
    </div>
  `;
  card.querySelector('.sched-guard-list').appendChild(guardRows);

  const kindSelect = card.querySelector('.t-kind');
  kindSelect.addEventListener('change', () => {
    const kind = kindSelect.value;
    card.querySelector('.t-cron-fields').hidden = kind !== 'cron';
    card.querySelector('.t-once-fields').hidden = kind !== 'once';
    card.querySelector('.t-event-fields').hidden = kind !== 'event';
    card.querySelector('.t-token-fields').hidden = kind !== 'token';
  });
  card.querySelector('.sched-add-guard').addEventListener('click', () => {
    guardRows.appendChild(renderGuardRow({ kind: 'usage-threshold' }, (row) => row.remove()));
  });
  card.querySelector('.sched-cancel').addEventListener('click', () => { editState.trigger = false; repaint(); });
  card.querySelector('.sched-save').addEventListener('click', async () => {
    const kind = kindSelect.value;
    const err = card.querySelector('.sched-form-error');
    const showErr = (msg) => { err.textContent = msg; err.hidden = false; };
    let nextTrigger;
    if (kind === 'token') {
      const hours = Number(card.querySelector('.t-debounce').value);
      if (!Number.isFinite(hours) || hours < 0) return showErr('The minimum gap must be 0 or more hours.');
      // Always explicit, never omitted — the daemon backfills a missing debounce on the builtin
      // improver, so `0` is how "no limit" survives a restart.
      nextTrigger = { kind: 'token-opportunistic', debounceMs: Math.round(hours * 3_600_000) };
    } else if (kind === 'event') {
      nextTrigger = { kind: 'event', descriptor: card.querySelector('.t-descriptor').value.trim() };
      if (!nextTrigger.descriptor) return showErr('Event descriptor is required.');
    } else if (kind === 'once') {
      const raw = card.querySelector('.t-at').value;
      const at = raw ? new Date(raw).getTime() : NaN;
      if (!Number.isFinite(at)) return showErr('A run date/time is required.');
      if (at <= Date.now()) return showErr('The run time must be in the future.');
      nextTrigger = { kind: 'once', at };
    } else {
      nextTrigger = { kind: 'cron', expr: card.querySelector('.t-expr').value.trim(), ...(card.querySelector('.t-tz').value.trim() ? { tz: card.querySelector('.t-tz').value.trim() } : {}) };
      if (!nextTrigger.expr) return showErr('Cron expression is required.');
    }
    const guards = [...guardRows.querySelectorAll('.sched-guard-row')].map(readGuardRow);
    err.hidden = true;
    try {
      await onSave({ trigger: nextTrigger, guards });
      editState.trigger = false;
      repaint();
    } catch (e) {
      err.textContent = `Failed to save: ${e.message}`;
      err.hidden = false;
    }
  });

  return card;
}
