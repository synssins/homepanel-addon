'use strict';
// HomePanel renderer. The app is a placeholder: everything on screen comes from a design file
// (window.HP_DESIGN): a theme, and pages of tiles placed on a small-cell grid. Tile types are plugins
// registered with HP.tile(); see tiles.js. Later the design, icons and plugins come from the HA add-on.

const HP = window.HP = {tiles: {}, icons: window.HP_ICONS || {}, S: {states: {}, areas: {}, reg: {}}, design: null, live: [], stack: []};
HP.tile = (name, def) => { HP.tiles[name] = def; };
/** Pictures named in a design live on the server; without one, in the app bundle. */
HP.asset = p => !p || /^(https?:|data:)/.test(p) || !HP.server ? p : HP.server + '/' + p.replace(/^\//, '');

const $ = id => document.getElementById(id);
const S = HP.S;
const U = HP.util = {
  esc: s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c])),
  st: e => S.states[e],
  avail: e => !!S.states[e] && S.states[e].state !== 'unavailable',
  fname: e => (S.states[e] && S.states[e].attributes.friendly_name) || e,
  cap: s => (s.charAt(0).toUpperCase() + s.slice(1)).replace(/_/g, ' '),
  active: e => !!S.states[e] && ['on', 'open', 'opening', 'playing', 'home', 'unlocked'].includes(S.states[e].state),
  stateLabel(e) {
    const s = S.states[e];
    if (!s || s.state === 'unavailable') return 'Offline';
    if (s.state === 'on' && s.attributes.brightness) return Math.round(s.attributes.brightness / 2.55) + '%';
    return U.cap(s.state);
  },
  /** 'Master Bedroom Arc Lamp 2' in Master Bedroom -> 'Arc Lamp 2' */
  short(name, room) {
    const n = name.trim(), out = room && n.toLowerCase().startsWith(room.toLowerCase() + ' ') ? n.slice(room.length + 1) : n;
    return out ? out.charAt(0).toUpperCase() + out.slice(1) : name;
  },
  inArea: (area, domain) => Object.keys(S.states).filter(e => e.startsWith(domain + '.') && S.reg[e] && S.reg[e].area === area && !S.reg[e].skip && U.avail(e)).sort(),
  /** Icons are single SVG paths on a 24x24 box (Material Design Icons format), tinted by the text colour. */
  icon: name => HP.icons[name] ? `<svg viewBox="0 0 24 24"><path d="${HP.icons[name]}"/></svg>` : '',
  /** Standard tile body: optional icon, a name line and a label line. Returns the parts for cheap updates. */
  card(body, icon) {
    body.innerHTML = `<div class="ic">${U.icon(icon)}</div><div class="tx"><div class="n"></div><div class="l"></div></div>`;
    return {ic: body.querySelector('.ic'), n: body.querySelector('.n'), l: body.querySelector('.l')};
  },
  /** Set text only when it changed; a name too long for its tile shrinks to fit (down to 70%) before it truncates. */
  set(el, text) {
    if (el.textContent === text) return;
    el.textContent = text;
    if (!el.classList.contains('n')) return;
    el.style.fontSize = '';
    if (el.scrollWidth > el.clientWidth) el.style.fontSize = Math.max(70, Math.floor(el.clientWidth / el.scrollWidth * 98)) + '%';
  },
};

// ---------- theme ----------
function applyTheme(th) {
  const r = document.documentElement.style, t = th.tile || {};
  const vars = {'--text': th.text, '--font': th.font, '--fill': t.fill, '--fill-on': t.fillOn, '--text-on': t.textOn,
    '--radius': t.radius != null ? t.radius + 'px' : null, '--border': t.border, '--gap': t.gap != null ? t.gap + 'px' : null, '--glow-on': t.glowOn};
  for (const k in vars) if (vars[k] != null) r.setProperty(k, vars[k]);
  const bg = th.background || {}, pos = ' center / cover no-repeat';
  // Server copy first; the copy bundled with the app sits underneath in case the server is away.
  const layers = !bg.image ? [] : HP.asset(bg.image) === bg.image ? [bg.image] : [HP.asset(bg.image), bg.image];
  $('bg').style.background = layers.map(u => `url("${u}")` + pos + ', ').join('') + (bg.color || '#141a5c');
  $('blur').style.background = $('bg').style.background;
  $('dim').style.background = `rgba(0,0,0,${bg.dim || 0})`;
  document.body.classList.toggle('noglass', t.glass === false);
  document.body.classList.toggle('norim', t.rim === false);
}

