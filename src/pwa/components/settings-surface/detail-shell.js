import { escapeHtml } from '../../util.js';

// The chrome every Settings detail pane shares — title, lede, and the section blocks stacked
// under it. Lives apart from index.js so a section rendered from another directory (the
// Permissions page) gets the same frame without importing the surface that mounts it.

export function detailShell(mount, title, lede) {
  mount.innerHTML = `
    <div class="settings-detail">
      <div class="settings-detail-hdr">
        <h1>${escapeHtml(title)}</h1>
        ${lede ? `<p class="settings-detail-lede">${escapeHtml(lede)}</p>` : ''}
      </div>
      <div class="settings-detail-body"></div>
    </div>
  `;
  return mount.querySelector('.settings-detail-body');
}

export function block(body, heading, contentHtml) {
  const section = document.createElement('div');
  section.className = 'o-section settings-block';
  section.innerHTML = `<h3 class="o-microhead">${escapeHtml(heading)}</h3>${contentHtml}`;
  body.appendChild(section);
  return section;
}
