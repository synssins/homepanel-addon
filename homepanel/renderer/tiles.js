'use strict';
// Built-in tile types. A tile type is a plugin: HP.tile(name, {create, update, tap}).
//   create(t, body, ctx, inst) -> optional data object (may carry destroy())   builds the DOM once
//   update(t, body, ctx, inst)                                                patches it on state changes
//   tap(t, ctx, inst) -> function to run, or null                             what a touch does
// "t" is the tile's entry from the design file; inst.el is the tile element (add class "on" for the lit look).
(() => {
  const U = HP.util, st = U.st;

  HP.tile('label', {
    create(t, body) { body.innerHTML = `<div class="big" style="font-size:${(t.size || 0.5) * 100}%;text-align:${t.align || 'left'}">${U.esc(t.text || '')}</div>`; },
  });

  HP.tile('image', {create() {}});  // the picture is the tile's style.image

  HP.tile('clock', {
    create(t, body) { body.innerHTML = '<div class="time"></div><div class="date"></div>'; },
    update(t, body) {
      const now = new Date();
      U.set(body.firstChild, now.toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'}).replace(/\s?[AP]M$/i, ''));
      U.set(body.lastChild, now.toLocaleDateString([], {weekday: 'long', month: 'long', day: 'numeric'}));
    },
  });

  // shortcut: the starter icon set has three sky icons; everything that is not clear shows the cloud until the full set ships.
  const SKY = {sunny: 'weather-sunny', 'clear-night': 'weather-night'};
  HP.tile('weather', {
    create(t, body, ctx, i) { i.p = U.card(body, 'weather-cloudy'); },
    update(t, body, ctx, i) {
      const w = st(t.entity); if (!w) return;
      const ic = U.icon(SKY[w.state] || 'weather-cloudy'); if (i.p.ic.innerHTML !== ic) i.p.ic.innerHTML = ic;
      U.set(i.p.n, Math.round(w.attributes.temperature) + '°');
      U.set(i.p.l, ({partlycloudy: 'Partly cloudy', 'clear-night': 'Clear'})[w.state] || U.cap(w.state));
    },
  });

  HP.tile('people', {
    create(t, body, ctx, i) { i.p = U.card(body, t.icon || 'account-multiple'); },
    update(t, body, ctx, i) {
      const ps = (t.entities || []).filter(st), first = p => U.fname(p).split(' ')[0];
      const home = ps.filter(p => st(p).state === 'home'), away = ps.filter(p => st(p).state !== 'home');
      U.set(i.p.n, home.length === ps.length ? 'Everyone home' : home.length ? home.map(first).join(', ') + ' home' : 'Nobody home');
      U.set(i.p.l, away.map(p => first(p) + ': ' + (st(p).state === 'not_home' ? 'away' : st(p).state)).join(', '));
    },
  });

  // Shows only when something is wrong; hidden otherwise.
  HP.tile('alerts', {
    create(t, body, ctx, i) { i.p = U.card(body, 'alert'); i.el.classList.add('warn'); },
    update(t, body, ctx, i) {
      const bad = (t.alerts || []).filter(a => st(a.entity) && st(a.entity).state === a.bad).map(a => a.text);
      const off = Object.keys(t.offline || {}).filter(e => !U.avail(e)).map(e => t.offline[e]);
      const hide = !bad.length && !off.length;
      if (i.el.hidden !== hide) { i.el.hidden = hide; ctx.relayout(); }
      i.el.classList.toggle('alert', bad.length > 0);
      U.set(i.p.n, bad.length ? bad.join(' · ') : 'Offline');
      U.set(i.p.l, off.length ? (bad.length ? 'Offline: ' : '') + off.join(', ') : '');
    },
  });

  HP.tile('entity', {
    create(t, body, ctx, i) { i.p = U.card(body, t.icon || 'lightbulb'); },
    update(t, body, ctx, i) {
      U.set(i.p.n, t.name || U.fname(t.entity)); U.set(i.p.l, U.stateLabel(t.entity));
      i.el.classList.toggle('on', U.active(t.entity)); i.el.classList.toggle('off', !U.avail(t.entity));
    },
    tap: (t, ctx) => U.avail(t.entity) ? () => ctx.service('homeassistant', 'toggle', t.entity) : null,
  });

  HP.tile('action', {
    create(t, body, ctx, i) { i.p = U.card(body, t.icon || 'star'); U.set(i.p.n, t.name || ''); U.set(i.p.l, t.label || ''); },
    tap: (t, ctx) => () => { const [d, s] = t.service.split('.'); ctx.service(d, s, t.entity, t.data); },
  });

  HP.tile('nav', {
    create(t, body, ctx, i) { i.p = U.card(body, t.icon || 'home'); U.set(i.p.n, t.name || ''); U.set(i.p.l, t.label || ''); },
    tap: (t, ctx) => () => t.back ? ctx.back() : ctx.go(t.page),
  });

  HP.tile('room', {
    create(t, body, ctx, i) { i.p = U.card(body, t.icon || 'home'); },
    update(t, body, ctx, i) {
      const ls = U.inArea(t.area, 'light'), on = ls.filter(e => st(e).state === 'on').length;
      const temp = U.inArea(t.area, 'sensor').filter(e => st(e).attributes.device_class === 'temperature').map(e => parseFloat(st(e).state)).find(v => !isNaN(v));
      U.set(i.p.n, t.name || HP.S.areas[t.area] || t.area);
      U.set(i.p.l, [ls.length ? (on ? on + ' on' : 'Lights off') : '', temp == null ? '' : Math.round(temp) + '°'].filter(Boolean).join(' · '));
      i.el.classList.toggle('on', on > 0);
    },
    tap: (t, ctx) => () => ctx.go('@room', t.area),
  });

  HP.tile('media', {
    create(t, body, ctx, i) { i.p = U.card(body, 'play'); },
    update(t, body, ctx, i) {
      const s = st(t.entity); if (!s) return;
      const a = s.attributes, playing = s.state === 'playing', ic = U.icon(playing ? 'pause' : 'play');
      if (i.p.ic.innerHTML !== ic) i.p.ic.innerHTML = ic;
      U.set(i.p.n, a.media_title || t.name || a.friendly_name); U.set(i.p.l, a.media_artist || a.app_name || U.cap(s.state));
      i.el.classList.toggle('on', playing);
    },
    tap: (t, ctx) => () => ctx.service('media_player', 'media_play_pause', t.entity),
  });

  // Still picture at once, live video takes over where the tablet can decode it. Tap opens the camera's page.
  HP.tile('camera', {
    create(t, body) {
      const s = st(t.entity);
      body.classList.add('cam');
      const img = document.createElement('img'), video = document.createElement('video'), label = document.createElement('div');
      video.muted = true; video.autoplay = true; video.playsInline = true; video.setAttribute('playsinline', '');
      label.className = 'camlabel';
      const name = t.name || (s ? U.fname(t.entity).replace(/ High resolution channel$/i, '') : t.entity);
      const status = x => { label.textContent = x ? name + ' · ' + x : name; body.classList.toggle('live', !x); };
      body.append(img, video, label);
      if (!s || s.state === 'unavailable') { status('offline'); return null; }
      const stops = [snapshots(HP.ha, s, img, body)];
      if (t.video === false || !(s.attributes.supported_features & 2)) status('stills'); else { status('connecting'); stops.push(playCamera(HP.ha, t.entity, video, status)); }
      return {destroy: () => stops.forEach(f => f())};
    },
    tap: (t, ctx) => t.page ? () => ctx.go(t.page) : null,
  });
})();
