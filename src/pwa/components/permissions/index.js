import { detailShell, block } from '../settings-surface/detail-shell.js';
import { renderGroupsBlock } from './groups.js';

// Settings > Permissions. Three blocks — Groups, Pending classifications, Grants — each owned
// by its own module; this file is only the shell that mounts them, so no block's markup ever
// grows into the surface that hosts it.

export function renderPermissions(mount) {
  const body = detailShell(mount, 'Permissions',
    'Permission groups are the only thing that grants an action anything. Editing one is re-linted before it applies, and every change is recorded in the group’s history.');

  const groupsSection = block(body, 'Permission groups', '<div class="permgroup-list"></div>');

  // Blocks 2 (Pending classifications) and 3 (Grants) mount into these; the modules that fill
  // them land in the following tasks. Left as bare, headingless divs on purpose — an empty
  // block with a heading would advertise a control that isn't there yet.
  const pendingMount = document.createElement('div');
  pendingMount.className = 'perm-pending-mount';
  body.appendChild(pendingMount);
  const grantsMount = document.createElement('div');
  grantsMount.className = 'perm-grants-mount';
  body.appendChild(grantsMount);

  const unmountGroups = renderGroupsBlock(groupsSection.querySelector('.permgroup-list'));
  return () => { unmountGroups(); };
}
