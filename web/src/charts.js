// Small hand-built charts (SVG/HTML) for the dashboard: a single-series line
// with crosshair tooltip, a bar list and meters. Each card can switch to a
// table view with the same numbers.

const SVG = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs = {}, parent) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  parent?.append(el);
  return el;
}

function tooltip(container) {
  const tip = document.createElement('div');
  tip.className = 'tooltip';
  tip.setAttribute('role', 'status');
  container.append(tip);
  return {
    show(x, y, value, label) {
      tip.replaceChildren();
      const v = document.createElement('div');
      v.className = 'tt-value';
      const key = document.createElement('span');
      key.className = 'tt-key';
      v.append(key, document.createTextNode(value));
      const l = document.createElement('div');
      l.className = 'tt-label';
      l.textContent = label;
      tip.append(v, l);
      tip.style.display = 'block';
      const box = container.getBoundingClientRect();
      const w = tip.offsetWidth;
      tip.style.left = `${Math.min(box.width - w - 4, Math.max(4, x + 12))}px`;
      tip.style.top = `${Math.max(0, y - tip.offsetHeight - 10)}px`;
    },
    hide() {
      tip.style.display = 'none';
    },
  };
}

/**
 * points: [{ label, value, sub }] in time order. One series, y from 0 to 100.
 */