// ---------- pages ----------
const ctx = HP.ctx = {
  service: (domain, svc, entity, data) => HP.ha.call({type: 'call_service', domain, service: svc, target: entity ? {entity_id: entity} : undefined, service_data: data || {}})
    .catch(e => toast(e.message)),
  go: (page, param) => { HP.stack.push({page, param}); show(); },
  back: () => { if (HP.stack.length > 1) HP.stack.pop(); show(); },
  relayout: () => { clearTimeout(ctx._rl); ctx._rl = setTimeout(layout, 50); },
};

/** Room pages are generated from the area's entities, so a new lamp appears without touching the design. */
function roomPage(area) {
  const d = HP.design, room = S.areas[area] || area, cols = d.grid.cols, cfg = (d.rooms || {})[area] || {};
  const tiles = [{type: 'nav', back: true, x: 2, y: 2, w: 10, h: 5, name: 'Back', icon: 'chevron-left'},
    {type: 'label', text: room, x: 13, y: 2, w: cols - 15, h: 5, flat: true, size: 0.62}];
  let x = 2, y = 9;
  const put = (t, w) => { if (x + w > cols - 2) { x = 2; y += 8; } tiles.push(Object.assign(t, {x, y, w, h: 8})); x += w; };
  if (cfg.group && U.avail(cfg.group)) put({type: 'entity', entity: cfg.group, name: 'All lights', icon: 'lightbulb-group'}, 12);
  U.inArea(area, 'light').filter(e => e !== cfg.group).forEach(e => put({type: 'entity', entity: e, name: U.short(U.fname(e), room), icon: 'lightbulb'}, 12));
  U.inArea(area, 'scene').forEach(e => put({type: 'action', service: 'scene.turn_on', entity: e, name: U.short(U.fname(e).split(':').pop().trim(), room), label: 'Scene', icon: 'star'}, 12));
  U.inArea(area, 'cover').forEach(e => put({type: 'entity', entity: e, icon: 'garage', confirm: 'Move this door?'}, 12));
  U.inArea(area, 'media_player').forEach(e => put({type: 'media', entity: e}, 24));
  return {id: '@room', tiles};
}

function show() {
  const d = HP.design, top = HP.stack[HP.stack.length - 1], grid = $('grid');
  HP.live.forEach(i => { if (i.data && i.data.destroy) i.data.destroy(); });
  HP.live = []; grid.innerHTML = '';
  const page = top.page === '@room' ? roomPage(top.param) : d.pages.find(p => p.id === top.page) || d.pages[0];
  grid.style.gridTemplateColumns = `repeat(${d.grid.cols}, 1fr)`;
  grid.style.gridTemplateRows = `repeat(${d.grid.rows}, 1fr)`;
  for (const t of page.tiles) {
    const def = HP.tiles[t.type] || HP.tiles.label, el = document.createElement('div');
    el.className = 'tile t-' + t.type + (t.flat ? ' flat' : '');
    el.style.gridArea = `${t.y + 1} / ${t.x + 1} / span ${t.h} / span ${t.w}`;
    const s = t.style || {};  // per-tile look overrides from the design
    if (s.fill) el.style.setProperty('--fill', s.fill);
    if (s.fillOn) el.style.setProperty('--fill-on', s.fillOn);
    if (s.text) el.style.setProperty('--text', s.text);
    if (s.radius != null) el.style.setProperty('--radius', s.radius + 'px');
    if (s.border) el.style.setProperty('--border', s.border);
    if (s.opacity != null) el.style.opacity = s.opacity;
    el.innerHTML = '<div class="fill"></div>' + (s.image ? `<div class="pic" style="background-image:url('${U.esc(HP.asset(s.image))}')"></div>` : '') + '<div class="body"></div><div class="rim"></div>';
    grid.append(el);
    const inst = {t, el, def, body: el.querySelector('.body')};
    const tap = () => { const a = def.tap ? def.tap(t, ctx, inst) : null; if (a) (t.confirm ? confirmBox(t.confirm, a) : a()); };
    if (def.tap && !t.info) { el.classList.add('tap'); el.addEventListener('click', tap); }
    HP.live.push(inst);
  }
  layout();
  // create after layout so tiles know their pixel size
  HP.live.forEach(i => { i.data = i.def.create ? i.def.create(i.t, i.body, ctx, i) : null; });
  update();
}

