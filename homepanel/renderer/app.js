'use strict';

// ---------- native bridge ----------
const pending = {}; let seq = 0;
function native(cmd, extra, ms) {
  if (!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.native)) {
    // Not inside the tablet app: this is the Studio's preview pane. Its settings come from the page address.
    if (cmd !== 'ping') return Promise.reject(new Error('no native bridge'));
    const q = new URLSearchParams(location.search);
    return Promise.resolve({config: {server: new URL('..', location.href).href.replace(/\/$/, ''), key: q.get('key'), design: q.get('design'), preview: true},
      device: {id: 'preview'}});
  }
  return new Promise((res, rej) => {
    const id = ++seq; pending[id] = res;
    try { window.webkit.messageHandlers.native.postMessage(Object.assign({id, cmd}, extra)); }
    catch (e) { delete pending[id]; rej(e); }
    setTimeout(() => { if (pending[id]) { delete pending[id]; rej(new Error('native: no reply')); } }, ms || 3000);
  });
}
window.nativeReply = m => { const f = pending[m.id]; if (f) { delete pending[m.id]; f(m); } };

// ---------- Home Assistant websocket ----------
class HA {
  constructor(url, token) {
    this.url = url.replace(/^http/, 'ws') + '/api/websocket';
    this.token = token; this.id = 0; this.waits = {}; this.subs = {};
    this.onstate = () => {}; this.onready = () => {};
  }
  connect() {
    this.onstate('connecting');
    const ws = this.ws = new WebSocket(this.url);
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.type === 'auth_required') ws.send(JSON.stringify({type: 'auth', access_token: this.token}));
      else if (m.type === 'auth_ok') { this.onstate('online'); this.onready(); }
      else if (m.type === 'auth_invalid') { this.token = null; this.onstate('token rejected'); }
      else if (m.type === 'result') {
        const w = this.waits[m.id]; delete this.waits[m.id];
        if (w) m.success ? w.res(m.result) : w.rej(new Error((m.error && m.error.message) || 'HA error'));
      } else if (m.type === 'event' && this.subs[m.id]) this.subs[m.id](m.event);
    };
    // Panel must heal by itself: HA restarts, WiFi drops. Retry forever unless the token is bad.
    ws.onclose = () => {
      for (const k in this.waits) this.waits[k].rej(new Error('HA socket closed'));
      this.waits = {}; this.subs = {};
      if (this.token) { this.onstate('offline, retrying'); setTimeout(() => this.connect(), 5000); }
    };
  }
  call(msg) {
    return new Promise((res, rej) => {
      const id = ++this.id; this.waits[id] = {res, rej};
      this.ws.send(JSON.stringify(Object.assign({id}, msg)));
    });
  }
  /** Like call(), but keeps delivering events for that id to onEvent. */
  subscribe(msg, onEvent) {
    const id = this.id + 1; this.subs[id] = onEvent;
    return this.call(msg).then(() => id, e => { delete this.subs[id]; throw e; });
  }
}