export function lineChart(container, points, { refs = [], valueFormat = (v) => String(v) } = {}) {
  container.replaceChildren();
  container.classList.add('chart');
  const W = 640;
  const H = 240;
  const m = { l: 34, r: 44, t: 14, b: 28 };
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, tabindex: 0, 'aria-label': 'Оценка по возење' }, container);
  const n = points.length;
  const x = (i) => m.l + (n <= 1 ? (W - m.l - m.r) / 2 : (i * (W - m.l - m.r)) / (n - 1));
  const y = (v) => m.t + ((100 - v) * (H - m.t - m.b)) / 100;

  for (const t of [0, 25, 50, 75, 100]) {
    svgEl('line', { x1: m.l, x2: W - m.r, y1: y(t), y2: y(t), class: t === 0 ? 'axis-line' : 'grid-line' }, svg);
    svgEl('text', { x: m.l - 8, y: y(t) + 4, 'text-anchor': 'end', class: 'tick' }, svg).textContent = t;
  }
  for (const r of refs) {
    svgEl('line', { x1: m.l, x2: W - m.r, y1: y(r.y), y2: y(r.y), class: 'ref-line' }, svg);
    svgEl('text', { x: m.l + 4, y: y(r.y) - 5, class: 'ref-label' }, svg).textContent = r.label;
  }
  const step = Math.max(1, Math.ceil(n / 6));
  points.forEach((p, i) => {
    const regular = i % step === 0 && n - 1 - i >= step * 0.6; // keep clear of the last label
    if (regular || i === n - 1) svgEl('text', { x: x(i), y: H - 8, 'text-anchor': 'middle', class: 'tick' }, svg).textContent = p.label;
  });
  if (!n) return svg;

  const valid = points.map((p, i) => [i, p.value]).filter(([, v]) => v != null);
  const d = valid.map(([i, v], k) => `${k ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  if (valid.length > 1) {
    const first = valid[0][0];
    const last = valid[valid.length - 1][0];
    svgEl('path', { d: `${d} L${x(last)},${y(0)} L${x(first)},${y(0)} Z`, class: 'series-area' }, svg);
  }
  svgEl('path', { d, class: 'series-line' }, svg);
  const [li, lv] = valid[valid.length - 1] ?? [];
  if (li != null) {
    svgEl('circle', { cx: x(li), cy: y(lv), r: 5, class: 'dot' }, svg);
    svgEl('text', { x: x(li) + 9, y: y(lv) + 4, class: 'end-label' }, svg).textContent = valueFormat(lv);
  }

  const cross = svgEl('line', { y1: m.t, y2: H - m.b, class: 'crosshair', visibility: 'hidden' }, svg);
  const hover = svgEl('circle', { r: 5, class: 'dot', visibility: 'hidden' }, svg);
  const tip = tooltip(container);
  let active = null;
  const activate = (i) => {
    active = Math.max(0, Math.min(n - 1, i));
    const p = points[active];
    cross.setAttribute('x1', x(active));
    cross.setAttribute('x2', x(active));
    cross.setAttribute('visibility', 'visible');
    if (p.value != null) {
      hover.setAttribute('cx', x(active));
      hover.setAttribute('cy', y(p.value));
      hover.setAttribute('visibility', 'visible');
    } else hover.setAttribute('visibility', 'hidden');
    const box = svg.getBoundingClientRect();
    const k = box.width / W;
    tip.show(x(active) * k, y(p.value ?? 50) * k, p.value != null ? valueFormat(p.value) : '—', p.sub ?? p.label);
  };
  const clear = () => {
    active = null;
    cross.setAttribute('visibility', 'hidden');
    hover.setAttribute('visibility', 'hidden');
    tip.hide();
  };
  const hit = svgEl('rect', { x: m.l - 10, y: 0, width: W - m.l - m.r + 20, height: H, fill: 'transparent' }, svg);
  hit.addEventListener('pointermove', (e) => {
    const box = svg.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    activate(n <= 1 ? 0 : Math.round(((px - m.l) / (W - m.l - m.r)) * (n - 1)));
  });
  hit.addEventListener('pointerleave', clear);
  svg.addEventListener('focus', () => activate(n - 1));
  svg.addEventListener('blur', clear);
  svg.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') activate((active ?? n) - 1);
    if (e.key === 'ArrowRight') activate((active ?? -1) + 1);
  });
  return svg;
}

/** items: [{ name, value, detail }] - one series, so one color and no legend. */
export function barList(container, items, { valueFormat = (v) => String(v) } = {}) {
  container.replaceChildren();
  container.classList.add('bars', 'chart');
  const max = Math.max(1, ...items.map((i) => i.value));
  const tip = tooltip(container);
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'bar-item';
    row.tabIndex = 0;
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = item.name;
    const track = document.createElement('span');
    track.className = 'bar-track';
    const fill = document.createElement('span');
    fill.className = 'bar-fill';
    fill.style.width = `calc(${(item.value / max) * 100}% - 48px)`;
    const value = document.createElement('span');
    value.className = 'bar-value';
    value.textContent = valueFormat(item.value);
    track.append(fill, value);
    row.append(name, track);
    const show = () => {
      const box = container.getBoundingClientRect();
      const r = row.getBoundingClientRect();
      tip.show(r.left - box.left + r.width * 0.4, r.top - box.top, valueFormat(item.value), item.detail ?? item.name);
    };
    row.addEventListener('pointerenter', show);
    row.addEventListener('focus', show);
    row.addEventListener('pointerleave', () => tip.hide());
    row.addEventListener('blur', () => tip.hide());
    container.append(row);
  }
}

/** items: [{ label, value (0-100 or null) }] */
export function meters(container, items) {
  container.replaceChildren();
  for (const item of items) {
    const box = document.createElement('div');
    box.className = 'meter';
    const label = document.createElement('span');
    label.className = 'm-label';
    label.textContent = item.label;
    const value = document.createElement('span');
    value.className = 'm-value';
    value.textContent = item.value ?? '—';
    const track = document.createElement('div');
    track.className = 'm-track';
    track.setAttribute('role', 'meter');
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', '100');
    if (item.value != null) track.setAttribute('aria-valuenow', String(item.value));
    track.setAttribute('aria-label', item.label);
    const fill = document.createElement('div');
    fill.className = 'm-fill';
    fill.style.width = `${item.value ?? 0}%`;
    track.append(fill);
    box.append(label, value, track);
    container.append(box);
  }
}

/** Builds a table from rows of cell text (first row = header). */
export function table(rows, numericColumns = []) {
  const t = document.createElement('table');
  t.className = 'data';
  const [head, ...body] = rows;
  const thead = t.createTHead().insertRow();
  head.forEach((cell, i) => {
    const th = document.createElement('th');
    th.textContent = cell;
    if (numericColumns.includes(i)) th.className = 'num';
    thead.append(th);
  });
  const tbody = t.createTBody();
  for (const r of body) {
    const tr = tbody.insertRow();
    r.forEach((cell, i) => {
      const td = tr.insertCell();
      td.textContent = cell ?? '—';
      if (numericColumns.includes(i)) td.className = 'num';
    });
  }
  return t;
}

/** Adds a "Табела" toggle to a card that swaps the chart for its table twin. */
export function tableToggle(button, chartBox, makeTable) {
  let showingTable = false;
  const tableBox = document.createElement('div');
  tableBox.hidden = true;
  chartBox.after(tableBox);
  button.addEventListener('click', () => {
    showingTable = !showingTable;
    if (showingTable) tableBox.replaceChildren(makeTable());
    tableBox.hidden = !showingTable;
    chartBox.hidden = showingTable;
    button.textContent = showingTable ? 'Графикон' : 'Табела';
    button.setAttribute('aria-pressed', String(showingTable));
  });
  return () => {
    if (showingTable) tableBox.replaceChildren(makeTable());
  };
}
