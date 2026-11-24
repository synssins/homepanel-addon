'use strict';
// HomePanel Studio: tablets, designs, and the grid editor. No framework; the sheet in the editor is the real
// tablet renderer in an iframe (live house state), with a transparent layer on top for selecting and dragging.

// ---------- small helpers ----------
const ICON = Object.assign({}, window.HP_ICONS, {
  plus: 'M19,13H13V19H11V13H5V11H11V5H13V11H19V13Z',
  trash: 'M19,4H15.5L14.5,3H9.5L8.5,4H5V6H19M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19Z',
  copy: 'M19,21H8V7H19M19,5H8A2,2 0 0,0 6,7V21A2,2 0 0,0 8,23H19A2,2 0 0,0 21,21V7A2,2 0 0,0 19,5M16,1H4A2,2 0 0,0 2,3V17H4V3H16V1Z',
  undo: 'M12.5,8C9.85,8 7.45,9 5.6,10.6L2,7V16H11L7.38,12.38C8.77,11.22 10.54,10.5 12.5,10.5C16.04,10.5 19.05,12.81 20.1,16L22.47,15.22C21.08,11.03 17.15,8 12.5,8Z',
  redo: 'M18.4,10.6C16.55,9 14.15,8 11.5,8C6.85,8 2.92,11.03 1.54,15.22L3.9,16C4.95,12.81 7.95,10.5 11.5,10.5C13.45,10.5 15.23,11.22 16.62,12.38L13,16H22V7L18.4,10.6Z',
  tablet: 'M19,18H5V6H19M21,4H3C1.89,4 1,4.89 1,6V18A2,2 0 0,0 3,20H21A2,2 0 0,0 23,18V6C23,4.89 22.1,4 21,4Z',
  sheet: 'M13,3V9H21V3M13,21H21V11H13M3,21H11V15H3M3,13H11V3H3V13Z',
  upload: 'M9,16V10H5L12,3L19,10H15V16H9M5,20V18H19V20H5Z',
  download: 'M5,20H19V18H5M19,9H15V3H9V9H5L12,16L19,9Z',
  clock: 'M12,20A8,8 0 0,0 20,12A8,8 0 0,0 12,4A8,8 0 0,0 4,12A8,8 0 0,0 12,20M12,2A10,10 0 0,1 22,12A10,10 0 0,1 12,22C6.47,22 2,17.5 2,12A10,10 0 0,1 12,2M12.5,7V12.25L17,14.92L16.25,16.15L11,13V7H12.5Z',
  image: 'M8.5,13.5L11,16.5L14.5,12L19,18H5M21,19V5C21,3.89 20.1,3 19,3H5A2,2 0 0,0 3,5V19A2,2 0 0,0 5,21H19A2,2 0 0,0 21,19Z',
  text: 'M18.5,4L19.66,8.35L18.7,8.61C18.25,7.74 17.79,6.87 17.26,6.43C16.73,6 16.11,6 15.5,6H13V16.5C13,17 13,17.5 13.33,17.75C13.67,18 14.33,18 15,18V19H9V18C9.67,18 10.33,18 10.67,17.75C11,17.5 11,17 11,16.5V6H8.5C7.89,6 7.27,6 6.74,6.43C6.21,6.87 5.75,7.74 5.3,8.61L4.34,8.35L5.5,4H18.5Z',
  'chevron-right': 'M8.59,16.58L13.17,12L8.59,7.41L10,6L16,12L10,18L8.59,16.58Z',
});
const icon = n => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="${ICON[n] || ''}"/></svg>`;
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
/** h('div', {class: 'x', onclick: fn}, child, 'text') */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const k in attrs || {}) {
    const v = attrs[k];
    if (v == null || v === false) continue;
    if (k === 'html') el.innerHTML = v; else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && k !== 'list') el[k] = v; else el.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(c));
  return el;
}
const btn = (label, ic, onclick, cls) => h('button', {class: 'btn ' + (cls || ''), onclick, html: (ic ? icon(ic) : '') + (label ? `<span>${esc(label)}</span>` : ''), type: 'button'});
function toast(text, bad) { const t = $('#toast'); t.textContent = text; t.className = 'show' + (bad ? ' bad' : ''); clearTimeout(toast.t); toast.t = setTimeout(() => { t.className = ''; }, 2600); }

const api = (path, opt) => fetch('admin/api/' + path, opt).then(async r => { if (!r.ok) throw new Error((await r.text()) || r.statusText); return r.json(); });
const send = (method, path, body) => api(path, {method, headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body || {})});
const fail = e => toast(e.message, true);

const A = {state: {tablets: [], designs: [], assets: []}, view: 'tablets', ed: null, ents: [], areas: []};
const setState = s => { A.state = s; rail(); if (A.view === 'tablets') viewTablets(); else if (A.view === 'designs') viewDesigns(); };

// ---------- rail ----------
function rail() {
  const r = $('#rail'), pending = A.state.tablets.some(t => t.status === 'pending');
  const item = (label, ic, cur, onclick, extra, cls) => h('button', {type: 'button', title: label, class: cls || '', 'aria-current': cur ? 'page' : null, onclick, html: (ic ? icon(ic) : '') + `<span>${esc(label)}</span>` + (extra || '')});
  r.replaceChildren(
    h('div', {class: 'brand', html: 'HomePanel <span>Studio</span>'}),
    item('Tablets', 'tablet', A.view === 'tablets', () => go('tablets'), pending ? '<span class="dot" title="A tablet is waiting for approval"></span>' : `<span class="n">${A.state.tablets.length}</span>`),
    item('Designs', 'sheet', A.view === 'designs' || A.view === 'editor', () => go('designs'), `<span class="n">${A.state.designs.length}</span>`),
    ...A.state.designs.map(d => item(d.name, null, A.view === 'editor' && A.ed && A.ed.id === d.id, () => openDesign(d.id), '', 'sub')));
}
function go(view) {
  if (A.ed && A.ed.dirty && !confirm('Leave without saving? Changes to "' + A.ed.name + '" will be lost.')) return;
  A.ed = null; A.view = view; rail(); history.replaceState(null, '', '#' + view);
  view === 'tablets' ? viewTablets() : viewDesigns();
}

// ---------- tablets ----------
function viewTablets() {
  const ts = [...A.state.tablets].sort((a, b) => (a.status === 'approved') - (b.status === 'approved') || a.name.localeCompare(b.name));
  const rows = ts.map(t => {
    const pending = t.status === 'pending';
    const design = h('select', {'aria-label': 'Design for ' + t.name, disabled: pending, onchange: e => send('PATCH', 'tablets/' + t.id, {design: e.target.value || null}).then(setState, fail)},
      h('option', {value: ''}, 'None'), ...A.state.designs.map(d => h('option', {value: d.id, selected: d.id === t.design}, d.name)));
    return h('tr', null,
      h('td', null, h('input', {type: 'text', value: t.name, 'aria-label': 'Tablet name', onchange: e => send('PATCH', 'tablets/' + t.id, {name: e.target.value.trim() || t.name}).then(setState, fail)})),
      h('td', null, t.model || 'Unknown', h('div', {class: 'sub'}, t.width ? `${t.width} × ${t.height}, ${t.orientation}` : 'Size not reported')),
      h('td', null, h('span', {class: 'chip ' + (pending ? 'wait' : t.online ? 'live' : '')}, pending ? 'Waiting for approval' : t.online ? 'Connected' : 'Not connected')),
      h('td', null, design),
      h('td', {class: 'act'},
        pending ? btn('Approve', null, () => send('POST', 'tablets/' + t.id + '/approve').then(setState, fail), 'go') : null,
        btn('Remove', 'trash', () => { if (confirm('Remove "' + t.name + '"? It will have to be approved again.')) api('tablets/' + t.id, {method: 'DELETE'}).then(setState, fail); }, 'stop')));
  });
  $('#main').replaceChildren(
    h('div', {class: 'head'}, h('h1', null, 'Tablets')),
    h('div', {class: 'body'}, ts.length
      ? h('table', null, h('thead', null, h('tr', null, ...['Name', 'Device', 'Status', 'Design', ''].map(x => h('th', null, x)))), h('tbody', null, ...rows))
      : h('div', {class: 'empty', html: '<b>No tablets yet</b>Open the HomePanel app on a tablet that is on the same network. It finds this server by itself and appears here for approval.'})));
}

// ---------- designs ----------
const BLANK = () => ({format: 1, grid: {cols: 64, rows: 48}, start: 'home', rooms: {},
  theme: {background: {image: 'assets/dusk.svg', color: '#141a5c', dim: 0.04}, tile: {fill: 'rgba(255,255,255,.15)', radius: 22, gap: 5, glass: true}},
  pages: [{id: 'home', name: 'Home', tiles: []}]});
function viewDesigns() {
  const used = id => A.state.tablets.filter(t => t.design === id).length;
  const pick = h('input', {type: 'file', accept: '.json,application/json', hidden: true, onchange: async e => {
    const f = e.target.files[0]; if (!f) return;
    try { const d = JSON.parse(await f.text()); const rec = await send('POST', 'designs', {name: f.name.replace(/\.json$/i, ''), design: d.design || d}); openDesign(rec.id); }
    catch (err) { toast('That file is not a HomePanel design: ' + err.message, true); }
  }});
  const rows = A.state.designs.map(d => h('tr', null,
    h('td', null, h('button', {class: 'btn', type: 'button', onclick: () => openDesign(d.id), html: `<span>${esc(d.name)}</span>` + icon('chevron-right')})),
    h('td', null, `${d.cols} × ${d.rows} cells`, h('div', {class: 'sub'}, d.pages === 1 ? '1 page' : d.pages + ' pages')),
    h('td', null, used(d.id) ? (used(d.id) === 1 ? 'On 1 tablet' : 'On ' + used(d.id) + ' tablets') : h('span', {class: 'sub'}, 'Not in use')),
    h('td', {class: 'act'},
      btn('Duplicate', 'copy', () => send('POST', 'designs/' + d.id + '/duplicate').then(setState, fail)),
      btn('Export', 'download', () => api('designs/' + d.id).then(rec => { const a = h('a', {href: URL.createObjectURL(new Blob([JSON.stringify(rec.design, null, 1)], {type: 'application/json'})), download: rec.name + '.json'}); a.click(); }, fail)),
      btn('Delete', 'trash', () => { if (confirm('Delete "' + d.name + '"?' + (used(d.id) ? ' Tablets using it will show no dashboard.' : ''))) api('designs/' + d.id, {method: 'DELETE'}).then(setState, fail); }, 'stop'))));
  $('#main').replaceChildren(
    h('div', {class: 'head'}, h('h1', null, 'Designs'), h('span', {class: 'sp'}), pick,
      btn('Import', 'upload', () => pick.click()),
      btn('New design', 'plus', () => send('POST', 'designs', {name: 'New design', design: BLANK()}).then(rec => openDesign(rec.id), fail), 'go')),
    h('div', {class: 'body'}, rows.length
      ? h('table', null, h('thead', null, h('tr', null, ...['Design', 'Grid', 'Used by', ''].map(x => h('th', null, x)))), h('tbody', null, ...rows))
      : h('div', {class: 'empty', html: '<b>No designs yet</b>A design is a set of pages laid out on a grid. Make one, then give it to a tablet.'})));
}

// ---------- editor: what each tile type is, and which fields it has ----------
const TYPES = {
  entity: {label: 'Light or switch', icon: 'lightbulb', w: 10, h: 8, fields: [['entity', 'Entity', 'entity'], ['name', 'Name', 'text'], ['icon', 'Icon', 'icon'], ['confirm', 'Ask first', 'text', 'Question to confirm, or leave empty']]},
  action: {label: 'Scene or script', icon: 'star', w: 12, h: 6, fields: [['entity', 'Run', 'entity', ['scene', 'script', 'button']], ['name', 'Name', 'text'], ['label', 'Small text', 'text'], ['icon', 'Icon', 'icon'], ['confirm', 'Ask first', 'text', 'Question to confirm, or leave empty']]},
  room: {label: 'Room', icon: 'home', w: 12, h: 8, fields: [['area', 'Room', 'area'], ['name', 'Name', 'text', 'Room name'], ['icon', 'Icon', 'icon']]},
  camera: {label: 'Camera', icon: 'video', w: 18, h: 12, fields: [['entity', 'Camera', 'entity', ['camera']], ['name', 'Name', 'text'], ['video', 'Live video', 'bool'], ['page', 'Tap opens', 'page']]},
  media: {label: 'Media player', icon: 'play', w: 24, h: 8, fields: [['entity', 'Player', 'entity', ['media_player']], ['name', 'Name', 'text']]},
  weather: {label: 'Weather', icon: 'weather-sunny', w: 14, h: 6, fields: [['entity', 'Source', 'entity', ['weather']]]},
  clock: {label: 'Clock', icon: 'clock', w: 24, h: 13, flat: true, fields: []},
  people: {label: 'Who is home', icon: 'account-multiple', w: 18, h: 6, fields: [['entities', 'People', 'entities', ['person']]]},
  alerts: {label: 'Alerts', icon: 'alert', w: 18, h: 6, fields: [], note: 'Shows only while something is wrong. Its list of things to watch is not editable here yet.'},
  nav: {label: 'Page link', icon: 'chevron-right', w: 10, h: 5, fields: [['page', 'Opens', 'page'], ['name', 'Name', 'text'], ['icon', 'Icon', 'icon']]},
  label: {label: 'Text', icon: 'text', w: 20, h: 5, flat: true, fields: [['text', 'Text', 'text'], ['size', 'Size', 'range', [0.2, 1, 0.02]]]},
  image: {label: 'Picture', icon: 'image', w: 12, h: 8, fields: []},
};
const SCREENS = [[1024, 768, 'iPad landscape'], [768, 1024, 'iPad portrait'], [1280, 800, 'Tablet 1280 × 800'], [800, 480, 'Panel 800 × 480']];
const rgba = s => { const m = /rgba?\(([\d.\s]+),([\d.\s]+),([\d.\s]+)(?:,([\d.\s]+))?\)/.exec(s || ''); const x = v => (+v).toString(16).padStart(2, '0');
  return m ? {hex: '#' + x(m[1]) + x(m[2]) + x(m[3]), a: m[4] == null ? 1 : +m[4]} : /^#[0-9a-f]{6}$/i.test(s || '') ? {hex: s, a: 1} : null; };
const toRgba = (hex, a) => `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${a})`;

async function openDesign(id, at) {
  if (A.ed && A.ed.dirty && A.ed.id !== id && !confirm('Leave without saving? Changes to "' + A.ed.name + '" will be lost.')) return;
  try {
    const rec = await api('designs/' + id);
    if (!A.ents.length) api('entities').then(r => { A.ents = r.entities; A.areas = r.areas; if (A.view === 'editor') inspector(); }, fail);  // redraw: names and rooms have arrived
    const t = A.state.tablets.find(x => x.design === id && x.width) || A.state.tablets.find(x => x.width);
    A.ed = {id, name: rec.name, design: rec.design, page: rec.design.start || rec.design.pages[0].id, sel: -1, dirty: false, hist: [], redo: [],
      screen: t ? {w: t.width, h: t.height} : {w: 1024, h: 768}, tab: 'tile', use: false, open: false};
    if (at && A.ed.design.pages.some(p => p.id === at.page)) A.ed.page = at.page;
    if (at && at.tile >= 0 && at.tile < page().tiles.length) A.ed.sel = at.tile;
    A.view = 'editor'; rail(); viewEditor(); history.replaceState(null, '', '#design=' + id);  // a refresh comes back to the same design
  } catch (e) { fail(e); }
}

// ---------- editor ----------
const ed = () => A.ed;
const page = () => ed().design.pages.find(p => p.id === ed().page) || ed().design.pages[0];
const tile = () => page().tiles[ed().sel];

function mark() { const e = ed(); e.hist.push(JSON.stringify(e.design)); if (e.hist.length > 80) e.hist.shift(); e.redo = []; }
/** Every change goes through here: remember the state before a run of edits, apply, redraw, tell the sheet. */
function change(fn, opts) {
  const e = ed(), o = opts || {};
  if (!e.open) { mark(); e.open = !!o.live; }
  fn(); e.dirty = true; saveLabel();
  if (!o.keepBoxes) boxes();
  if (o.inspect) inspector();
  push();
}
const settle = () => { if (ed()) ed().open = false; };
function push() {
  if (push.q) return;
  push.q = requestAnimationFrame(() => { push.q = 0; const f = $('.stage iframe'); if (f && ed() && ed().ready) f.contentWindow.postMessage({type: 'hp-design', design: ed().design, page: ed().page}, '*'); });
}
function travel(from, to) {
  const e = ed(); if (!from.length) return;
  to.push(JSON.stringify(e.design)); e.design = JSON.parse(from.pop());
  if (!e.design.pages.some(p => p.id === e.page)) e.page = e.design.pages[0].id;
  e.sel = Math.min(e.sel, page().tiles.length - 1); e.dirty = true; e.open = false;
  viewEditor(true); fit();  // fit: an undone grid change alters cell size
}
async function save() {
  const e = ed();
  try { await send('PUT', 'designs/' + e.id, {name: e.name, design: e.design}); e.dirty = false; saveLabel(); toast('Saved. Tablets using it update now.'); api('state').then(s => { A.state = s; rail(); }); }
  catch (err) { toast('Not saved: ' + err.message, true); }
}
/** Toolbar state: the saved/unsaved note, and buttons that have nothing to do right now are disabled. */
function saveLabel() {
  const e = ed(), s = $('.saved'); if (!s) return;
  s.textContent = e.dirty ? 'Unsaved changes' : 'Saved'; s.className = 'saved' + (e.dirty ? ' dirty' : '');
  const set = (k, off) => { const b = $('.bar [data-k=' + k + ']'); if (b) b.disabled = off; };
  set('undo', !e.hist.length); set('redo', !e.redo.length); set('save', !e.dirty);
}

function viewEditor(keepFrame) {
  const e = ed(), d = e.design;
  const tabs = h('div', {class: 'tabs', role: 'tablist', 'aria-label': 'Pages'}, ...d.pages.map(p => h('button', {type: 'button', role: 'tab', 'aria-selected': p.id === e.page,
    onclick: () => { e.page = p.id; e.sel = -1; viewEditor(true); push(); }}, p.name || p.id)));
  const screens = [...SCREENS];
  A.state.tablets.filter(t => t.width).forEach(t => { if (!screens.some(s => s[0] === t.width && s[1] === t.height)) screens.unshift([t.width, t.height, t.name]); });
  const bar = h('div', {class: 'bar'},
    h('input', {type: 'text', class: 'name', value: e.name, 'aria-label': 'Design name', oninput: ev => { e.name = ev.target.value; e.dirty = true; saveLabel(); }}),
    h('span', {class: 'sep'}), tabs,
    btn('', 'plus', () => { const id = 'page' + (d.pages.length + 1); change(() => d.pages.push({id, name: 'Page ' + (d.pages.length + 1), tiles: []})); e.page = id; e.sel = -1; e.tab = 'page'; viewEditor(true); }, 'icon'),
    h('span', {class: 'sp'}),
    h('select', {'aria-label': 'Screen size', onchange: ev => { const [w, hh] = ev.target.value.split('x').map(Number); e.screen = {w, h: hh}; viewEditor(); }},
      ...screens.map(s => h('option', {value: s[0] + 'x' + s[1], selected: s[0] === e.screen.w && s[1] === e.screen.h}, `${s[2]} (${s[0]} × ${s[1]})`))),
    btn(e.use ? 'Back to editing' : 'Try it', null, () => { e.use = !e.use; viewEditor(true); if (e.use) toast('Taps on the sheet now control the real house.'); }, e.use ? 'on' : ''),
    h('span', {class: 'sep'}),
    btn('', 'undo', () => travel(e.hist, e.redo), 'icon'), btn('', 'redo', () => travel(e.redo, e.hist), 'icon'),
    h('span', {class: 'saved'}), btn('Save', null, save, 'go'));
  const ic = bar.querySelectorAll('.btn.icon');
  [['Add a page'], ['Undo (Ctrl+Z)', 'undo'], ['Redo (Ctrl+Y)', 'redo']].forEach(([title, k], i) => { ic[i].title = title; ic[i].setAttribute('aria-label', title); if (k) ic[i].dataset.k = k; });
  bar.lastChild.dataset.k = 'save';

  const palette = h('div', {class: 'palette'}, h('h2', null, 'Add a tile'),
    ...Object.keys(TYPES).map(k => h('button', {type: 'button', title: 'Add: ' + TYPES[k].label, onclick: () => addTile(k), html: icon(TYPES[k].icon) + `<span>${esc(TYPES[k].label)}</span>`})));

  if (keepFrame && $('.ed')) {
    // Same design, same sheet: swap the toolbar and redraw the edit layer only. Re-inserting the preview
    // frame would make the browser reload it and reconnect to the house on every page switch or undo.
    const held = document.activeElement && document.activeElement.dataset.k;  // keep keyboard focus on Undo/Redo across the swap
    $('.bar').replaceWith(bar); $('.stage').classList.toggle('use', e.use);
    if (held && !$('.bar [data-k=' + held + ']').disabled) $('.bar [data-k=' + held + ']').focus();
    saveLabel(); boxes(); inspector(); push();
    return;
  }
  e.ready = false;
  const frame = h('iframe', {title: 'Dashboard preview', src: 'renderer/index.html?preview=1&key=studio-preview&design=' + encodeURIComponent(e.id)});
  const over = h('div', {class: 'over grid'});
  const stage = h('div', {class: 'stage' + (e.use ? ' use' : '')}, h('div', {class: 'frame'}, frame), over);
  const sheet = h('div', {class: 'sheet'}, h('div', {class: 'ruler top'}), h('div', {class: 'ruler left'}), stage);
  const wrap = h('div', {class: 'sheetwrap'}, sheet);
  over.addEventListener('pointerdown', ev => { if (ev.target === over) { e.sel = -1; boxes(); inspector(); } });

  $('#main').replaceChildren(bar, h('div', {class: 'ed'}, palette, wrap, h('aside', {class: 'insp', 'aria-label': 'Properties'})));
  saveLabel(); fit(); inspector();
}

/** Scale the sheet to the space available and draw the cell rulers. */
function fit() {
  const e = ed(), wrap = $('.sheetwrap'); if (!wrap) return;
  const {w, h: hh} = e.screen, g = e.design.grid;
  const s = e.s = Math.min((wrap.clientWidth - 62) / w, (wrap.clientHeight - 70) / hh, 1);
  const sheet = $('.sheet'), stage = $('.stage'), frame = stage.querySelector('iframe');
  sheet.style.width = w * s + 24 + 'px'; sheet.style.height = hh * s + 46 + 'px';
  stage.style.width = w * s + 'px'; stage.style.height = hh * s + 'px';
  frame.width = w; frame.height = hh; frame.style.transform = `scale(${s})`;
  e.cw = w * s / g.cols; e.ch = hh * s / g.rows;
  $('.over').style.backgroundSize = `${e.cw}px ${e.ch}px`;
  const top = $('.ruler.top'), left = $('.ruler.left');
  top.style.width = w * s + 'px'; left.style.height = hh * s + 'px';
  top.replaceChildren(...Array.from({length: Math.ceil(g.cols / 8)}, (_, i) => h('i', {style: `left:${i * 8 * e.cw}px`}, String(i * 8))));
  left.replaceChildren(...Array.from({length: Math.ceil(g.rows / 8)}, (_, i) => h('i', {style: `top:${i * 8 * e.ch}px`}, String(i * 8))));
  boxes();
}
window.addEventListener('resize', () => { if (A.view === 'editor') fit(); });
window.addEventListener('message', ev => { if (ev.data && ev.data.type === 'hp-ready' && ed()) { ed().ready = true; push(); } });

/** One box per tile over the preview: numbered like instruments on a plot; the selected one shows its measurements. */
function boxes() {
  const e = ed(), over = $('.over'); if (!over) return;
  const hadFocus = over.contains(document.activeElement);  // redrawing replaces the focused box: give focus back after
  over.replaceChildren(...page().tiles.map((t, i) => {
    const b = h('div', {class: 'box' + (i === e.sel ? ' sel' : ''), tabIndex: 0, role: 'button', 'aria-label': `Tile ${i + 1}, ${(TYPES[t.type] || {}).label || t.type}`, 'aria-pressed': i === e.sel, style: `left:${t.x * e.cw}px;top:${t.y * e.ch}px;width:${t.w * e.cw}px;height:${t.h * e.ch}px`, title: (TYPES[t.type] || {}).label || t.type},
      h('span', {class: 'tag'}, String(i + 1)), h('span', {class: 'dim' + (t.y + t.h > e.design.grid.rows - 3 ? ' up' : '')}, `${t.w} × ${t.h} at ${t.x}, ${t.y}`),
      ...['nw', 'ne', 'sw', 'se'].map(c => h('span', {class: 'hd ' + c, 'data-c': c})));
    b.addEventListener('pointerdown', ev => drag(ev, i, b));
    b.addEventListener('focus', () => { if (e.sel !== i) { e.sel = i; e.tab = 'tile'; boxes(); inspector(); $('.over').children[i].focus(); } });
    return b;
  }));
  if (hadFocus && over.children[e.sel]) over.children[e.sel].focus();
}
function drag(ev, i, b) {
  const e = ed(), t = page().tiles[i], g = e.design.grid, corner = ev.target.dataset.c, o = {x: t.x, y: t.y, w: t.w, h: t.h};
  ev.preventDefault();
  if (e.sel !== i) { e.sel = i; e.tab = 'tile'; boxes(); inspector(); b = $('.over').children[i]; }
  b.setPointerCapture(ev.pointerId);
  let moved = false;
  const move = m => {
    const dx = Math.round((m.clientX - ev.clientX) / e.cw), dy = Math.round((m.clientY - ev.clientY) / e.ch);
    let {x, y, w, h: hh} = o;
    if (!corner) { x = Math.max(0, Math.min(g.cols - w, o.x + dx)); y = Math.max(0, Math.min(g.rows - hh, o.y + dy)); }
    else {
      if (corner.includes('e')) w = Math.max(2, Math.min(g.cols - o.x, o.w + dx));
      if (corner.includes('s')) hh = Math.max(2, Math.min(g.rows - o.y, o.h + dy));
      if (corner.includes('w')) { x = Math.max(0, Math.min(o.x + o.w - 2, o.x + dx)); w = o.x + o.w - x; }
      if (corner.includes('n')) { y = Math.max(0, Math.min(o.y + o.h - 2, o.y + dy)); hh = o.y + o.h - y; }
    }
    if (x === t.x && y === t.y && w === t.w && hh === t.h) return;
    moved = true;
    change(() => Object.assign(t, {x, y, w, h: hh}), {live: true, keepBoxes: true});
    Object.assign(b.style, {left: x * e.cw + 'px', top: y * e.ch + 'px', width: w * e.cw + 'px', height: hh * e.ch + 'px'});
    b.querySelector('.dim').classList.toggle('up', y + hh > g.rows - 3);  // no room below the last rows: show it above
    b.querySelector('.dim').textContent = `${w} × ${hh} at ${x}, ${y}`;
  };
  const up = () => { b.removeEventListener('pointermove', move); b.removeEventListener('pointerup', up); settle(); if (moved) inspector(); };
  b.addEventListener('pointermove', move); b.addEventListener('pointerup', up);
}

function addTile(type) {
  const e = ed(), def = TYPES[type], g = e.design.grid, ts = page().tiles;
  const free = (x, y) => !ts.some(t => x < t.x + t.w && x + def.w > t.x && y < t.y + t.h && y + def.h > t.y);
  let at = {x: 2, y: 2};
  search: for (let y = 2; y + def.h <= g.rows - 1; y++) for (let x = 2; x + def.w <= g.cols - 1; x++) if (free(x, y)) { at = {x, y}; break search; }
  const t = Object.assign({type, w: def.w, h: def.h}, at, def.flat ? {flat: true} : {});
  if (type === 'label') t.text = 'Text';
  change(() => ts.push(t)); e.sel = ts.length - 1; e.tab = 'tile'; boxes(); inspector();
}

// ---------- inspector ----------
function inspector() {
  const e = ed(), box = $('.insp'); if (!box) return;
  const tab = (id, label) => h('button', {type: 'button', role: 'tab', 'aria-selected': e.tab === id, onclick: () => { e.tab = id; inspector(); }}, label);
  box.replaceChildren(h('div', {class: 'tabs', role: 'tablist', 'aria-label': 'Properties'}, tab('tile', 'Tile'), tab('look', 'Look'), tab('page', 'Page')),
    ...(e.tab === 'look' ? lookFields() : e.tab === 'page' ? pageFields() : tileFields()));
  // Every slider shows its measurement: percent for 0-1 amounts (opacity, darken, text size), pixels for the rest.
  box.querySelectorAll('input[type=range]').forEach(r => {
    const out = h('output', {class: 'val'}), show = () => { out.textContent = +r.max <= 1 ? Math.round(r.value * 100) + '%' : r.value + ' px'; };
    r.addEventListener('input', show); show(); r.after(out);
  });
}
/** Small button that drops a per-tile override and goes back to the theme's value. An icon, so the slider beside it keeps its room. */
const reset = fn => { const b = btn('', 'undo', fn, 'icon mini'); b.title = "Use the theme's value"; b.setAttribute('aria-label', b.title); return b; };
const row = (label, ...ctl) => h('div', {class: 'f'}, h('label', null, label), h('div', {class: 'w'}, ...ctl));
const textIn = (val, set, ph) => h('input', {type: 'text', value: val == null ? '' : val, placeholder: ph || '', oninput: ev => set(ev.target.value), onchange: settle});
/** Colour plus see-through amount, stored as rgba(). "Theme" clears the override. */
function colourIn(val, set, fallback, clearable) {
  const c = rgba(val) || rgba(fallback) || {hex: '#ffffff', a: 0.15};
  const col = h('input', {type: 'color', value: c.hex, 'aria-label': 'Colour', oninput: () => set(toRgba(col.value, +al.value)), onchange: settle});
  const al = h('input', {type: 'range', min: 0, max: 1, step: 0.01, value: c.a, 'aria-label': 'Opacity', title: 'How solid the colour is', oninput: () => set(toRgba(col.value, +al.value)), onchange: settle});
  return [col, al, clearable && val ? reset(() => { set(null); settle(); inspector(); }) : null];
}
function entityPick(val, set, domains, many) {
  const name = id => { const x = A.ents.find(n => n.id === id); return x ? x.name : id || ''; };
  const input = h('input', {type: 'text', value: many ? '' : name(val), placeholder: many ? 'Add a person' : 'Search by name', 'aria-label': 'Entity', autocomplete: 'off'});
  const list = h('div', {class: 'list', hidden: true});
  const fill = () => {
    const q = input.value.trim().toLowerCase();
    const hits = A.ents.filter(n => (!domains || domains.includes(n.id.split('.')[0])) && (!q || n.name.toLowerCase().includes(q) || n.id.includes(q))).slice(0, 40);
    list.replaceChildren(...(hits.length ? hits.map(n => h('button', {type: 'button', onmousedown: ev => { ev.preventDefault(); set(n.id); settle(); inspector(); }}, n.name, h('small', null, n.id)))
      : [h('div', {class: 'note', style: 'padding:8px 9px'}, A.ents.length ? 'Nothing matches.' : 'Loading the list from Home Assistant.')]));
    list.hidden = false;
  };
  input.addEventListener('focus', () => { input.select(); fill(); }); input.addEventListener('input', fill);
  // Type, arrow down, Enter: with thousands of entities the keyboard is the main route.
  input.addEventListener('keydown', ev => {
    const items = [...list.querySelectorAll('button')], at = items.findIndex(b => b.classList.contains('hi'));
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault(); if (!items.length) return;
      const next = (at + (ev.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items.forEach((b, i) => b.classList.toggle('hi', i === next)); items[next].scrollIntoView({block: 'nearest'});
    } else if (ev.key === 'Enter' && items.length) { ev.preventDefault(); (items[at] || items[0]).dispatchEvent(new MouseEvent('mousedown', {cancelable: true})); }
    else if (ev.key === 'Escape') input.blur();
  });
  input.addEventListener('blur', () => { list.hidden = true; if (!many) input.value = name(val); });
  return h('div', {class: 'pick'}, input, list);
}
function picture(val, set) {
  const up = h('input', {type: 'file', accept: 'image/*', hidden: true, onchange: async ev => {
    const f = ev.target.files[0]; if (!f) return; const fd = new FormData(); fd.append('file', f);
    try { const before = new Set(A.state.assets); A.state = await api('assets', {method: 'POST', body: fd}); const added = A.state.assets.find(a => !before.has(a)) || f.name; set('assets/' + added); settle(); inspector(); }
    catch (err) { toast('Upload failed: ' + err.message, true); }
  }});
  const names = ['dusk.svg', ...A.state.assets.filter(a => a !== 'dusk.svg')];
  return h('div', {class: 'pics'},
    h('button', {type: 'button', 'aria-pressed': !val, onclick: () => { set(null); settle(); inspector(); }}, 'None'),
    ...names.map(a => h('button', {type: 'button', title: a, 'aria-label': a, 'aria-pressed': val === 'assets/' + a, style: `background-image:url("assets/${encodeURIComponent(a)}")`, onclick: () => { set('assets/' + a); settle(); inspector(); }})),
    h('button', {type: 'button', onclick: () => up.click(), html: icon('upload')}), up);
}

function tileFields() {
  const e = ed(), t = tile(), d = e.design;
  if (!t) return [h('p', {class: 'note', style: 'margin-top:16px'}, 'Select a tile on the sheet, or add one from the list on the left.')];
  const def = TYPES[t.type] || {label: t.type, fields: []}, live = {live: true, keepBoxes: true};
  const setp = (k, v, o) => change(() => { if (v == null || v === '') delete t[k]; else t[k] = v; }, o || live);
  const style = (k, v) => change(() => { t.style = t.style || {}; if (v == null || v === '') delete t.style[k]; else t.style[k] = v; if (!Object.keys(t.style).length) delete t.style; }, live);
  const num = (k, min, max) => h('div', null, h('label', null, k.toUpperCase()), h('input', {type: 'number', min, max, value: t[k], 'aria-label': k,
    onchange: ev => { const v = Math.max(min, Math.min(max, Math.round(+ev.target.value || 0))); change(() => { t[k] = v; }, {inspect: true}); settle(); }}));
  const out = [h('h2', null, `${def.label}, tile ${e.sel + 1}`),
    h('div', {class: 'f4'}, num('x', 0, d.grid.cols - t.w), num('y', 0, d.grid.rows - t.h), num('w', 2, d.grid.cols - t.x), num('h', 2, d.grid.rows - t.y))];
  for (const [k, label, kind, opt] of def.fields) {
    if (kind === 'text') out.push(row(label, textIn(t[k], v => setp(k, v), opt)));
    else if (kind === 'entity') out.push(row(label, entityPick(t[k], v => change(() => {
      t[k] = v; if (t.type === 'action') { const dom = v.split('.')[0]; t.service = dom === 'button' ? 'button.press' : dom + '.turn_on'; }
    }, {keepBoxes: true}), opt)));
    else if (kind === 'entities') out.push(row(label, entityPick(null, v => change(() => { t[k] = [...new Set([...(t[k] || []), v])]; }, {keepBoxes: true}), opt, true)),
      ...(t[k] || []).map(id => row('', h('span', {style: 'flex:1;overflow:hidden;text-overflow:ellipsis'}, (A.ents.find(n => n.id === id) || {name: id}).name),
        btn('', 'trash', () => { change(() => { t[k] = t[k].filter(x => x !== id); }, {inspect: true}); settle(); }, 'icon'))));
    else if (kind === 'area') out.push(row(label, h('select', {onchange: ev => { setp(k, ev.target.value, {keepBoxes: true}); settle(); }}, h('option', {value: ''}, 'Choose a room'), ...A.areas.map(a => h('option', {value: a.id, selected: a.id === t[k]}, a.name)))));
    else if (kind === 'page') out.push(row(label, h('select', {onchange: ev => { setp(k, ev.target.value, {keepBoxes: true}); settle(); }}, h('option', {value: ''}, 'Nothing'), ...d.pages.map(p => h('option', {value: p.id, selected: p.id === t[k]}, p.name || p.id)))));
    else if (kind === 'bool') out.push(row(label, h('input', {type: 'checkbox', checked: t[k] !== false, onchange: ev => { setp(k, ev.target.checked ? null : false, {keepBoxes: true}); settle(); }})));
    else if (kind === 'range') out.push(row(label, h('input', {type: 'range', min: opt[0], max: opt[1], step: opt[2], value: t[k] == null ? 0.5 : t[k], oninput: ev => setp(k, +ev.target.value), onchange: settle})));
    else if (kind === 'icon') out.push(h('h2', null, label), h('div', {class: 'icons'}, ...Object.keys(window.HP_ICONS).filter(n => n !== 'lightbulb-group').map(n =>
      h('button', {type: 'button', title: n, 'aria-label': n, 'aria-pressed': t[k] === n, html: icon(n), onclick: () => { setp(k, n, {keepBoxes: true, inspect: true}); settle(); }}))));
  }
  if (def.note) out.push(h('p', {class: 'note'}, def.note));
  const s = t.style || {}, th = (d.theme || {}).tile || {};
  out.push(h('h2', null, 'Appearance'),
    row('Background', h('input', {type: 'checkbox', checked: !t.flat, 'aria-label': 'Show tile background', onchange: ev => { setp('flat', ev.target.checked ? null : true, {keepBoxes: true, inspect: true}); settle(); }}), h('span', {class: 'note', style: 'margin:0'}, t.flat ? 'None, content only' : 'Shown')));
  if (!t.flat) out.push(
    row('Fill', ...colourIn(s.fill, v => style('fill', v), th.fill, true)),
    row('Border', ...colourIn(s.border, v => style('border', v), th.border || 'rgba(255,255,255,.4)', true)),
    row('Corners', h('input', {type: 'range', min: 0, max: 60, step: 1, value: s.radius == null ? th.radius || 22 : s.radius, oninput: ev => style('radius', +ev.target.value), onchange: settle}), s.radius != null ? reset(() => { style('radius', null); settle(); inspector(); }) : null),
    row('Text', h('input', {type: 'color', value: (rgba(s.text) || {hex: '#ffffff'}).hex, 'aria-label': 'Text colour', oninput: ev => style('text', ev.target.value), onchange: settle}), s.text ? reset(() => { style('text', null); settle(); inspector(); }) : null),
    h('h2', null, 'Picture'), picture(s.image, v => style('image', v)));
  out.push(h('div', {class: 'apart'},
    btn('Duplicate', 'copy', () => { const c = JSON.parse(JSON.stringify(t)); c.x = Math.min(d.grid.cols - c.w, c.x + 1); c.y = Math.min(d.grid.rows - c.h, c.y + 1); change(() => page().tiles.push(c)); e.sel = page().tiles.length - 1; boxes(); inspector(); }),
    btn('Delete tile', 'trash', removeTile, 'stop')));
  return out;
}
function removeTile() { const e = ed(); if (e.sel < 0) return; change(() => page().tiles.splice(e.sel, 1)); e.sel = -1; boxes(); inspector(); }

function lookFields() {
  const d = ed().design, live = {live: true, keepBoxes: true};
  const th = d.theme = d.theme || {}, bg = th.background = th.background || {}, tl = th.tile = th.tile || {};
  const set = (o, k, v) => change(() => { if (v == null || v === '') delete o[k]; else o[k] = v; }, live);
  return [h('h2', null, 'Backdrop'), picture(bg.image, v => set(bg, 'image', v)),
    row('Colour', h('input', {type: 'color', value: (rgba(bg.color) || {hex: '#141a5c'}).hex, 'aria-label': 'Backdrop colour', oninput: ev => set(bg, 'color', ev.target.value), onchange: settle})),
    row('Darken', h('input', {type: 'range', min: 0, max: 0.8, step: 0.01, value: bg.dim || 0, oninput: ev => set(bg, 'dim', +ev.target.value), onchange: settle})),
    h('h2', null, 'Tiles'),
    row('Fill', ...colourIn(tl.fill, v => set(tl, 'fill', v), 'rgba(255,255,255,.15)')),
    row('Lit fill', ...colourIn(rgba(tl.fillOn) ? tl.fillOn : null, v => set(tl, 'fillOn', v), 'rgba(255,170,80,.88)')),  // unset = the renderer's own amber gradient,
    row('Corners', h('input', {type: 'range', min: 0, max: 60, step: 1, value: tl.radius == null ? 22 : tl.radius, oninput: ev => set(tl, 'radius', +ev.target.value), onchange: settle})),
    row('Spacing', h('input', {type: 'range', min: 0, max: 16, step: 1, value: tl.gap == null ? 5 : tl.gap, oninput: ev => set(tl, 'gap', +ev.target.value), onchange: settle})),
    row('Border', ...colourIn(tl.border, v => set(tl, 'border', v), 'rgba(255,255,255,.4)')),
    row('Lit edge', h('input', {type: 'checkbox', checked: tl.rim !== false, 'aria-label': 'Lit edge', onchange: ev => { set(tl, 'rim', ev.target.checked ? null : false); settle(); }}), h('span', {class: 'note', style: 'margin:0'}, 'Light catching the top edge')),
    row('Frosted', h('input', {type: 'checkbox', checked: tl.glass !== false, 'aria-label': 'Frosted glass', onchange: ev => { set(tl, 'glass', ev.target.checked ? null : false); settle(); }}), h('span', {class: 'note', style: 'margin:0'}, 'Blur the backdrop behind tiles')),
    h('h2', null, 'Grid'),
    h('div', {class: 'f4'}, ...['cols', 'rows'].map(k => h('div', null, h('label', null, k === 'cols' ? 'Columns' : 'Rows'), h('input', {type: 'number', min: 8, max: 160, value: d.grid[k], 'aria-label': k,
      onchange: ev => { const v = Math.max(8, Math.min(160, Math.round(+ev.target.value || d.grid[k]))), f = v / d.grid[k], pos = k === 'cols' ? ['x', 'w'] : ['y', 'h'];
        // Tiles keep their share of the screen, so a design moves between tablet sizes and orientations.
        change(() => { d.pages.forEach(p => p.tiles.forEach(t => { t[pos[0]] = Math.min(v - 2, Math.round(t[pos[0]] * f)); t[pos[1]] = Math.max(2, Math.min(v - t[pos[0]], Math.round(t[pos[1]] * f))); })); d.grid[k] = v; }); settle(); fit(); }})))),
    h('p', {class: 'note'}, 'Smaller cells give finer control. Changing the grid moves and resizes every tile to keep its share of the screen.')];
}

function pageFields() {
  const e = ed(), d = e.design, p = page();
  return [h('h2', null, 'This page'),
    row('Name', textIn(p.name, v => change(() => { p.name = v; }, {live: true, keepBoxes: true}))),
    row('Opens first', h('input', {type: 'checkbox', checked: (d.start || d.pages[0].id) === p.id, 'aria-label': 'Open this page first', onchange: () => { change(() => { d.start = p.id; }, {inspect: true}); settle(); }})),
    h('p', {class: 'note'}, `${p.tiles.length} ${p.tiles.length === 1 ? 'tile' : 'tiles'}. Room pages are made by the tablet from each room's devices and are not listed here.`),
    d.pages.length > 1 ? h('div', {class: 'apart'}, btn('Delete page', 'trash', () => {
      if (!confirm('Delete the page "' + (p.name || p.id) + '" and its tiles?')) return;
      change(() => { d.pages = d.pages.filter(x => x !== p); if (d.start === p.id) d.start = d.pages[0].id; }); e.page = d.pages[0].id; e.sel = -1; viewEditor(true);
    }, 'stop')) : null];
}

