import { escapeHtml } from '../util.js';
import { setHtmlIfChanged } from '../utils/keyed-rows.js';
import { sessions } from '../state/sessions.js';
import { partitionTodos, todoProvenanceText } from './todos-core.js';
import {
  noteSheetOpen,
  noteSheetClose,
  dismissSoftKeyboard,
  pinSheetBelowHeader,
  makeSheetDismissible,
} from './sheet-utils.js';

let activeSheetSessionId = null;

function sheetTodos() {
  if (activeSheetSessionId) {
    const slice = sessions.getSlice(activeSheetSessionId);
    if (slice?.todos) return slice.todos;
  }
  return sessions.currentSlice().todos;
}

function sheetRowHtml(id, t) {
  const status = (t && typeof t.status === 'string') ? t.status : 'pending';
  const subject = (t && typeof t.subject === 'string') ? t.subject : `Task #${id}`;
  const active = (t && typeof t.activeForm === 'string') ? t.activeForm : '';
  // In-progress rows in the sheet display BOTH the subject and the activeForm —
  // the subject as the title, the activeForm beneath as a quieter "doing now" line.
  const showActive = status === 'in_progress' && active && active !== subject;
  const provenance = todoProvenanceText(t ?? {});
  return `
    <li class="todos-sheet-row todos-status-${escapeHtml(status)}">
      <span class="todos-sheet-node" aria-hidden="true"></span>
      <span class="todos-sheet-id">${escapeHtml(String(id).padStart(2, '0'))}</span>
      <span class="todos-sheet-body-cell">
        <span class="todos-sheet-subject">${escapeHtml(subject)}</span>
        ${showActive ? `<span class="todos-sheet-active">${escapeHtml(active)}</span>` : ''}
        ${provenance ? `<span class="todos-sheet-provenance">${escapeHtml(provenance)}</span>` : ''}
      </span>
    </li>
  `;
}

function todosSheetBodyHtml() {
  const { all, inProgress, pending, completed } = partitionTodos(sheetTodos());
  const total = all.length;
  const doneCount = completed.length;
  const pct = total === 0 ? 0 : Math.round((doneCount / total) * 100);

  const section = (label, items, kind) => {
    if (items.length === 0) return '';
    const rows = items.map(([id, t]) => sheetRowHtml(id, t)).join('');
    return `
      <section class="todos-section todos-section-${kind}">
        <div class="todos-section-head">
          <span class="todos-section-label">${escapeHtml(label)}</span>
          <span class="todos-section-count">${escapeHtml(String(items.length).padStart(2, '0'))}</span>
        </div>
        <ul class="todos-section-list">${rows}</ul>
      </section>
    `;
  };

  return `
    <div class="grabber"></div>
    <div class="header-row todos-sheet-header">
      <div class="todos-sheet-title-block">
        <span class="sheet-title">Tasks</span>
        <span class="todos-sheet-progress-line">
          <span class="todos-sheet-fraction">${escapeHtml(`${doneCount}`)}<span class="todos-sheet-frac-divider">/</span>${escapeHtml(`${total}`)}</span>
          <span class="todos-sheet-pct">${escapeHtml(String(pct))}<span class="todos-sheet-pct-symbol">%</span></span>
        </span>
      </div>
      <button class="sheet-close" id="todos-sheet-close" aria-label="Close task list">✕</button>
    </div>
    <div class="todos-progress-bar" aria-hidden="true">
      <span class="todos-progress-fill" style="width:${pct}%"></span>
    </div>
    <div class="todos-sheet-body">
      ${section('In progress', inProgress, 'now')}
      ${section('Up next', pending, 'next')}
      ${section('Completed', completed, 'done')}
      ${total === 0 ? '<div class="empty-state todos-sheet-empty">No tasks yet.</div>' : ''}
    </div>
  `;
}

export function openTodosSheet(sessionId = null) {
  dismissSoftKeyboard();
  closeTodosSheet();
  activeSheetSessionId = typeof sessionId === 'string' ? sessionId : null;
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop todos-sheet-backdrop';
  backdrop.id = 'todos-sheet-backdrop';
  const sheet = document.createElement('aside');
  sheet.className = 'sheet todos-sheet';
  sheet.id = 'todos-sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-label', 'All tasks');
  sheet.innerHTML = todosSheetBodyHtml();
  document.body.appendChild(backdrop);
  document.body.appendChild(sheet);
  requestAnimationFrame(() => {
    backdrop.classList.add('open');
    sheet.classList.add('open');
  });
  backdrop.onclick = closeTodosSheet;
  sheet.querySelector('#todos-sheet-close').onclick = closeTodosSheet;
  pinSheetBelowHeader(sheet);
  makeSheetDismissible(sheet, closeTodosSheet);
  noteSheetOpen(closeTodosSheet);
}

export function refreshTodosSheet() {
  const sheet = document.getElementById('todos-sheet');
  if (!sheet) return;
  const oldBody = sheet.querySelector('.todos-sheet-body');
  const bodyScrollTop = oldBody?.scrollTop ?? 0;
  const wasAtBottom = oldBody
    ? (oldBody.scrollHeight - oldBody.scrollTop - oldBody.clientHeight) < 80
    : false;
  // Guarded: this runs on every session-view paint, and the in_progress row's
  // .todos-sheet-node carries an infinite CSS pulse that restarts whenever its
  // element is re-created. Skipping an identical rewrite also leaves the sheet's
  // scroll position and dismiss gesture untouched.
  if (!setHtmlIfChanged(sheet, todosSheetBodyHtml())) return;
  const close = sheet.querySelector('#todos-sheet-close');
  if (close) close.onclick = closeTodosSheet;
  makeSheetDismissible(sheet, closeTodosSheet);
  const newBody = sheet.querySelector('.todos-sheet-body');
  if (newBody) newBody.scrollTop = wasAtBottom ? newBody.scrollHeight : bodyScrollTop;
}

export function closeTodosSheet() {
  const backdrop = document.getElementById('todos-sheet-backdrop');
  const sheet = document.getElementById('todos-sheet');
  if (!backdrop && !sheet) return;
  activeSheetSessionId = null;
  backdrop?.classList.remove('open');
  sheet?.classList.remove('open');
  noteSheetClose();
  setTimeout(() => {
    backdrop?.remove();
    sheet?.remove();
  }, 380);
}