/** Size each tile's type scale from its pixels, and cut the blurred backdrop to the tile shapes (cheap glass:
 *  one blurred layer for the whole screen instead of a backdrop filter per tile, which the Air 2 cannot afford). */
function layout() {
  const radius = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--radius')) || 0;
  let path = '';
  for (const i of HP.live) {
    const r = i.el.getBoundingClientRect();
    i.el.style.setProperty('--u', Math.max(11, Math.min(r.height * 0.2, r.width * 0.11, 64)).toFixed(1) + 'px');
    i.el.classList.toggle('wide', r.width / r.height > 2.4);
    if (i.el.classList.contains('flat') || i.el.hidden || !r.width) continue;
    const rr = Math.min(parseFloat(getComputedStyle(i.el).borderTopLeftRadius) || radius, r.width / 2, r.height / 2), x = r.left, y = r.top, w = r.width, h = r.height;
    path += `M${x + rr},${y}h${w - 2 * rr}a${rr},${rr} 0 0 1 ${rr},${rr}v${h - 2 * rr}a${rr},${rr} 0 0 1 ${-rr},${rr}h${-(w - 2 * rr)}a${rr},${rr} 0 0 1 ${-rr},${-rr}v${-(h - 2 * rr)}a${rr},${rr} 0 0 1 ${rr},${-rr}z`;
  }
  $('blurclip').style.clipPath = $('blurclip').style.webkitClipPath = path ? `path('${path}')` : 'inset(50%)';
}

function update() {
  for (const i of HP.live) if (i.def.update) { try { i.def.update(i.t, i.body, ctx, i); } catch (e) { console.error('tile ' + i.t.type + ': ' + e.message); } }
}
/** State changes arrive in bursts; tiles patch their own text and classes, so this is cheap and never eats a tap. */
function dirty() { if (!dirty.t) dirty.t = setTimeout(() => { dirty.t = null; update(); }, 250); }

// ---------- small UI ----------
function toast(text) { const b = $('bar'); b.textContent = text; clearTimeout(toast.t); toast.t = setTimeout(() => { b.textContent = ''; }, 5000); }
// Own dialog: the web view has no built-in confirm().
function confirmBox(text, yes) {
  const m = $('modal');
  m.innerHTML = `<div class="box"><div class="q">${U.esc(text)}</div><div class="row"><div class="mb" data-m="no">Cancel</div><div class="mb go" data-m="yes">Yes</div></div></div>`;
  m.className = 'open';
  m.onclick = e => { const b = e.target.closest('[data-m]'); if (!b && e.target !== m) return; m.className = ''; if (b && b.dataset.m === 'yes') yes(); };
}