// ---------- keyboard ----------
window.addEventListener('keydown', ev => {
  const e = ed(); if (!e || A.view !== 'editor') return;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(ev.target.tagName), mod = ev.ctrlKey || ev.metaKey, k = ev.key.toLowerCase();
  if (mod && k === 's') { ev.preventDefault(); return save(); }
  if (typing) return;
  if (mod && k === 'z') { ev.preventDefault(); return travel(e.hist, e.redo); }
  if (mod && k === 'y') { ev.preventDefault(); return travel(e.redo, e.hist); }
  const t = tile(); if (!t) return;
  const g = e.design.grid, step = {arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, -1], arrowdown: [0, 1]}[k];
  if (step) {
    ev.preventDefault();
    change(() => { if (ev.shiftKey) { t.w = Math.max(2, Math.min(g.cols - t.x, t.w + step[0])); t.h = Math.max(2, Math.min(g.rows - t.y, t.h + step[1])); }
      else { t.x = Math.max(0, Math.min(g.cols - t.w, t.x + step[0])); t.y = Math.max(0, Math.min(g.rows - t.h, t.y + step[1])); } }, {live: true, inspect: true});
  } else if (k === 'delete' || k === 'backspace') { ev.preventDefault(); removeTile(); }
});
window.addEventListener('keyup', settle);
window.addEventListener('beforeunload', ev => { if (A.ed && A.ed.dirty) { ev.preventDefault(); ev.returnValue = ''; } });

// ---------- start ----------
(function start() {
  api('state').then(s => {
    setState(s);
    // #design=<id>, optionally &page=<id>&tile=<number>, so a link or a refresh lands on the same spot
    const q = new URLSearchParams(location.hash.slice(1).replace(/,/g, '&')), want = q.get('design');
    if (want && s.designs.some(d => d.id === want)) openDesign(want, {page: q.get('page'), tile: q.has('tile') ? q.get('tile') - 1 : -1}); else if (location.hash === '#designs') go('designs');
  }, err => {  // nothing loaded: say so on the page, with a way to try again, instead of a blank screen
    $('#main').replaceChildren(h('div', {class: 'body'}, h('div', {class: 'empty'}, h('b', null, 'HomePanel Studio did not answer'),
      'The add-on may still be starting. ' + err.message, h('p', {style: 'margin-top:16px'}, btn('Try again', null, start, 'go')))));
  });
})();
(function live() {  // tablets that say hello appear without a refresh
  const ws = new WebSocket(new URL('admin/api/live', location.href).href.replace(/^http/, 'ws'));
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.type === 'state') { A.state = m.state; rail(); if (A.view !== 'editor') setState(m.state); } };
  ws.onclose = () => setTimeout(live, 4000);
})();
