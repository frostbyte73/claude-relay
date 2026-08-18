import { detailShell, block } from '../settings-surface/detail-shell.js';
import { renderGroupsBlock } from './groups.js';
import { renderPendingBlock } from './pending.js';
import { renderGrantsBlock } from './grants.js';

// Settings > Permissions. Three blocks — Groups, Pending classifications, Grants — each owned
// by its own module; this file is only the shell that mounts them, so no block's markup ever
// grows into the surface that hosts it.

export function renderPermissions(mount) {
  const body = detailShell(mount, 'Permissions',
    'Permission groups are the only thing that grants an action anything. Editing one is re-linted before it applies, and every change is recorded in the group’s history.');

  const groupsSection = block(body, 'Permission groups', '<div class="permgroup-list"></div>');
  const pendingSection = block(body, 'Pending classifications',
    '<div class="perm-pending-list"></div>');
  // The subtitle is the single most load-bearing sentence on this page: it's what tells a
  // user that a grant added below will NOT unblock an action (Ship 2 confined action-bound
  // calls away from global/project scope entirely) — so it renders inline, always, never
  // behind a tooltip.
  const grantsSection = block(body, 'Grants', `
    <p class="perm-grants-subtitle"><strong>Sessions and skills only.</strong> A grant added here never reaches an action — an action's permissions come only from the groups it declares.</p>
    <div class="perm-grants-list"></div>
  `);

  const groupsApi = renderGroupsBlock(groupsSection.querySelector('.permgroup-list'));
  const unmountPending = renderPendingBlock(pendingSection.querySelector('.perm-pending-list'));
  const unmountGrants = renderGrantsBlock(grantsSection.querySelector('.perm-grants-list'),
    { promoteToGroup: groupsApi.promote });
  return () => { groupsApi.unmount(); unmountPending(); unmountGrants(); };
}
