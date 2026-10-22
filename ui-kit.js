// Small UI toolkit: DOM builder, toasts, modal sheets (with Android Back support),
// confirm dialog, touch-friendly drag-to-reorder, file download.
import { icon } from './icons.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const bool = (b) => String(!!b);

/** Build an element. Children are appended as text nodes (never parsed as HTML). */
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (k === 'value' || k === 'checked' || k === 'disabled') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) {
    if (c === undefined || c === null || c === false) continue;
    el.append(c.nodeType ? c : String(c));
  }
  return el;
}

// ------------------------------------------------------------------ announcements & toasts
let liveEl = null;
export function announce(msg) {
  if (!liveEl) {
    liveEl = h('div', { class: 'sr-only', role: 'status', 'aria-live': 'polite', id: 'live' });
    document.body.append(liveEl);
  }
  liveEl.textContent = '';
  setTimeout(() => { liveEl.textContent = msg; }, 30);
}

export function toast(message, { action = null, timeout = 4000 } = {}) {
  const host = $('#toasts');
  while (host.children.length >= 3) host.firstElementChild.remove();
  const el = h('div', { class: 'toast' }, h('span', { class: 'msg' }, message));
  const dismiss = () => el.remove();
  if (action) {
    el.append(h('button', { type: 'button', on: { click: () => { dismiss(); action.fn(); } } }, action.label));
  }
  if (timeout === 0) el.append(h('button', { type: 'button', 'aria-label': 'Dismiss', on: { click: dismiss } }, 'Dismiss'));
  host.append(el);
  if (timeout) setTimeout(dismiss, timeout);
  return dismiss;
}

// ------------------------------------------------------------------ dialog layers
// Each open dialog pushes a history entry so the Android Back button closes it
// instead of leaving the app.
const layers = [];
let skipPops = 0;

export function openDialog(dlg) {
  if (dlg.open) return;
  dlg.showModal();
  history.pushState({ layer: layers.length + 1 }, '');
  layers.push(dlg);
}

export function closeDialog(dlg) {
  if (!dlg.open) return;
  const i = layers.indexOf(dlg);
  dlg.close();
  if (i >= 0) { layers.splice(i, 1); skipPops++; history.back(); }
}

export function initDialogs(...dialogs) {
  for (const dlg of dialogs) {
    dlg.addEventListener('close', () => { // closed with Esc / system gesture
      const i = layers.indexOf(dlg);
      if (i >= 0) { layers.splice(i, 1); skipPops++; history.back(); }
    });
    dlg.addEventListener('click', (e) => { if (e.target === dlg) closeDialog(dlg); });
  }
  window.addEventListener('popstate', () => {
    if (skipPops > 0) { skipPops--; return; }
    if (layers.length) { const d = layers.pop(); d.close(); }
  });
}

export const anyDialogOpen = () => layers.length > 0;

/** Fill a dialog with a header, scrolling body and footer. */
export function fillSheet(dlg, { title, body, foot, closeLabel = 'Close' }) {
  const titleId = `${dlg.id}-title`;
  const head = h('div', { class: 'sheet-head' },
    h('h2', { id: titleId }, title),
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': closeLabel, on: { click: () => closeDialog(dlg) } }, icon('x')));
  dlg.replaceChildren(head, h('div', { class: 'sheet-body' }, body), foot ? h('div', { class: 'sheet-foot' }, foot) : null);
}

/** Resolves true only if the user explicitly confirms. Esc, backdrop and Back all mean "no". */
export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false, typeToConfirm = null }) {
  const dlg = $('#confirm');
  return new Promise((resolve) => {
    let finished = false;
    const finish = (val) => {
      if (finished) return;
      finished = true;
      closeDialog(dlg);
      resolve(val);
    };
    const ok = h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, type: 'button', disabled: !!typeToConfirm, on: { click: () => finish(true) } }, confirmLabel);
    let input = null;
    const body = [h('p', null, message)];
    if (typeToConfirm) {
      input = h('input', { type: 'text', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', 'aria-label': `Type ${typeToConfirm} to confirm`, on: { input: () => { ok.disabled = input.value.trim() !== typeToConfirm; } } });
      body.push(h('label', { class: 'field' }, h('span', { class: 'label' }, `Type ${typeToConfirm} to confirm`), input));
    }
    fillSheet(dlg, {
      title, body,
      foot: [h('button', { class: 'btn', type: 'button', on: { click: () => finish(false) } }, 'Cancel'), ok],
    });
    dlg.addEventListener('close', () => { if (!finished) { finished = true; resolve(false); } }, { once: true });
    openDialog(dlg);
  });
}

// ------------------------------------------------------------------ drag to reorder
/**
 * Pointer-based drag reordering for a <ul>. Handles are `.handle` buttons inside `li` rows.
 * onCommit receives the new ordered array of li[data-id]. Works with touch, mouse and pen;
 * edge auto-scroll included. Keyboard/assistive reordering is handled separately.
 */
export function enableDrag(listEl, onCommit) {
  let d = null;
  const frame = () => {
    if (!d) return;
    if (d.lastY < 96) window.scrollBy(0, -14);
    else if (d.lastY > window.innerHeight - 160) window.scrollBy(0, 14);
    update();
    d.raf = requestAnimationFrame(frame);
  };
  function update() {
    const dy = (d.lastY - d.startY) + (window.scrollY - d.startScroll);
    const me = d.rects[d.index];
    d.li.style.transform = `translateY(${dy}px)`;
    const center = me.top + me.h / 2 + dy;
    let target = 0;
    d.items.forEach((el, k) => { if (k !== d.index && d.rects[k].top + d.rects[k].h / 2 < center) target++; });
    d.target = target;
    d.items.forEach((el, k) => {
      if (k === d.index) return;
      let shift = 0;
      if (d.index < k && k <= target) shift = -me.h;
      else if (target <= k && k < d.index) shift = me.h;
      el.style.transform = shift ? `translateY(${shift}px)` : '';
    });
  }
  function end(e, cancelled) {
    if (!d || e.pointerId !== d.pid) return;
    cancelAnimationFrame(d.raf);
    const { items, index, target, li, handle } = d;
    d = null;
    try { handle.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    items.forEach((el) => { el.style.transform = ''; });
    li.classList.remove('dragging');
    if (!cancelled && target !== index) {
      const ids = items.map((el) => el.dataset.id);
      const [moved] = ids.splice(index, 1);
      ids.splice(target, 0, moved);
      onCommit(ids, moved);
    }
  }
  listEl.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('.handle');
    if (!handle || d || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const li = handle.closest('li');
    e.preventDefault();
    const items = [...listEl.children];
    d = {
      li, handle, items, index: items.indexOf(li), target: items.indexOf(li), pid: e.pointerId,
      startY: e.clientY, lastY: e.clientY, startScroll: window.scrollY,
      rects: items.map((el) => { const r = el.getBoundingClientRect(); return { top: r.top + window.scrollY, h: r.height }; }),
    };
    handle.setPointerCapture(e.pointerId);
    li.classList.add('dragging');
    d.raf = requestAnimationFrame(frame);
  });
  listEl.addEventListener('pointermove', (e) => { if (d && e.pointerId === d.pid) d.lastY = e.clientY; });
  listEl.addEventListener('pointerup', (e) => end(e, false));
  listEl.addEventListener('pointercancel', (e) => end(e, true));
}

// ------------------------------------------------------------------ files
export function downloadText(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export async function shareText(filename, text, mime) {
  const file = new File([text], filename, { type: mime });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    await navigator.share({ files: [file], title: filename });
    return true;
  }
  return false;
}