// ---------- boot ----------
const keep = {  // survives restarts, so the panel still draws its last design when the server is away
  get(k) { try { return JSON.parse(localStorage.getItem('hp:' + k)); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem('hp:' + k, JSON.stringify(v)); } catch (e) {} },
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
function splash(title, text) {
  $('splash').innerHTML = title ? `<div><div class="st">${U.esc(title)}</div><div class="sx">${U.esc(text || '')}</div></div>` : '';
  $('splash').className = title ? 'open' : '';
}

async function loadAll() {
  const ha = HP.ha, [areas, devices, ents, states] = await Promise.all([
    ha.call({type: 'config/area_registry/list'}), ha.call({type: 'config/device_registry/list'}),
    ha.call({type: 'config/entity_registry/list'}), ha.call({type: 'get_states'})]);
  S.areas = {}; areas.forEach(a => { S.areas[a.area_id] = a.name; });
  keep.set('areas', S.areas);  // room names for the next start, in case Home Assistant is away then
  const dev = {}; devices.forEach(d => { dev[d.id] = d.area_id; });
  S.reg = {}; ents.forEach(e => { S.reg[e.entity_id] = {area: e.area_id || dev[e.device_id] || null, skip: !!(e.hidden_by || e.entity_category || e.disabled_by)}; });
  S.states = {}; states.forEach(s => { S.states[s.entity_id] = s; });
  await ha.subscribe({type: 'subscribe_events', event_type: 'state_changed'}, ev => {
    const d = ev.data;
    if (d.new_state) S.states[d.entity_id] = d.new_state; else delete S.states[d.entity_id];
    dirty();
  });
  HP.ready = true;
  if (HP.design) show();
}

/** Put a design on screen. Called at start, when the server says it changed, and by the Studio while editing. */
HP.setDesign = (d, page) => {
  HP.design = d;
  applyTheme(d.theme || {});
  const keepPage = page || (HP.stack.length && d.pages.some(p => p.id === HP.stack[0].page) ? HP.stack[0].page : null);
  HP.stack = [{page: keepPage || HP.startPage || d.start || d.pages[0].id}];
  splash();
  show();  // without Home Assistant yet, tiles draw in their offline state rather than leaving the screen blank
};

function connectHA(url, token) {
  HP.ha = new HA(url, token);
  HP.ha.onstate = s => { if (s === 'online') $('bar').textContent = ''; else toast((HP.server ? 'HomePanel Studio: ' : 'Home Assistant: ') + s); console.log('HA ' + s); };
  HP.ha.onready = () => loadAll().catch(e => toast('load failed: ' + e.message));
  HP.ha.connect();
}

/** Normal mode: everything comes from HomePanel Studio (the HA add-on). */
async function serverMode(server, cfg) {
  HP.server = server; keep.set('server', server);
  const auth = () => ({headers: {Authorization: 'Bearer ' + HP.key}});
  const pull = async () => {
    const r = await fetch(server + '/api/design' + (cfg.design ? '?design=' + encodeURIComponent(cfg.design) : ''), auth());
    if (r.status === 401) { keep.set('key', null); location.reload(); return; }  // approval was withdrawn: start over
    const j = await r.json();
    HP.startPage = j.tablet && j.tablet.start_page;
    if (!j.design) return splash('No dashboard yet', 'Choose one for "' + ((j.tablet && j.tablet.name) || 'this tablet') + '" in HomePanel Studio.');
    keep.set('design', j.design);
    HP.setDesign(j.design);
  };

  HP.key = cfg.key || null;
  while (!HP.key) {  // say hello until someone approves this tablet in the Studio
    try {
      const dev = Object.assign({width: innerWidth, height: innerHeight, scale: devicePixelRatio}, HP.device);
      const r = await (await fetch(server + '/api/hello', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(dev)})).json();
      if (r.status === 'approved') HP.key = r.key;
      else splash('Waiting for approval', 'Open HomePanel Studio in Home Assistant and approve "' + r.name + '".');
    } catch (e) {
      if (keep.get('key')) HP.key = keep.get('key');  // server away: carry on with what we had
      else splash('Looking for HomePanel Studio', server);
    }
    if (!HP.key) await sleep(4000);
  }
  keep.set('key', HP.key);

  if (keep.get('design') && !cfg.preview) HP.setDesign(keep.get('design'));  // last known design at once, fresh one right after
  connectHA(server, HP.key);
  pull().catch(e => { if (!HP.design) splash('Cannot reach HomePanel Studio', e.message); });

  if (cfg.preview) {  // the Studio sends unsaved edits straight in
    window.addEventListener('message', ev => { const m = ev.data || {}; if (m.type === 'hp-design') HP.setDesign(m.design, m.page); });
    if (window.parent !== window) window.parent.postMessage({type: 'hp-ready'}, '*');
    return;
  }
  (function listen() {  // the server says when this tablet's design changed
    const ws = new WebSocket(server.replace(/^http/, 'ws') + '/api/events?key=' + encodeURIComponent(HP.key));
    ws.onopen = ws.onmessage = () => pull().catch(() => {});  // on connect too: catches changes made while the server was away
    ws.onclose = () => setTimeout(listen, 5000);
  })();
}

native('ping').then(async m => {
  const cfg = m.config || {};
  HP.device = m.device || {};
  S.areas = keep.get('areas') || {};
  setInterval(dirty, 20000);  // keeps clocks current
  let server = cfg.server;
  if (!server) {
    try { const s = ((await native('discover', {}, 6000)).servers || [])[0]; if (s) server = 'http://' + s.host + ':' + s.port; } catch (e) { console.log('discover: ' + e.message); }
  }
  server = server || keep.get('server');
  if (server) return serverMode(server.replace(/\/$/, ''), cfg);

  // No server known: draw the design bundled with the app and talk to Home Assistant directly.
  if (!window.HP_DESIGN) return splash('Looking for HomePanel Studio', 'No server found on the network yet.');
  if (!cfg.ha_url || !cfg.ha_token) return splash('Not set up', 'No HomePanel Studio found and no Home Assistant address in config.json.');
  HP.startPage = cfg.start_page;
  HP.setDesign(window.HP_DESIGN);
  connectHA(cfg.ha_url, cfg.ha_token);
}).catch(e => splash('Cannot start', e.message));
