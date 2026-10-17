// Tiny DOM helpers: h('div', { class: 'x', onClick }, ...children)

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key in el && typeof value !== 'string') el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function mount(root, ...nodes) {
  root.replaceChildren();
  append(root, nodes);
}

let toastTimer = null;
export function toast(message, kind = 'info', ms = 3500) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.className = `show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = ''), ms);
}

export function formatDuration(seconds) {
  const s = Math.round(seconds ?? 0);
  if (s < 60) return `${s} с`;
  const m = Math.round(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)} ч ${m % 60} мин` : `${m} мин`;
}

export { formatDateTime as formatDate } from '../../shared/events.js';

export function scoreColor(score) {
  if (score == null) return 'var(--muted)';
  if (score >= 90) return 'var(--good)';
  if (score >= 75) return 'var(--ok)';
  if (score >= 60) return 'var(--warn)';
  return 'var(--bad)';
}

/** Circular score badge. */
export function scoreRing(score, size = 120) {
  const r = 46;
  const c = 2 * Math.PI * r;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.classList.add('score-ring');
  const track = document.createElementNS(ns, 'circle');
  Object.entries({ cx: 50, cy: 50, r, fill: 'none', stroke: 'var(--line)', 'stroke-width': 8 }).forEach(([k, v]) => track.setAttribute(k, v));
  const arc = document.createElementNS(ns, 'circle');
  Object.entries({
    cx: 50,
    cy: 50,
    r,
    fill: 'none',
    stroke: scoreColor(score),
    'stroke-width': 8,
    'stroke-linecap': 'round',
    'stroke-dasharray': `${(c * (score ?? 0)) / 100} ${c}`,
    transform: 'rotate(-90 50 50)',
  }).forEach(([k, v]) => arc.setAttribute(k, v));
  const text = document.createElementNS(ns, 'text');
  Object.entries({ x: 50, y: 57, 'text-anchor': 'middle', 'font-size': 26, 'font-weight': 700, fill: 'var(--text)' }).forEach(([k, v]) => text.setAttribute(k, v));
  text.textContent = score ?? '—';
  svg.append(track, arc, text);
  return svg;
}
