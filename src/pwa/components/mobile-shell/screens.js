// Generic list→detail screen pair for a nav-backed surface, mirroring
// shell/surfaces.js's mountSurfaceFrame but stacked (one column, list OR
// detail visible, CSS handles the slide) instead of side-by-side. The list is
// mounted ONCE per surface visit and toggled with a class rather than
// unmounted/remounted on every back-navigation — settings-surface/index.js's
// renderList auto-selects a default section the first time nothing is
// selected (a desktop-appropriate default since desktop always shows a detail
// pane); remounting it on every "back" tap would re-trigger that auto-select
// and fight the back gesture. Mounting once and toggling visibility sidesteps
// that entirely (D2: no fork, just a different mount lifecycle).

import { nav } from '../../state/nav.js';

// entry: the same {renderList, renderDetail} registry entry shell/surfaces.js
// uses. `wrapDetail(detailMount, selection)` lets a caller (Tracked) inject
// extra chrome (the focus card) above the shared renderDetail without forking
// its markup — it returns `{ mount, unmount? }`: `mount` is the element
// renderDetail should render into, `unmount` (optional) tears down whatever
// wrapDetail itself subscribed, composed into the same lifecycle as
// renderDetail's own returned teardown.
export function mountListDetailScreens(container, surfaceKey, entry, { wrapDetail } = {}) {
  container.textContent = '';

  const listEl = document.createElement('div');
  listEl.className = 'm-screen m-screen-list';
  const detailEl = document.createElement('div');
  detailEl.className = 'm-screen m-screen-detail';
  container.appendChild(listEl);
  container.appendChild(detailEl);

  let listUnmount = null;
  let detailUnmount = null;
  let lastSelection;
  // List and detail share `container`'s single scroll box, so scrollTop is one
  // value across both screens. Without this, scrolling the detail and tapping
  // back leaves the list inheriting the detail's scroll offset. Stash the list
  // position on drill-in, start the detail at the top, and restore the list on
  // the way back.
  let showingDetail = false;
  let savedListScroll = 0;

  if (entry.renderList) {
    const ret = entry.renderList(listEl, {});
    listUnmount = typeof ret === 'function' ? ret : null;
  }

  function teardownDetail() {
    if (detailUnmount) { try { detailUnmount(); } catch { /* ignore */ } detailUnmount = null; }
    detailEl.textContent = '';
  }

  function paint() {
    const sel = nav.get().selectionBySurface[surfaceKey] ?? null;
    const nextShowingDetail = sel != null;
    listEl.classList.toggle('m-screen-hidden', nextShowingDetail);
    detailEl.classList.toggle('m-screen-hidden', !nextShowingDetail);
    if (nextShowingDetail !== showingDetail) {
      if (nextShowingDetail) savedListScroll = container.scrollTop;
      else container.scrollTop = savedListScroll;
      showingDetail = nextShowingDetail;
    }
    if (sel === lastSelection) return;
    lastSelection = sel;
    teardownDetail();
    if (!sel || !entry.renderDetail) return;
    container.scrollTop = 0; // every newly-mounted detail starts at the top
    const wrapped = wrapDetail ? wrapDetail(detailEl, sel) : null;
    const mountTarget = wrapped ? wrapped.mount : detailEl;
    const wrapUnmount = wrapped?.unmount ?? null;
    const ret = entry.renderDetail(mountTarget, { selection: sel });
    const compose = (fn) => {
      detailUnmount = () => {
        if (typeof fn === 'function') { try { fn(); } catch { /* ignore */ } }
        if (wrapUnmount) { try { wrapUnmount(); } catch { /* ignore */ } }
      };
    };
    if (ret && typeof ret.then === 'function') {
      ret.then((fn) => compose(fn));
      if (wrapUnmount) detailUnmount = () => { try { wrapUnmount(); } catch { /* ignore */ } };
    } else {
      compose(ret);
    }
  }

  paint();
  const unsubNav = nav.subscribe(paint);

  return {
    isShowingDetail: () => (nav.get().selectionBySurface[surfaceKey] ?? null) != null,
    back: () => nav.select(surfaceKey, null),
    unmount() {
      unsubNav();
      if (listUnmount) { try { listUnmount(); } catch { /* ignore */ } }
      teardownDetail();
      container.textContent = '';
    },
  };
}