// ---------- live camera over HA's WebRTC signalling (HA hands the stream to its go2rtc) ----------
function playCamera(ha, entity, video, status) {
  let pc, closed = false;
  const startHLS = async () => {
    status('starting video');
    const hls = await ha.call({type: 'camera/stream', entity_id: entity});
    if (closed) return;
    video.srcObject = null;
    video.src = ha.url.replace(/^ws/, 'http').replace(/\/api\/websocket$/, '') + hls.url;
    video.onplaying = () => status('');
    // Seen on Air 2: H.265 level 4.0 (~0.4 Mbit/s) plays, level 5.0 (~4 Mbit/s) fails with MEDIA_ERR_DECODE (3).
    video.onerror = () => status('stills, video too heavy (error ' + (video.error && video.error.code) + ')');
    video.play().catch(() => {});
  };
  // shortcut: a camera that once needed HLS stays on HLS; clear localStorage if it is later switched to H.264.
  const hlsKey = 'hls:' + entity;
  let knownHLS = false; try { knownHLS = !!localStorage.getItem(hlsKey); } catch (e) {}
  (async () => {
    if (knownHLS) return startHLS();
    const cfg = await ha.call({type: 'camera/webrtc/get_client_config', entity_id: entity}).catch(() => ({}));
    if (closed) return;
    pc = new RTCPeerConnection(cfg.configuration || {});
    pc.addTransceiver('video', {direction: 'recvonly'});
    pc.addTransceiver('audio', {direction: 'recvonly'});
    if (cfg.dataChannel) pc.createDataChannel(cfg.dataChannel);
    const stream = new MediaStream(); video.srcObject = stream;
    pc.ontrack = e => { stream.addTrack(e.track); video.play().catch(() => {}); };
    pc.onconnectionstatechange = () => status(pc.connectionState === 'connected' ? '' : pc.connectionState);
    // "connected" only means the network path is up. Say so when no picture is being decoded, and why.
    const watch = setInterval(async () => {
      if (closed) return clearInterval(watch);
      if (pc.connectionState !== 'connected') return;
      let rtp = null; const codecs = {};
      (await pc.getStats()).forEach(r => {
        if (r.type === 'inbound-rtp' && (r.kind === 'video' || r.mediaType === 'video')) rtp = r;
        if (r.type === 'codec') codecs[r.id] = r.mimeType;
      });
      const frames = rtp ? rtp.framesDecoded || 0 : 0;
      const info = rtp ? (codecs[rtp.codecId] || 'no codec') + ', ' + (rtp.packetsReceived || 0) + ' packets, ' + frames + ' frames' : 'no video track';
      console.log('stats ' + entity + ': ' + info + ', video ' + video.videoWidth + 'x' + video.videoHeight + ' paused=' + video.paused);
      if (frames > 0) return status('');
      // WebRTC here only decodes H.264. An H.265 camera connects but sends nothing: fall back to HLS,
      // which this web view plays natively (slower to start, several seconds behind live).
      if (++blank < 2) return status('starting video');
      clearInterval(watch); pc.close();
      try { localStorage.setItem(hlsKey, '1'); } catch (e) {}
      startHLS().catch(e => status(e.message));
    }, 4000);
    let blank = 0;

    let session = null; const queued = [];
    const sendCand = c => ha.call({type: 'camera/webrtc/candidate', entity_id: entity, session_id: session, candidate: c}).catch(() => {});
    pc.onicecandidate = e => {
      if (!e.candidate) return;
      const c = {candidate: e.candidate.candidate, sdpMid: e.candidate.sdpMid, sdpMLineIndex: e.candidate.sdpMLineIndex};
      session ? sendCand(c) : queued.push(c);
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    status('negotiating');
    await ha.subscribe({type: 'camera/webrtc/offer', entity_id: entity, offer: offer.sdp}, ev => {
      if (closed) return;
      if (ev.type === 'session') { session = ev.session_id; queued.splice(0).forEach(sendCand); }
      else if (ev.type === 'answer') pc.setRemoteDescription({type: 'answer', sdp: ev.answer}).catch(e => status(String(e)));
      else if (ev.type === 'candidate') {
        const c = typeof ev.candidate === 'string' ? {candidate: ev.candidate, sdpMid: '0'} : ev.candidate;
        pc.addIceCandidate(c).catch(() => {});
      } else if (ev.type === 'error') status(ev.message || ev.code || 'stream error');
    });
  })().catch(e => { console.error('camera ' + entity + ': ' + e.message); status(e.message); });
  return () => { closed = true; if (pc) pc.close(); video.srcObject = null; video.removeAttribute('src'); video.load(); };
}

// ---------- still pictures ----------
/** Refresh a still image about once a second while the tile has no live video. Instant picture at start-up. */
function snapshots(ha, s, img, tile) {
  const base = ha.url.replace(/^ws/, 'http').replace(/\/api\/websocket$/, '');
  let pic = s.attributes.entity_picture, busy = false, stopped = false;
  const next = () => {
    if (stopped || busy || !pic || tile.classList.contains('live')) return;
    busy = true; img.src = base + pic + '&t=' + Date.now();
  };
  img.onload = () => { busy = false; };
  // The picture URL carries a token HA rotates every few minutes: fetch the current one when it stops working.
  img.onerror = () => {
    ha.call({type: 'get_states'}).then(st => {
      const cur = st.find(x => x.entity_id === s.entity_id);
      if (cur) pic = cur.attributes.entity_picture;
    }).catch(() => {}).then(() => { busy = false; });
  };
  next();
  const timer = setInterval(next, 1000);
  return () => { stopped = true; clearInterval(timer); };
}
