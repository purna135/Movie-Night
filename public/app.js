(() => {
  'use strict';

  // ---------- Helpers ----------
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const store = {
    get(k, d) { try { const v = localStorage.getItem('mn:' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('mn:' + k, JSON.stringify(v)); } catch {} },
  };
  const fmt = (s) => {
    if (!Number.isFinite(s) || s < 0) s = 0;
    s = Math.floor(s);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
  };
  const fmtSize = (b) => (b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const initial = (n) => (n || '?').trim().charAt(0).toUpperCase();
  const isTouch = matchMedia('(hover: none)').matches;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const svg = (id) => `<svg><use href="#${id}"/></svg>`;
  const setIcon = (btn, id) => { const u = btn.querySelector('use'); if (u) u.setAttribute('href', '#' + id); };

  const el = {
    join: $('#join'), joinForm: $('#joinForm'), nameInput: $('#nameInput'), codeInput: $('#codeInput'), codeField: $('#codeField'),
    joinBtn: $('#joinBtn'), joinErr: $('#joinErr'), codeNote: $('#codeNote'),
    app: $('#app'), nowTitle: $('#nowTitle'), net: $('#net'), netText: $('#netText'),
    voiceJoin: $('#voiceJoin'), voiceOn: $('#voiceOn'), micBtn: $('#micBtn'), voiceLeave: $('#voiceLeave'),
    player: $('#player'), video: $('#video'), reactions: $('#reactions'), ticker: $('#ticker'),
    centerMsg: $('#centerMsg'), centerText: $('#centerText'), tapSync: $('#tapSync'), empty: $('#emptyState'),
    cTitle: $('#cTitle'), cMic: $('#cMic'), cChat: $('#cChat'), cChatBadge: $('#cChatBadge'),
    playBtn: $('#playBtn'), back10: $('#back10'), fwd10: $('#fwd10'),
    seekWrap: $('#seekWrap'), seek: $('#seek'), seekFill: $('#seekFill'), seekBuf: $('#seekBuf'), seekTip: $('#seekTip'),
    curTime: $('#curTime'), durTime: $('#durTime'), muteBtn: $('#muteBtn'), volume: $('#volume'),
    reactBtn: $('#reactBtn'), reactStrip: $('#reactStrip'), ccBtn: $('#ccBtn'), qualityBtn: $('#qualityBtn'), qualityLabel: $('#qualityLabel'),
    fsBtn: $('#fsBtn'), menu: $('#menu'), toast: $('#toast'), subs: $('#subs'),
    panelClose: $('#panelClose'), chatBadge: $('#chatBadge'), peopleCount: $('#peopleCount'),
    messages: $('#messages'), typing: $('#typing'), people: $('#people'), movies: $('#movies'), moviesCount: $('#moviesCount'),
    refreshMovies: $('#refreshMovies'), composer: $('#composer'), msgInput: $('#msgInput'), sendBtn: $('#sendBtn'), kbFloat: $('#kbFloat'), kbReacts: $('#kbReacts'), quickReacts: $('#quickReacts'),
    modal: $('#modal'), modalTitle: $('#modalTitle'), modalText: $('#modalText'), modalOk: $('#modalOk'), modalCancel: $('#modalCancel'),
    audioSink: $('#audioSink'), earMode: $('#earMode'),
  };
  const video = el.video;
  const REACTS = ['😂', '😮', '😍', '🔥', '👏', '😭', '💀', '🍿'];

  // Per-tab identity: survives refreshes/reconnects, but two tabs = two viewers.
  function newClientId() {
    const id = (crypto.randomUUID && crypto.randomUUID()) || Math.random().toString(36).slice(2) + Date.now().toString(36);
    try { sessionStorage.setItem('mn:cid', id); } catch {}
    return id;
  }
  let clientId = null;
  try { clientId = sessionStorage.getItem('mn:cid'); } catch {}
  if (!clientId) clientId = newClientId();

  // ---------- App state ----------
  let session = null, socket = null, me = null, myName = '', linkHadCode = false, joined = false;
  // Connected *and* welcomed. Socket.IO replays anything emitted while offline *before* our 'join'
  // reaches the server, which then ignores it — so actions are only sent while live().
  const live = () => !!socket?.connected && joined;
  const OFFLINE = 'Reconnecting… try again in a moment';
  let users = [], movies = [], state = null, current = null, hls = null, sourceKind = null;
  let clockOffset = 0, bestRtt = Infinity, latency = 0;
  let waitMode = false, waitingNames = [];
  let pendingSeek = null, ignoreUntil = 0, hiddenAt = 0, dragging = false;
  let activeTab = 'chat', unread = 0, lastMsg = { uid: null, ts: 0 };
  let userVolume = store.get('volume', 1), ducked = false, duckTimer = null;

  const serverNow = () => Date.now() + clockOffset;
  const expected = () => {
    if (!state) return 0;
    return state.playing ? state.time + Math.max(0, serverNow() - state.serverNow) / 1000 : state.time;
  };
  const duration = () => (Number.isFinite(video.duration) && video.duration > 0 ? video.duration : current?.duration || 0);
  const isLoading = () => !!current && !video.error && (video.seeking || video.readyState < 3);
  const immersive = () => el.app.classList.contains('immersive');

  // ---------- Join ----------
  async function boot() {
    const params = new URLSearchParams(location.search);
    if (params.get('code')) {
      // Shared link has the passcode built in: fill it, hide the field, just ask for a name.
      el.codeInput.value = params.get('code');
      try { sessionStorage.setItem('mn:code', params.get('code')); } catch {}
      linkHadCode = true;
      hideCodeField();
      el.joinErr.textContent = '';
      el.codeNote.hidden = false;
      history.replaceState(null, '', location.pathname); // keep the passcode out of the address bar/history
    }
    el.nameInput.value = store.get('name', '');
    try {
      const r = await fetch('/api/session', { credentials: 'same-origin' });
      const s = r.ok ? await r.json() : null;
      if (s && s.token) {
        session = s;
        hideCodeField();
        if (el.nameInput.value) el.joinBtn.querySelector('span').textContent = 'Rejoin the room';
      }
    } catch {}
    (el.nameInput.value ? (el.codeField.hidden ? el.joinBtn : el.codeInput) : el.nameInput).focus({ preventScroll: true });
  }

  function hideCodeField() {
    el.codeField.hidden = true;
    el.codeInput.required = false;
  }

  el.joinForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    el.joinErr.textContent = '';
    myName = el.nameInput.value.trim().slice(0, 24);
    if (!myName) return el.nameInput.focus();
    store.set('name', myName);
    // Unlock media playback on iOS/Android while we still have the user's tap.
    video.play().catch(() => {});
    el.joinBtn.disabled = true;
    try {
      if (!session) {
        const r = await fetch('/api/join', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: el.codeInput.value.trim() }),
        });
        const data = await r.json().catch(() => ({}));
        if (r.status === 401 && linkHadCode) {
          // Old link (server restarted with a new passcode): show the field so they can type it.
          linkHadCode = false;
          el.codeNote.hidden = true;
          el.codeField.hidden = false;
          el.codeInput.required = true;
          el.codeInput.value = '';
          el.codeInput.focus();
          throw new Error('This link has an old passcode — ask for the new link, or type the passcode.');
        }
        if (!r.ok) throw new Error(data.error || 'Could not join');
        session = data;
      }
      connect();
    } catch (err) {
      el.joinErr.textContent = err.message === 'Failed to fetch' ? 'Can’t reach the host. Is the server running?' : err.message;
      el.joinBtn.disabled = false;
    }
  });

  function showApp() {
    el.join.hidden = true;
    el.app.hidden = false;
    el.joinBtn.disabled = false;
    updateImmersive();
  }

  function backToJoin(msg) {
    session = null;
    joined = false;
    socket?.disconnect();
    socket = null;
    teardownVoice();
    // Stop the movie (it would keep playing behind the join screen) and forget the old room.
    unload();
    current = null;
    state = null;
    me = null;
    el.app.hidden = true;
    el.join.hidden = false;
    // Came in through a share link? Try its passcode again (it still works if PASSCODE is fixed in .env);
    // if it's outdated, the join handler reveals the passcode field.
    let saved = null;
    try { saved = sessionStorage.getItem('mn:code'); } catch {}
    linkHadCode = !!saved;
    el.codeInput.value = saved || '';
    el.codeNote.hidden = !saved;
    if (saved) hideCodeField(); else { el.codeField.hidden = false; el.codeInput.required = true; }
    el.joinBtn.disabled = false;
    el.joinBtn.querySelector('span').textContent = 'Join the room';
    el.joinErr.textContent = msg || '';
  }

  // ---------- Socket ----------
  function connect() {
    if (socket) socket.disconnect();
    socket = io({ auth: { token: session.token }, transports: ['websocket', 'polling'], reconnectionDelay: 800, reconnectionDelayMax: 4000 });

    socket.on('connect', () => {
      bestRtt = Infinity;
      socket.emit('join', { name: myName, clientId });
      syncClock(5);
      updateNet();
    });
    socket.on('disconnect', (reason) => {
      joined = false;
      updateNet();
      // The server only drops a connection itself when another tab took over this tab's identity
      // (e.g. Chrome's "Duplicate tab" copies it). Become a separate viewer and reconnect.
      if (reason === 'io server disconnect') {
        clientId = newClientId();
        socket.connect();
      }
    });
    socket.on('connect_error', (err) => {
      if (err.message === 'unauthorized') backToJoin('The room was restarted — enter the new passcode.');
      updateNet();
    });

    socket.on('welcome', ({ me: m, movies: list, state: s, history: past }) => {
      me = m;
      joined = true;
      lastStatus = ''; // this connection starts from scratch on the server: re-send our status
      lastMsg = { uid: null, ts: 0 };
      el.messages.innerHTML = '';
      past.forEach((msg) => addMessage(msg, true));
      showApp();
      // A reconnect (flaky network) keeps the loaded video and its buffer; only a changed source reloads.
      onMovies(list, true);
      scrollChat(true);
      handleState(s, true);
      if (voice.active) rejoinVoice();
    });
    socket.on('users', (list) => { users = list; renderPeople(); });
    socket.on('movies', (list) => onMovies(list));
    socket.on('state', (s) => handleState(s));
    socket.on('sync', (s) => handleSync(s));
    socket.on('waiting', (names) => { waitingNames = names; updateCenter(); });
    socket.on('chat', (m) => addMessage(m));
    socket.on('typing', ({ name }) => showTyping(name));
    socket.on('react', (r) => floatEmoji(r));
    socket.on('voice-peers', (ids) => ids.forEach((id) => callPeer(id)));
    socket.on('voice-left', (id) => { closePeer(id); dropRelay(id); renderPeople(); });
    socket.on('vr', ({ from, d }) => {
      if (!voice.active) return;
      if (!relay.peers.has(from)) goRelay(from, false); // friend is sending through the server
      playRelay(from, d);
    });
    socket.on('signal', ({ from, data }) => onSignal(from, data));
  }

  function syncClock(n = 1) {
    let i = 0;
    const ping = () => {
      if (!socket?.connected) return;
      const t0 = Date.now();
      socket.timeout(5000).emit('clock', t0, (err, sNow) => {
        if (err) return;
        const rtt = Date.now() - t0;
        latency = rtt;
        if (rtt <= bestRtt * 1.5) {
          bestRtt = Math.min(bestRtt, rtt);
          clockOffset = sNow + rtt / 2 - Date.now();
        }
        updateNet();
        if (++i < n) setTimeout(ping, 250);
      });
    };
    ping();
  }
  setInterval(() => syncClock(1), 15000);

  function updateNet() {
    const n = el.net;
    n.classList.remove('warn', 'bad');
    if (!socket?.connected || !navigator.onLine) {
      n.classList.add('bad');
      el.netText.textContent = navigator.onLine ? 'Reconnecting…' : 'Offline';
      n.title = 'Connection lost — retrying automatically';
      return;
    }
    const bw = hls?.bandwidthEstimate;
    const slow = latency > 500 || (bw && bw < 700_000);
    if (slow) n.classList.add('warn');
    const parts = [slow ? 'Slow' : 'Live'];
    if (bw && Number.isFinite(bw)) parts.push(`${(bw / 1e6).toFixed(1)} Mbps`);
    el.netText.textContent = parts.join(' · ');
    n.title = `Latency ${latency} ms${bw ? ` · bandwidth ≈ ${(bw / 1e6).toFixed(1)} Mbps` : ''}`;
  }
  setInterval(updateNet, 2500);
  addEventListener('online', updateNet);
  addEventListener('offline', updateNet);

  // ---------- Playback sync ----------
  const ACTION_TEXT = {
    play: (n) => `▶  ${n} pressed play`,
    pause: (n) => `⏸  ${n} paused`,
    seek: (n, t) => `⏩  ${n} jumped to ${fmt(t)}`,
    select: (n) => `🎬  ${n} changed the movie`,
  };

  function handleState(s, quiet = false) {
    state = s;
    if (s.action === 'wait') { waitMode = true; waitingNames = s.waitingFor || []; }
    else if (s.action || quiet) waitMode = false;

    if (current?.id !== s.movie) selectCurrent(s.movie);
    else applyState();

    if (!quiet) {
      if (s.action && s.byId && s.byId !== me?.id && ACTION_TEXT[s.action]) toast(ACTION_TEXT[s.action](s.by, s.time));
      if (s.action === 'wait') toast(`⏳  Waiting for ${waitingNames.join(', ')} to catch up`);
      if (s.action === 'resume') {
        const gaveUp = (s.gaveUp || []).filter((n) => n !== myName);
        toast(gaveUp.length ? `▶  Continuing — ${gaveUp.join(', ')} will catch up` : '▶  Everyone caught up');
      }
    }
    updateCenter();
  }

  function handleSync(s) {
    if (!state || s.movie !== state.movie) return;
    state = { ...state, ...s };
    if (!state.playing || video.paused || video.seeking || video.readyState < 3) return;
    const drift = video.currentTime - expected();
    if (Math.abs(drift) > 2.5) {
      video.playbackRate = 1;
      seekTo(expected());
    } else if (Math.abs(drift) > 0.4) {
      video.playbackRate = drift > 0 ? 0.94 : 1.06; // glide back into sync without a jump
    } else {
      video.playbackRate = 1;
    }
  }

  function applyState() {
    if (!state || !current || video.readyState < 1) return;
    const target = clamp(expected(), 0, Math.max(0, duration() - 0.5) || Infinity);
    const drift = video.currentTime - target;
    if (Math.abs(drift) > (state.playing ? 1.2 : 0.3)) seekTo(target);
    if (state.playing) {
      if (video.paused) tryPlay();
    } else {
      video.playbackRate = 1;
      if (!video.paused) video.pause();
    }
    updatePlayIcon();
    updateCenter();
  }

  function seekTo(t) {
    pendingSeek = t;
    video.currentTime = t;
  }

  function tryPlay() {
    const p = video.play();
    if (p && p.then) {
      p.then(() => { el.tapSync.hidden = true; updateCenter(); })
        .catch((err) => { if (err.name === 'NotAllowedError') { el.tapSync.hidden = false; updateCenter(); } });
    }
  }

  function sendControl(action, t = video.currentTime) {
    if (!state || !socket) return;
    // Offline: Socket.IO would queue this and replay it after reconnecting, yanking the whole room
    // back to where this viewer was. Drop it — on reconnect this phone snaps to the room instead.
    if (!live()) { toast(OFFLINE); return; }
    const now = serverNow();
    if (action === 'play') state = { ...state, playing: true, time: t, serverNow: now };
    else if (action === 'pause') state = { ...state, playing: false, time: t, serverNow: now };
    else if (action === 'seek') state = { ...state, time: t, serverNow: now };
    waitMode = false;
    socket.emit('control', { action, time: t });
  }

  function togglePlay() {
    if (!current || !state) return;
    if (!live()) return toast(OFFLINE);
    // Room is playing but this video isn't (autoplay blocked, stalled): "play" means join in, not pause everyone.
    if (state.playing && video.paused) {
      el.tapSync.hidden = true;
      if (Math.abs(video.currentTime - expected()) > 1.2) seekTo(expected());
      tryPlay(); showControls(); return;
    }
    if (state.playing) { sendControl('pause'); video.pause(); }
    else { sendControl('play'); tryPlay(); }
    showControls();
  }

  function skip(delta) {
    if (!current) return;
    if (!live()) return toast(OFFLINE);
    const t = clamp(video.currentTime + delta, 0, Math.max(0, duration() - 1));
    sendControl('seek', t);
    seekTo(t);
    showControls();
  }

  // Native events (also fired by iOS/Android system controls) -> tell the room,
  // but only when they disagree with the shared state, so nothing echoes.
  video.addEventListener('play', () => {
    updatePlayIcon();
    if (Date.now() < ignoreUntil || !state) return;
    if (!state.playing) sendControl('play');
  });
  video.addEventListener('pause', () => {
    updatePlayIcon();
    keepAwake(false);
    if (Date.now() < ignoreUntil || !state || video.ended) return;
    if (document.hidden || Date.now() - hiddenAt < 1500) return; // phone went to background
    if (state.playing) sendControl('pause');
  });
  video.addEventListener('seeked', () => {
    if (pendingSeek !== null && Math.abs(video.currentTime - pendingSeek) < 1.5) { pendingSeek = null; return; }
    pendingSeek = null;
    if (Date.now() < ignoreUntil || !state) return;
    if (Math.abs(video.currentTime - expected()) > 3) sendControl('seek');
  });
  video.addEventListener('loadedmetadata', () => { applySubtitlePref(); applyState(); updateTime(); });
  video.addEventListener('canplay', () => { if (state?.playing && video.paused) applyState(); updateCenter(); reportStatus(); });
  video.addEventListener('playing', () => { el.tapSync.hidden = true; keepAwake(true); updateCenter(); reportStatus(); });
  video.addEventListener('waiting', () => { updateCenter(); reportStatus(); });
  video.addEventListener('seeking', updateCenter);
  video.addEventListener('timeupdate', updateTime);
  video.addEventListener('progress', updateBuffered);
  video.addEventListener('durationchange', updateTime);
  video.addEventListener('ended', () => { if (state?.playing) sendControl('pause'); });
  video.addEventListener('error', () => {
    if (!current || !video.error) return;
    // Picked "Original" but this phone can't decode the file (e.g. HEVC/10-bit/MKV) → back to adaptive.
    if (sourceKind === 'direct' && current.hls) {
      store.set('quality', 'auto');
      toast('This device can’t play the original file — switched to Auto');
      loadMovie(current);
      return;
    }
    const fixable = sourceKind === 'direct';
    el.centerMsg.hidden = false;
    el.centerMsg.querySelector('.spinner').hidden = true;
    el.centerText.innerHTML = fixable
      ? 'This browser can’t play this file’s format.<br>On the host PC run <b>npm run optimize</b>, then refresh Movies.'
      : 'Playback error. Retrying…';
    const failed = current;
    if (!fixable) setTimeout(() => { if (current === failed) loadMovie(current); }, 2000);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    // Back from background: snap to the room.
    if (state?.playing) applyState();
    if (!video.paused) keepAwake(true);
    updateUnread();
  });

  // Status for "wait for everyone"
  let lastStatus = '';
  function reportStatus() {
    if (!live() || !current) return;
    const loading = isLoading() && !document.hidden && el.tapSync.hidden;
    const status = (state?.playing || waitMode) && loading ? 'buffering' : video.paused ? 'paused' : 'playing';
    const quality = qualityText();
    const key = status + quality;
    if (key === lastStatus) return;
    lastStatus = key;
    // While a source is (re)loading, currentTime is 0 — report where the room is instead, so the
    // server never pauses everyone at 0:00 because of this viewer.
    const time = video.readyState < 1 ? expected() : video.currentTime;
    socket.emit('status', { status, time, quality });
  }
  setInterval(reportStatus, 1000);

  function updateCenter() {
    let text = null;
    const loading = isLoading();
    if (waitMode && waitingNames.length) {
      text = waitingNames.includes(myName) && loading ? 'Catching up — your connection is slow…' : `Waiting for ${waitingNames.join(', ')}…`;
    } else if (current && state?.playing && loading && el.tapSync.hidden) {
      text = 'Buffering…';
    } else if (current && video.readyState === 0 && !video.error) {
      text = 'Loading…';
    }
    if (video.error && current) return; // error message is showing
    el.centerMsg.querySelector('.spinner').hidden = false;
    el.centerMsg.hidden = !text;
    if (text) el.centerText.textContent = text;
  }

  el.tapSync.addEventListener('click', () => {
    el.tapSync.hidden = true;
    if (state) seekTo(expected());
    tryPlay();
  });

  // ---------- Loading movies ----------
  function mediaUrl(m) {
    return '/media/' + m.id.split('/').map(encodeURIComponent).join('/');
  }

  function selectCurrent(id) {
    const m = movies.find((x) => x.id === id) || null;
    current = m;
    el.empty.hidden = !!m;
    el.player.classList.toggle('no-movie', !m);
    el.nowTitle.innerHTML = m ? `Now playing <b>${esc(m.name)}</b>` : 'Pick a movie to start';
    el.cTitle.textContent = m ? m.name : '';
    renderMovies();
    if (!m) { unload(); updatePlayIcon(); return; }
    loadMovie(m);
  }

  function unload() {
    if (hls) { hls.destroy(); hls = null; }
    video.removeAttribute('src');
    setTracks(null);
    try { video.load(); } catch {}
    sourceKind = null;
  }

  function setTracks(m) {
    $$('track', video).forEach((t) => t.remove());
    subTrack = null;
    el.subs.hidden = true;
    for (const s of m?.subs || []) {
      const t = document.createElement('track');
      Object.assign(t, { kind: 'subtitles', label: s.label, src: s.src, srclang: 'und' });
      video.appendChild(t);
    }
    el.ccBtn.hidden = !m?.subs?.length;
  }

  // Title + play/pause/±10 s on the lock screen and in the notification shade, shared with the room.
  // (A plain "pause" event while the page is hidden is ignored — that's usually the phone backgrounding
  // the video — so lock-screen buttons get explicit handlers.)
  function updateMediaSession(m) {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.metadata = m ? new MediaMetadata({ title: m.name, artist: 'Movie Night' }) : null;
      navigator.mediaSession.setActionHandler('play', () => { if (!state?.playing || video.paused) togglePlay(); });
      navigator.mediaSession.setActionHandler('pause', () => { if (state?.playing) togglePlay(); else video.pause(); });
      navigator.mediaSession.setActionHandler('seekbackward', () => skip(-10));
      navigator.mediaSession.setActionHandler('seekforward', () => skip(10));
    } catch {}
  }

  function loadMovie(m) {
    ignoreUntil = Date.now() + 1500;
    unload();
    const original = store.get('quality', 'auto') === 'original'; // viewer picked "Original" in the quality menu
    if (m.hls && !original && window.Hls && Hls.isSupported()) {
      sourceKind = 'hls';
      hls = new Hls({
        capLevelToPlayerSize: true,      // a phone never downloads more pixels than it can show
        startLevel: -1,
        abrEwmaDefaultEstimate: 1_000_000,
        abrBandWidthFactor: 0.8,
        abrBandWidthUpFactor: 0.7,       // be cautious stepping up quality
        maxBufferLength: 30,             // ~30s cushion against dips, yet quality can climb back within ~30s
        maxMaxBufferLength: 60,
        backBufferLength: 30,
        maxBufferHole: 0.5,
        fragLoadingMaxRetry: 10,
        fragLoadingRetryDelay: 800,
        manifestLoadingMaxRetry: 6,
        levelLoadingMaxRetry: 6,
      });
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        const pref = store.get('quality', 'auto');
        const idx = hls.levels.findIndex((l) => levelName(l) === pref);
        if (pref !== 'auto' && idx >= 0) hls.currentLevel = idx;
        updateQualityLabel();
      });
      hls.on(Hls.Events.LEVEL_SWITCHED, () => { updateQualityLabel(); reportStatus(); });
      const inst = hls;
      const reloadSame = (ms) => setTimeout(() => { if (hls === inst && current?.id === m.id) loadMovie(current); }, ms);
      hls.on(Hls.Events.ERROR, (_, d) => {
        if (!d.fatal) return;
        const manifest = /manifest/i.test(d.details || '');
        if (d.type === Hls.ErrorTypes.NETWORK_ERROR && !manifest) setTimeout(() => { if (hls === inst) inst.startLoad(); }, 1500);
        else if (d.type === Hls.ErrorTypes.NETWORK_ERROR) reloadSame(3000); // startLoad() doesn't re-fetch the playlist
        else if (d.type === Hls.ErrorTypes.MEDIA_ERROR) inst.recoverMediaError();
        else { toast('Playback hiccup — reloading'); reloadSame(1000); }
      });
      hls.loadSource(m.hls);
      hls.attachMedia(video);
    } else if (m.hls && !original && video.canPlayType('application/vnd.apple.mpegurl')) {
      sourceKind = 'native-hls'; // older iPhones (hls.js covers iOS 17.1+): built-in adaptive streaming
      video.src = m.hls;
    } else {
      sourceKind = 'direct';
      video.src = mediaUrl(m);
    }
    setTracks(m);
    video.volume = ducked ? userVolume * 0.35 : userVolume;
    updateMediaSession(m);
    updateQualityLabel();
    updateTime();
    updateCenter();
  }

  // New library from the server. If the playing movie got an optimized version (or a newer build of
  // it), reload it — applyState() then puts this viewer straight back at the room's position.
  function onMovies(list, quiet = false) {
    movies = list;
    const after = current && movies.find((m) => m.id === current.id);
    if (!current && state?.movie && movies.some((m) => m.id === state.movie)) {
      selectCurrent(state.movie); // the room's movie wasn't in our list yet (just added to the folder)
    } else if (after) {
      const before = current;
      current = after;
      const onOriginal = sourceKind === 'direct' && store.get('quality', 'auto') === 'original';
      if (after.hls !== before.hls && !onOriginal) {
        if (!quiet && after.hls && !before.hls) toast('⚡  Switched to adaptive quality');
        loadMovie(after);
      } else if (JSON.stringify(after.subs) !== JSON.stringify(before.subs)) {
        setTracks(after); // e.g. an .srt was added: no need to reload the video
        applySubtitlePref();
      }
    }
    renderMovies();
  }

  // ---------- Quality / subtitles ----------
  const levelName = (l) => (l.width >= 1200 ? '720p' : l.width >= 800 ? '480p' : l.width >= 600 ? '360p' : l.width ? '240p' : `${l.height}p`);

  function qualityText() {
    if (sourceKind === 'hls' && hls && hls.levels.length) {
      const l = hls.levels[hls.currentLevel] || hls.levels[hls.loadLevel];
      return l ? levelName(l) : 'Auto';
    }
    if (sourceKind === 'native-hls') return 'Auto';
    if (sourceKind === 'direct') return 'Original';
    return '';
  }

  function updateQualityLabel() {
    const t = qualityText();
    el.qualityLabel.textContent = t || 'Auto';
    el.qualityBtn.hidden = !current;
  }

  // Subtitles are drawn by us (not the browser) so they look the same everywhere, are readable,
  // and move up out of the way when the player controls are showing.
  let subTrack = null;
  function setSubTrack(track) {
    [...video.textTracks].forEach((t) => { t.oncuechange = null; t.mode = t === track ? 'hidden' : 'disabled'; });
    subTrack = track || null;
    if (subTrack) subTrack.oncuechange = renderSubs;
    el.ccBtn.classList.toggle('on', !!subTrack);
    renderSubs();
  }
  function renderSubs() {
    const cues = subTrack && subTrack.activeCues ? [...subTrack.activeCues] : [];
    el.subs.replaceChildren(...cues.map((c) => {
      const s = document.createElement('span');
      const text = typeof c.getCueAsHTML === 'function' ? c.getCueAsHTML().textContent : String(c.text || '').replace(/<[^>]+>/g, '');
      s.textContent = text.replace(/\{\\[^}]*\}/g, ''); // leftover ASS styling like {\an8}
      return s;
    }));
    el.subs.hidden = !cues.length;
  }
  function applySubtitlePref() {
    const pref = store.get('subs', null);
    setSubTrack([...video.textTracks].find((t) => pref && t.label === pref));
  }

  let menuKind = null;
  // On a portrait phone the player is too short for a popup, so menus become a bottom sheet.
  const sheetMQ = matchMedia('(max-width: 599px)');
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';
  backdrop.hidden = true;
  backdrop.addEventListener('click', () => closeMenu());
  document.body.appendChild(backdrop);
  function placeMenu() {
    const sheet = sheetMQ.matches && !immersive();
    el.menu.classList.toggle('sheet', sheet);
    (sheet ? document.body : el.player).appendChild(el.menu);
    backdrop.hidden = !sheet || el.menu.hidden;
  }
  function closeMenu() { el.menu.hidden = true; backdrop.hidden = true; menuKind = null; }
  function openMenu(kind) {
    if (menuKind === kind) return closeMenu();
    menuKind = kind;
    const m = el.menu;
    m.innerHTML = '';
    const add = (label, sel, fn, hint = '') => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = sel ? 'sel' : '';
      b.innerHTML = `<span>${esc(label)}${hint ? ` <span style="color:var(--muted);font-size:12px">${esc(hint)}</span>` : ''}</span>${svg('i-check')}`;
      b.onclick = () => { fn(); closeMenu(); };
      m.appendChild(b);
    };
    if (kind === 'quality') {
      m.insertAdjacentHTML('beforeend', '<h4>Quality</h4>');
      const origHint = `${current.ext.toUpperCase()} · ${fmtSize(current.size)}`;
      const onDirect = sourceKind === 'direct';
      // Switching between the adaptive stream and the original file reloads the source;
      // applyState() then puts this viewer back at the room's position.
      const useAdaptive = (pref) => { store.set('quality', pref); loadMovie(current); };
      if (current.hls) {
        if (sourceKind === 'hls' && hls) {
          const auto = hls.autoLevelEnabled;
          const cur = hls.levels[hls.currentLevel];
          add('Auto', auto, () => { hls.currentLevel = -1; store.set('quality', 'auto'); updateQualityLabel(); }, auto && cur ? levelName(cur) : '');
          hls.levels
            .map((l, i) => ({ l, i }))
            .sort((a, b) => b.l.bitrate - a.l.bitrate)
            .forEach(({ l, i }) => add(levelName(l), !auto && hls.currentLevel === i, () => {
              hls.currentLevel = i; store.set('quality', levelName(l)); updateQualityLabel();
            }, `${(l.bitrate / 1e6).toFixed(1)} Mbps`));
        } else if (sourceKind === 'native-hls') {
          add('Auto', true, () => {});
        } else {
          add('Auto', false, () => useAdaptive('auto'));
          (current.qualities || []).forEach((q) => add(q, false, () => useAdaptive(q)));
        }
        add('Original', onDirect, () => {
          if (onDirect) return;
          store.set('quality', 'original');
          loadMovie(current);
          toast('Playing the original file');
        }, origHint);
        m.insertAdjacentHTML('beforeend', '<small><b>Auto</b> adapts to your connection. <b>Original</b> is the untouched file — best picture, but needs a fast connection and not every phone can play every format.</small>');
      } else {
        add('Original', true, () => {}, origHint);
        m.insertAdjacentHTML('beforeend', '<small>Only the original file is available. For smooth playback on slow networks, run <code>npm run optimize</code> on the host PC.</small>');
      }
    } else if (kind === 'subs') {
      m.insertAdjacentHTML('beforeend', '<h4>Subtitles</h4>');
      const tracks = [...video.textTracks];
      const showing = subTrack;
      const choose = (track) => {
        setSubTrack(track);
        store.set('subs', track ? track.label : null);
      };
      add('Off', !showing, () => choose(null));
      tracks.forEach((t) => add(t.label || 'Subtitles', t === showing, () => choose(t)));
    }
    m.hidden = false;
    placeMenu();
    showControls();
  }

  el.qualityBtn.addEventListener('click', () => openMenu('quality'));
  el.ccBtn.addEventListener('click', () => openMenu('subs'));

  // ---------- Player UI ----------
  function updatePlayIcon() {
    const playing = state ? state.playing : !video.paused;
    setIcon(el.playBtn, playing ? 'i-pause' : 'i-play');
    el.player.classList.toggle('paused', !playing);
    if (!playing) showControls();
  }

  function updateTime() {
    const d = duration();
    el.durTime.textContent = fmt(d);
    if (dragging) return;
    el.curTime.textContent = fmt(video.currentTime);
    el.seek.max = d || 100;
    el.seek.value = video.currentTime || 0;
    el.seekFill.style.width = d ? `${(video.currentTime / d) * 100}%` : '0';
    updateBuffered();
  }

  function updateBuffered() {
    const d = duration();
    if (!d) return;
    const b = video.buffered;
    let end = 0;
    for (let i = 0; i < b.length; i++) if (b.start(i) <= video.currentTime + 1 && b.end(i) > end) end = b.end(i);
    el.seekBuf.style.width = `${(end / d) * 100}%`;
  }

  function seekPreview() {
    const d = duration();
    const v = Number(el.seek.value);
    el.curTime.textContent = fmt(v);
    el.seekFill.style.width = d ? `${(v / d) * 100}%` : '0';
    el.seekTip.hidden = false;
    el.seekTip.textContent = fmt(v);
    el.seekTip.style.left = `${d ? (v / d) * 100 : 0}%`;
  }
  el.seek.addEventListener('input', () => { dragging = true; el.seekWrap.classList.add('drag'); seekPreview(); showControls(); });
  const endDrag = () => { dragging = false; el.seekWrap.classList.remove('drag'); el.seekTip.hidden = true; updateTime(); };
  el.seek.addEventListener('change', () => {
    endDrag();
    const t = Number(el.seek.value);
    if (current) { sendControl('seek', t); seekTo(t); }
  });
  for (const ev of ['pointerup', 'pointercancel', 'touchcancel']) {
    el.seek.addEventListener(ev, () => setTimeout(() => { if (dragging) endDrag(); }, 60));
  }
  el.seekWrap.addEventListener('pointermove', (e) => {
    if (isTouch || dragging || !duration()) return;
    const r = el.seekWrap.getBoundingClientRect();
    const x = clamp((e.clientX - r.left) / r.width, 0, 1);
    el.seekTip.hidden = false;
    el.seekTip.textContent = fmt(x * duration());
    el.seekTip.style.left = `${x * 100}%`;
  });
  el.seekWrap.addEventListener('pointerleave', () => { if (!dragging) el.seekTip.hidden = true; });

  el.playBtn.addEventListener('click', togglePlay);
  el.back10.addEventListener('click', () => skip(-10));
  el.fwd10.addEventListener('click', () => skip(10));

  // Volume (desktop) — phones use hardware buttons
  el.volume.value = userVolume;
  function setVolume(v) {
    userVolume = clamp(v, 0, 1);
    video.volume = ducked ? userVolume * 0.35 : userVolume;
    video.muted = userVolume === 0;
    el.volume.value = userVolume;
    setIcon(el.muteBtn, userVolume === 0 ? 'i-vol-off' : 'i-vol');
    store.set('volume', userVolume);
  }
  el.volume.addEventListener('input', () => setVolume(Number(el.volume.value)));
  setVolume(userVolume);
  let lastVol = 1;
  el.muteBtn.addEventListener('click', () => {
    if (userVolume > 0) { lastVol = userVolume; setVolume(0); } else setVolume(lastVol || 1);
  });

  // Controls visibility + taps
  let hideTimer = null;
  function showControls() {
    el.player.classList.remove('idle');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (state?.playing && !dragging && el.menu.hidden && el.reactStrip.hidden) el.player.classList.add('idle');
    }, isTouch ? 3500 : 2500);
  }
  el.player.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') showControls(); });

  let lastTap = 0, tapTimer = null;
  el.player.addEventListener('pointerup', (e) => {
    if (e.target.closest('button, input, .menu, .react-strip, .seek')) return;
    if (!el.menu.hidden) { closeMenu(); return; }
    if (el.app.classList.contains('chat-open')) { el.app.classList.remove('chat-open'); return; }
    const now = Date.now();
    const r = el.player.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    if (e.pointerType === 'mouse') {
      if (now - lastTap < 280) { clearTimeout(tapTimer); lastTap = 0; toggleFullscreen(); return; }
      lastTap = now;
      tapTimer = setTimeout(togglePlay, 260);
      return;
    }
    // Touch: double-tap sides to skip, single tap toggles controls
    if (now - lastTap < 300 && (x < 0.35 || x > 0.65)) {
      clearTimeout(tapTimer);
      lastTap = now;
      skip(x < 0.35 ? -10 : 10);
      rippleSkip(x < 0.35 ? '−10s' : '+10s', x < 0.35);
      return;
    }
    lastTap = now;
    clearTimeout(tapTimer);
    tapTimer = setTimeout(() => {
      if (el.player.classList.contains('idle')) showControls();
      else if (state?.playing) el.player.classList.add('idle');
    }, 260);
  });

  function rippleSkip(text, left) {
    const d = document.createElement('div');
    d.className = 'float-emoji';
    d.style.cssText = `left:${left ? 14 : 72}%;bottom:42%;animation-duration:.9s`;
    d.innerHTML = `<span class="n" style="font-size:15px;padding:6px 14px">${text}</span>`;
    el.reactions.appendChild(d);
    setTimeout(() => d.remove(), 900);
  }

  // Fullscreen / immersive (landscape phones get an overlay chat drawer)
  const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement;
  const landscapeMQ = matchMedia('(orientation: landscape) and (max-height: 520px)');
  const isTyping = () => document.activeElement === el.msgInput;
  // Is a *phone* physically held sideways? Ask the device, not the viewport: when the keyboard opens
  // on an upright Android phone the viewport becomes e.g. 412×400 ("landscape"), which used to
  // switch to the full-screen layout and hide the chat box behind the keyboard.
  function phoneHeldSideways() {
    if (!isTouch) return false;
    const type = screen.orientation && screen.orientation.type;
    if (type) return type.startsWith('landscape') && Math.min(screen.width, screen.height) <= 600;
    if (typeof window.orientation === 'number') return Math.abs(window.orientation) === 90; // older iOS
    return false;
  }
  // The keyboard only changes the viewport *height*; rotating the phone changes the *width*.
  // So "typing + same width as in portrait" means the keyboard is open, not that the phone turned.
  let portraitWidth = 0;
  function updateImmersive() {
    const keyboardOpen = isTouch && isTyping() && portraitWidth && Math.abs(innerWidth - portraitWidth) < 2;
    const sideways = !keyboardOpen && (phoneHeldSideways() || landscapeMQ.matches);
    const imm = !!fsElement() || el.app.classList.contains('pseudo-fs') || sideways;
    if (!imm) portraitWidth = innerWidth;
    el.app.classList.toggle('immersive', imm);
    if (!imm) el.app.classList.remove('chat-open');
    setIcon(el.fsBtn, fsElement() || el.app.classList.contains('pseudo-fs') ? 'i-shrink' : 'i-expand');
    updateUnread();
  }
  landscapeMQ.addEventListener?.('change', updateImmersive);
  screen.orientation?.addEventListener?.('change', updateImmersive);
  addEventListener('orientationchange', () => setTimeout(updateImmersive, 150));
  document.addEventListener('fullscreenchange', updateImmersive);
  document.addEventListener('webkitfullscreenchange', updateImmersive);

  function toggleFullscreen() {
    if (fsElement()) {
      (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      return;
    }
    if (el.app.classList.contains('pseudo-fs')) {
      el.app.classList.remove('pseudo-fs');
      updateImmersive();
      return;
    }
    const root = document.documentElement;
    const req = root.requestFullscreen || root.webkitRequestFullscreen;
    const pseudo = () => { el.app.classList.add('pseudo-fs'); updateImmersive(); toast('Rotate your phone for the big screen'); };
    if (!req) return pseudo(); // iPhone: CSS fullscreen keeps our sync controls + chat
    Promise.resolve(req.call(root, { navigationUI: 'hide' }))
      .then(() => screen.orientation?.lock?.('landscape').catch(() => {}))
      .catch(pseudo);
  }
  el.fsBtn.addEventListener('click', toggleFullscreen);

  el.cChat.addEventListener('click', () => {
    const open = !el.app.classList.contains('chat-open');
    el.app.classList.toggle('chat-open', open);
    if (open) setTab('chat');
    updateUnread();
  });
  el.panelClose.addEventListener('click', () => { el.app.classList.remove('chat-open'); updateUnread(); });

  // Reactions
  REACTS.forEach((e) => {
    for (const host of [el.quickReacts, el.reactStrip]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = e;
      b.onclick = () => { socket?.volatile.emit('react', { emoji: e }); if (host === el.reactStrip) showControls(); };
      // Don't steal focus from the message box — otherwise tapping an emoji closes the keyboard.
      b.addEventListener('pointerdown', (ev) => ev.preventDefault());
      host.appendChild(b);
    }
  });
  el.reactBtn.addEventListener('click', () => { el.reactStrip.hidden = !el.reactStrip.hidden; el.reactBtn.classList.toggle('on', !el.reactStrip.hidden); showControls(); });

  function floatEmoji({ emoji, name, color }) {
    // Keyboard open → the bottom of the video is covered by the raised message box,
    // so reactions rise from just above the emoji row instead.
    const host = el.app.classList.contains('kb-up') ? el.kbReacts : el.reactions;
    const d = document.createElement('div');
    d.className = 'float-emoji';
    d.style.left = `${8 + Math.random() * 80}%`;
    d.style.setProperty('--dx', `${(Math.random() - 0.5) * 80}px`);
    d.innerHTML = `<span class="e">${esc(emoji)}</span><span class="n" style="color:${esc(color)}">${esc(name)}</span>`;
    host.appendChild(d);
    setTimeout(() => d.remove(), 2900);
    if (host.children.length > 24) host.firstElementChild.remove();
  }

  let toastTimer = null;
  function toast(text) {
    el.toast.textContent = text;
    el.toast.hidden = false;
    el.toast.style.animation = 'none';
    void el.toast.offsetWidth;
    el.toast.style.animation = '';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, 2800);
  }

  // Keyboard (desktop)
  document.addEventListener('keydown', (e) => {
    if (el.app.hidden || e.ctrlKey || e.metaKey || e.altKey) return;
    if (!el.modal.hidden) {
      if (e.key === 'Escape') el.modalCancel.click();
      else if (e.key === 'Tab') { e.preventDefault(); (document.activeElement === el.modalOk ? el.modalCancel : el.modalOk).focus(); }
      return;
    }
    if (e.target.matches('input, textarea')) {
      if (e.key === 'Escape') e.target.blur();
      return;
    }
    if ((e.key === ' ' || e.key === 'Enter') && e.target.closest('button, a, select, [role="button"], [tabindex]')) return;
    const k = e.key.toLowerCase();
    const map = {
      ' ': togglePlay, k: togglePlay,
      arrowleft: () => skip(-10), arrowright: () => skip(10), j: () => skip(-10), l: () => skip(10),
      f: toggleFullscreen,
      m: () => voice.active && toggleMic(),
      c: () => (immersive() ? el.cChat.click() : el.msgInput.focus()),
      enter: () => { if (immersive()) { el.app.classList.add('chat-open'); setTab('chat'); } el.msgInput.focus(); },
      escape: () => { closeMenu(); el.app.classList.remove('chat-open'); },
    };
    if (map[k]) { e.preventDefault(); map[k](); }
  });

  // Keep phone screen awake while watching
  let wakeLock = null, wakeWanted = false, wakePending = false;
  async function keepAwake(on) {
    wakeWanted = on;
    if (!('wakeLock' in navigator)) return;
    try {
      if (on && !wakeLock && !wakePending && document.visibilityState === 'visible') {
        wakePending = true;
        const lock = await navigator.wakeLock.request('screen');
        wakePending = false;
        if (!wakeWanted) { lock.release().catch(() => {}); return; } // paused while we were asking
        wakeLock = lock;
        lock.addEventListener('release', () => { if (wakeLock === lock) wakeLock = null; });
      } else if (!on && wakeLock) {
        const lock = wakeLock;
        wakeLock = null;
        await lock.release();
      }
    } catch { wakePending = false; }
  }

  // ---------- Panel ----------
  function setTab(tab) {
    activeTab = tab;
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
    $$('.tab-body').forEach((b) => b.classList.toggle('active', b.dataset.body === tab));
    el.composer.hidden = tab === 'movies';
    if (tab === 'chat') scrollChat(true);
    updateUnread();
  }
  $$('.tab').forEach((t) => t.addEventListener('click', () => setTab(t.dataset.tab)));

  const chatVisible = () => activeTab === 'chat' && (!immersive() || el.app.classList.contains('chat-open')) && !document.hidden;
  function updateUnread() {
    if (chatVisible()) unread = 0;
    el.chatBadge.hidden = !unread;
    el.chatBadge.textContent = unread > 9 ? '9+' : unread;
    el.cChatBadge.hidden = !unread;
  }

  const chatBody = $('[data-body="chat"]');
  function scrollChat(force) {
    const near = chatBody.scrollHeight - chatBody.scrollTop - chatBody.clientHeight < 120;
    if (force || near) requestAnimationFrame(() => { chatBody.scrollTop = chatBody.scrollHeight; });
  }

  const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|‍|️|\s){1,12}$/u;
  function addMessage(m, silent = false) {
    const near = !silent && chatBody.scrollHeight - chatBody.scrollTop - chatBody.clientHeight < 120;
    if (m.system) {
      // Same person joining/leaving again → replace their previous presence line instead of stacking.
      const prev = el.messages.lastElementChild;
      if (m.presence && prev && prev.dataset.presence === m.presence) prev.remove();
      const d = document.createElement('div');
      d.className = 'sys';
      d.textContent = m.text;
      if (m.presence) d.dataset.presence = m.presence;
      el.messages.appendChild(d);
      lastMsg = { uid: null, ts: 0 };
    } else {
      const mine = me && m.uid === me.uid;
      const cont = lastMsg.uid === m.uid && m.ts - lastMsg.ts < 120000;
      lastMsg = { uid: m.uid, ts: m.ts };
      const time = new Date(m.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      const row = document.createElement('div');
      row.className = `msg${mine ? ' me' : ''}${cont ? ' cont' : ''}`;
      const emojiOnly = EMOJI_ONLY.test(m.text) && !/^[\d\s#*]+$/.test(m.text);
      row.innerHTML = `
        <div class="avatar" style="background:${esc(m.color)}">${esc(initial(m.name))}</div>
        <div class="bubble-wrap">
          <div class="meta">${mine ? '' : `<b style="color:${esc(m.color)}">${esc(m.name)}</b>`}${time}</div>
          <div class="bubble${emojiOnly ? ' emoji-only' : ''}"></div>
        </div>`;
      row.querySelector('.bubble').textContent = m.text;
      el.messages.appendChild(row);
      // Keyboard open → the chat is hidden behind the raised message box, so float the message above it.
      if (!silent && el.app.classList.contains('kb-up')) floatAboveKeyboard(m, mine);
      if (!silent && !mine) {
        if (!chatVisible()) { unread++; updateUnread(); }
        if (immersive() && !el.app.classList.contains('chat-open')) tick(m);
      }
      if (mine && !silent) return scrollChat(true);
    }
    while (el.messages.children.length > 300) el.messages.firstElementChild.remove();
    if (near || silent) scrollChat(true);
  }

  // Floating bubbles just above the message box while the keyboard is open.
  // Sent: right side with "✓ Sent", short-lived. Received: left side with the sender's name, longer.
  function floatAboveKeyboard(m, mine) {
    const d = document.createElement('div');
    d.className = `kb-bubble ${mine ? 'me' : 'them'}`;
    if (!mine) {
      const n = document.createElement('b');
      n.textContent = m.name;
      n.style.color = m.color;
      d.appendChild(n);
    }
    const t = document.createElement('span');
    t.className = 'kb-text';
    t.textContent = m.text;
    d.appendChild(t);
    if (mine) d.insertAdjacentHTML('beforeend', `<i class="kb-sent">${svg('i-check')}Sent</i>`);
    el.kbFloat.appendChild(d);
    while (el.kbFloat.children.length > 3) el.kbFloat.firstElementChild.remove();
    const life = mine ? 1600 : 4200;
    setTimeout(() => d.classList.add('leaving'), life);
    setTimeout(() => d.remove(), life + 450);
  }

  function tick(m) {
    const d = document.createElement('div');
    d.className = 'ticker-msg';
    d.innerHTML = `<b style="color:${esc(m.color)}">${esc(m.name)}</b>`;
    d.appendChild(document.createTextNode(m.text));
    el.ticker.appendChild(d);
    setTimeout(() => d.remove(), 6500);
    while (el.ticker.children.length > 3) el.ticker.firstElementChild.remove();
  }

  let typingTimer = null;
  function showTyping(name) {
    el.typing.textContent = `${name} is typing…`;
    el.typing.hidden = false;
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => { el.typing.hidden = true; }, 3000);
  }
  let lastTypingSent = 0;
  // Grow the message box up to ~4 lines, then scroll inside it.
  function autoGrow() {
    el.msgInput.style.height = 'auto';
    el.msgInput.style.height = `${Math.min(el.msgInput.scrollHeight, 110)}px`;
  }
  el.msgInput.addEventListener('input', () => {
    autoGrow();
    if (Date.now() - lastTypingSent > 2500 && el.msgInput.value.trim()) {
      lastTypingSent = Date.now();
      socket?.volatile.emit('typing');
    }
  });

  function sendMessage() {
    const text = el.msgInput.value.trim();
    if (!text || !socket) return;
    if (!live()) return toast(OFFLINE); // the message stays in the box
    socket.emit('chat', { text });
    el.msgInput.value = '';
    autoGrow();
    el.typing.hidden = true;
  }
  // Enter sends; Shift+Enter adds a new line (ignored while an IME is composing, e.g. Hindi keyboards)
  el.msgInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendMessage();
    }
  });
  // Keep the keyboard open when tapping Send on a phone
  el.sendBtn.addEventListener('pointerdown', (e) => e.preventDefault());
  el.sendBtn.addEventListener('click', sendMessage);

  function renderPeople() {
    el.peopleCount.textContent = users.length;
    const statusText = { playing: 'Watching', paused: 'Paused', buffering: 'Buffering…' };
    el.people.innerHTML = users.map((u) => {
      const voiceCls = u.voice ? (u.muted ? 'muted' : 'on') : '';
      const voiceIcon = u.voice ? (u.muted ? 'i-mic-off' : 'i-mic') : 'i-headset';
      return `<li class="person" data-sid="${esc(u.id)}">
        <div class="avatar" style="background:${esc(u.color)}">${esc(initial(u.name))}</div>
        <div class="person-info">
          <div class="person-name">${esc(u.name)}${me && u.id === me.id ? '<small>(you)</small>' : ''}</div>
          <div class="person-sub">
            <span class="pill ${esc(u.status)}">${statusText[u.status] || u.status}</span>
            ${u.quality ? `<span class="pill">${esc(u.quality)}</span>` : ''}
            ${voice.active && u.voice && me && u.id !== me.id ? (() => { const m = voiceMode(u.id); return `<span class="pill ${m === 'Connecting…' ? 'buffering' : 'playing'}">🎙 ${m}</span>`; })() : ''}
          </div>
        </div>
        <div class="person-voice ${voiceCls}" title="${u.voice ? (u.muted ? 'Muted' : 'In voice') : 'Not in voice'}">${svg(voiceIcon)}</div>
      </li>`;
    }).join('');
    voice.meters.forEach((m, id) => m.on && setSpeaking(id === 'me' ? me?.id : id, true));
  }

  const HUES = [[255, 95, 69], [123, 77, 255], [61, 180, 220], [255, 178, 63], [61, 200, 140], [255, 90, 160]];
  function renderMovies() {
    el.moviesCount.textContent = movies.length ? `${movies.length} movie${movies.length > 1 ? 's' : ''}` : 'Library';
    if (!movies.length) {
      el.movies.innerHTML = `<li class="movies-empty">No movies yet.<br>Put a video file in the <b>movies</b> folder on the host PC, then tap refresh.</li>`;
      return;
    }
    el.movies.innerHTML = movies.map((m, i) => {
      const h = HUES[[...m.name].reduce((a, c) => a + c.charCodeAt(0), 0) % HUES.length];
      const isCur = current && current.id === m.id;
      return `<li><button class="movie${isCur ? ' current' : ''}" data-id="${esc(m.id)}" type="button">
        <div class="poster" style="background:linear-gradient(160deg, rgba(${h},.9), rgba(${h},.25))">${esc(initial(m.name))}</div>
        <div class="movie-info">
          ${isCur ? '<div class="now-playing">Now playing</div>' : ''}
          <div class="movie-name">${esc(m.name)}</div>
          <div class="movie-meta">
            ${m.hls ? '<span class="pill ok">⚡ Adaptive</span>' : '<span class="pill warn">Original file</span>'}
            <span class="pill">${esc(m.ext.toUpperCase())} · ${fmtSize(m.size)}</span>
            ${m.duration ? `<span class="pill">${fmt(m.duration)}</span>` : ''}
            ${m.subs.length ? `<span class="pill">CC ${m.subs.length}</span>` : ''}
          </div>
        </div>
      </button></li>`;
    }).join('');
  }
  el.movies.addEventListener('click', async (e) => {
    const b = e.target.closest('.movie');
    if (!b || (current && current.id === b.dataset.id)) return;
    const m = movies.find((x) => x.id === b.dataset.id);
    if (await confirmModal('Switch movie?', `Play “${m.name}” for everyone in the room?`, 'Play for everyone')) {
      if (!live()) return toast(OFFLINE);
      socket.emit('select', { id: m.id });
      if (immersive()) el.app.classList.remove('chat-open');
    }
  });
  el.refreshMovies.addEventListener('click', () => {
    if (live()) socket.emit('refresh-movies');
    el.refreshMovies.animate([{ transform: 'rotate(0)' }, { transform: 'rotate(360deg)' }], { duration: 600 });
  });

  function confirmModal(title, text, okText = 'OK') {
    el.modalCancel.onclick?.(); // an older dialog still open counts as cancelled
    const opener = document.activeElement;
    return new Promise((resolve) => {
      el.modalTitle.textContent = title;
      el.modalText.textContent = text;
      el.modalOk.textContent = okText;
      el.modal.hidden = false;
      const done = (v) => {
        el.modal.hidden = true;
        el.modal.onclick = el.modalOk.onclick = el.modalCancel.onclick = null;
        opener?.focus?.({ preventScroll: true });
        resolve(v);
      };
      el.modalOk.onclick = () => done(true);
      el.modalCancel.onclick = () => done(false);
      el.modal.onclick = (e) => { if (e.target === el.modal) done(false); };
      el.modalOk.focus({ preventScroll: true });
    });
  }

  // ---------- Voice chat (WebRTC mesh) ----------
  const voice = { active: false, muted: false, stream: null, peers: new Map(), ctx: null, meters: new Map(), timer: null };

  async function joinVoice() {
    if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) {
      toast(location.protocol === 'https:' ? 'Voice isn’t supported in this browser' : 'Voice chat needs the https:// link');
      return;
    }
    if (voice.active || voice.joining) return; // second tap while the permission prompt is up
    if (!live()) return toast(OFFLINE);
    voice.joining = true;
    el.voiceJoin.disabled = true;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(micConstraints());
    } catch (err) {
      const msg = {
        NotAllowedError: '🎙  Microphone permission is blocked — allow it in the browser’s site settings',
        NotReadableError: '🎙  Microphone is busy — end other calls (WhatsApp, Instagram…) and try again',
        NotFoundError: '🎙  No microphone found',
      }[err.name] || 'Couldn’t access the microphone';
      toast(msg);
      return;
    } finally {
      voice.joining = false;
      el.voiceJoin.disabled = false;
    }
    if (!socket) { stream.getTracks().forEach((t) => t.stop()); return; } // sent back to the join screen meanwhile
    voice.stream = stream;
    voice.active = true;
    voice.muted = false;
    ensureAudio();
    addMeter('me', voice.stream);
    socket.emit('voice-join');
    renderVoice();
    if (isTouch && !earphones() && !store.get('earHint', false)) {
      store.set('earHint', true);
      toast('🎧  In voice. Wearing earphones? Turn on Earphones mode in People for full movie sound');
    } else {
      toast('🎧  You joined voice');
    }
  }

  // ---- Earphones mode ----
  // With echo cancelling on, Android (and iOS) put the whole phone into "phone call" audio while the
  // mic is open: voices get boosted and the movie's music and bass get squashed. Echo cancelling is
  // only needed when the movie plays from a speaker (so it doesn't leak into the mic) — with
  // earphones it can be off, and the movie keeps its normal sound.
  const earphones = () => store.get('earphones', false) === true;
  function micConstraints() {
    const call = !earphones();
    return { audio: { echoCancellation: call, noiseSuppression: call, autoGainControl: call, channelCount: 1 } };
  }
  el.earMode.checked = earphones();
  el.earMode.addEventListener('change', async () => {
    store.set('earphones', el.earMode.checked);
    if (voice.active) await swapMic();
    toast(el.earMode.checked ? '🎧  Earphones mode on — full movie sound' : '🔈  Earphones mode off — echo cancelling on');
  });

  // Re-open the mic with the new settings and hand the new track to every friend's connection.
  let micGen = 0; // bumps on every swap/teardown, so a slower, older request never wins
  async function swapMic() {
    const gen = ++micGen;
    // Release the old mic first: the phone only leaves call audio once no echo-cancelled mic is open.
    voice.stream?.getTracks().forEach((t) => t.stop());
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(micConstraints());
    } catch {
      if (gen !== micGen) return;
      toast('Couldn’t restart the microphone — rejoin voice');
      return leaveVoice();
    }
    if (gen !== micGen || !voice.active) { stream.getTracks().forEach((t) => t.stop()); return; } // superseded / left voice
    voice.stream = stream;
    const track = stream.getAudioTracks()[0];
    track.enabled = !voice.muted;
    voice.peers.forEach((p) => p.pc.getSenders().forEach((s) => {
      if (s.track?.kind === 'audio') s.replaceTrack(track).catch(() => {});
    }));
    if (relay.capture) { stopRelayCapture(); startRelayCapture(); }
    addMeter('me', stream);
  }

  function rejoinVoice() {
    [...voice.peers.keys()].forEach(closePeer);
    resetRelay(); // everyone's connection ids changed after a reconnect
    socket.emit('voice-join');
    if (voice.muted) socket.emit('voice-mute', { muted: true });
  }

  function leaveVoice() {
    socket?.emit('voice-leave');
    teardownVoice();
  }

  function teardownVoice() {
    micGen++;
    [...voice.peers.keys()].forEach(closePeer);
    resetRelay();
    voice.stream?.getTracks().forEach((t) => t.stop());
    voice.stream = null;
    voice.active = false;
    voice.meters.delete('me');
    setSpeaking(me?.id, false);
    clearInterval(voice.timer);
    voice.timer = null;
    duck(false);
    renderVoice();
  }

  function toggleMic() {
    if (!voice.stream) return;
    voice.muted = !voice.muted;
    voice.stream.getAudioTracks().forEach((t) => { t.enabled = !voice.muted; });
    socket.emit('voice-mute', { muted: voice.muted });
    renderVoice();
  }

  function renderVoice() {
    el.voiceJoin.hidden = voice.active;
    el.voiceOn.hidden = !voice.active;
    el.cMic.hidden = !voice.active;
    for (const b of [el.micBtn, el.cMic]) {
      b.classList.toggle('muted', voice.muted);
      b.classList.toggle('mic', true);
      setIcon(b, voice.muted ? 'i-mic-off' : 'i-mic');
      b.title = voice.muted ? 'Unmute (M)' : 'Mute (M)';
    }
  }
  el.voiceJoin.addEventListener('click', joinVoice);
  el.voiceLeave.addEventListener('click', leaveVoice);
  el.micBtn.addEventListener('click', toggleMic);
  el.cMic.addEventListener('click', toggleMic);

  function makePeer(id, initiator) {
    const pc = new RTCPeerConnection({ iceServers: session.iceServers, bundlePolicy: 'max-bundle' });
    const peer = { pc, chain: Promise.resolve(), audio: null };
    voice.peers.set(id, peer);
    voice.stream.getTracks().forEach((t) => pc.addTrack(t, voice.stream));
    pc.onicecandidate = (e) => { if (e.candidate) socket.emit('signal', { to: id, data: { candidate: e.candidate } }); };
    pc.ontrack = (e) => {
      if (peer.audio) return;
      const a = document.createElement('audio');
      a.autoplay = true;
      a.playsInline = true;
      a.srcObject = e.streams[0];
      el.audioSink.appendChild(a);
      a.play().catch(() => {});
      peer.audio = a;
      addMeter(id, e.streams[0]);
    };
    // If a direct connection isn't up within 8 s (blocked NAT / strict network), use the server relay.
    peer.timer = setTimeout(() => {
      if (voice.peers.get(id) === peer && pc.connectionState !== 'connected') goRelay(id);
    }, 8000);
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      renderPeople();
      if (st === 'connected') {
        clearTimeout(peer.timer);
        clearTimeout(peer.dcTimer);
        // Find out whether the call goes phone-to-phone or through a TURN relay (shown in People).
        pc.getStats().then((stats) => {
          let pair = null;
          stats.forEach((s) => { if (s.type === 'transport' && s.selectedCandidatePairId) pair = stats.get(s.selectedCandidatePairId); });
          if (!pair) stats.forEach((s) => { if (s.type === 'candidate-pair' && s.state === 'succeeded' && (s.nominated || s.selected)) pair = s; });
          const local = pair && stats.get(pair.localCandidateId);
          const remote = pair && stats.get(pair.remoteCandidateId);
          peer.route = local?.candidateType === 'relay' || remote?.candidateType === 'relay' ? 'turn' : 'direct';
          renderPeople();
        }).catch(() => {});
        // Voice stays light so the movie keeps most of the bandwidth.
        pc.getSenders().forEach((s) => {
          if (s.track?.kind !== 'audio') return;
          const p = s.getParameters();
          if (!p.encodings || !p.encodings.length) p.encodings = [{}];
          p.encodings[0].maxBitrate = 32000;
          s.setParameters(p).catch(() => {});
        });
      }
      // Direct connection broke (network changed, NAT timeout): give it a few seconds, then relay.
      if (st === 'disconnected') {
        clearTimeout(peer.dcTimer);
        peer.dcTimer = setTimeout(() => {
          if (voice.peers.get(id) === peer && pc.connectionState !== 'connected') goRelay(id);
        }, 5000);
      }
      if (st === 'failed') goRelay(id);
    };
    return peer;
  }

  function callPeer(id) {
    if (!voice.active || voice.peers.has(id) || relay.peers.has(id)) return;
    if (forceRelay()) return goRelay(id);
    const peer = makePeer(id, true);
    peer.chain = peer.chain.then(async () => {
      await peer.pc.setLocalDescription(await peer.pc.createOffer());
      socket.emit('signal', { to: id, data: { sdp: peer.pc.localDescription } });
    }).catch((e) => console.warn('offer', e));
  }

  function onSignal(from, data) {
    if (!voice.active) return;
    if (data && data.relay) return goRelay(from, false); // friend switched us to the server relay
    if (relay.peers.has(from)) return;                   // already relaying with this friend
    if (forceRelay() && data.sdp?.type === 'offer') return goRelay(from);
    let peer = voice.peers.get(from);
    if (data.sdp?.type === 'offer' && peer) { closePeer(from); peer = null; }
    if (!peer) {
      if (data.sdp?.type !== 'offer') return;
      peer = makePeer(from, false);
    }
    peer.chain = peer.chain.then(async () => {
      if (data.sdp) {
        await peer.pc.setRemoteDescription(data.sdp);
        if (data.sdp.type === 'offer') {
          await peer.pc.setLocalDescription(await peer.pc.createAnswer());
          socket.emit('signal', { to: from, data: { sdp: peer.pc.localDescription } });
        }
      } else if (data.candidate) {
        try { await peer.pc.addIceCandidate(data.candidate); } catch {}
      }
    }).catch((e) => console.warn('signal', e));
  }

  function closePeer(id) {
    const peer = voice.peers.get(id);
    if (!peer) return;
    voice.peers.delete(id);
    clearTimeout(peer.timer);
    clearTimeout(peer.dcTimer);
    try { peer.pc.close(); } catch {}
    if (peer.audio) { peer.audio.srcObject = null; peer.audio.remove(); }
    voice.meters.delete(id);
    setSpeaking(id, false);
  }

  // ---------- Voice relay (fallback through our own server) ----------
  // Direct phone-to-phone WebRTC is blocked on some networks (e.g. mobile-carrier NATs), which made
  // voice work "sometimes". When the direct connection doesn't come up, voice for that friend goes
  // through the Movie Night server instead — over the same tunnel that already carries video and
  // chat, so it connects whenever the app works. 16 kHz mono IMA-ADPCM (~64 kbps), sent only while
  // you're speaking; ~150 ms jitter buffer on the receiving side.
  const RELAY_RATE = 16000;
  const FRAME = 640; // 40 ms at 16 kHz
  const relay = { peers: new Set(), capture: null, sink: new Map(), lastVoice: 0, warned: false, pred: 0, index: 0 };
  const forceRelay = () => store.get('voiceRelay', false) === true; // debug: localStorage 'mn:voiceRelay' = true

  const ADPCM_INDEX = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];
  const ADPCM_STEP = [7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73,
    80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724,
    796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871,
    5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623,
    27086, 29794, 32767];
  const clamp16 = (v) => (v > 32767 ? 32767 : v < -32768 ? -32768 : v);

  // Each packet starts with the encoder state, so every packet decodes on its own (a lost packet is just a gap).
  function adpcmEncode(pcm) {
    const out = new Uint8Array(4 + (pcm.length >> 1));
    let pred = relay.pred, index = relay.index;
    out[0] = pred & 0xff; out[1] = (pred >> 8) & 0xff; out[2] = index;
    for (let i = 0; i < pcm.length; i++) {
      const step = ADPCM_STEP[index];
      let diff = pcm[i] - pred, code = 0, delta = step >> 3;
      if (diff < 0) { code = 8; diff = -diff; }
      if (diff >= step) { code |= 4; diff -= step; delta += step; }
      if (diff >= step >> 1) { code |= 2; diff -= step >> 1; delta += step >> 1; }
      if (diff >= step >> 2) { code |= 1; delta += step >> 2; }
      pred = clamp16(code & 8 ? pred - delta : pred + delta);
      index = Math.min(88, Math.max(0, index + ADPCM_INDEX[code]));
      if (i & 1) out[4 + (i >> 1)] |= code << 4; else out[4 + (i >> 1)] = code;
    }
    relay.pred = pred; relay.index = index;
    return out;
  }
  function adpcmDecode(bytes) {
    const n = (bytes.length - 4) * 2;
    const out = new Float32Array(n);
    let pred = ((bytes[0] | (bytes[1] << 8)) << 16) >> 16;
    let index = Math.min(88, bytes[2]);
    for (let i = 0; i < n; i++) {
      const b = bytes[4 + (i >> 1)];
      const code = i & 1 ? b >> 4 : b & 15;
      const step = ADPCM_STEP[index];
      let delta = step >> 3;
      if (code & 4) delta += step;
      if (code & 2) delta += step >> 1;
      if (code & 1) delta += step >> 2;
      pred = clamp16(code & 8 ? pred - delta : pred + delta);
      index = Math.min(88, Math.max(0, index + ADPCM_INDEX[code]));
      out[i] = pred / 32768;
    }
    return out;
  }

  const CAPTURE_WORKLET = `class MnCapture extends AudioWorkletProcessor {
    constructor() { super(); this.buf = new Float32Array(1024); this.n = 0; }
    process(inputs) {
      const ch = inputs[0] && inputs[0][0];
      if (ch) for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice(0)); this.n = 0; }
      }
      return true;
    }
  }
  registerProcessor('mn-capture', MnCapture);`;

  async function startRelayCapture() {
    if (relay.capture || !voice.ctx || !voice.stream) return;
    const ctx = voice.ctx;
    const cap = { src: ctx.createMediaStreamSource(voice.stream), node: null, mute: ctx.createGain() };
    relay.capture = cap;
    cap.mute.gain.value = 0; // keep the node pulled by the graph without making any sound
    cap.mute.connect(ctx.destination);
    const ratio = ctx.sampleRate / RELAY_RATE;
    let frame = new Float32Array(FRAME), fill = 0, pos = 0, prev = 0;
    const onSamples = (input) => {
      // Resample to 16 kHz (linear interpolation; `prev` carries the last sample across chunks).
      while (pos < input.length) {
        const i = Math.floor(pos), f = pos - i;
        const a = i === 0 ? prev : input[i - 1];
        const b = input[i];
        frame[fill++] = a + (b - a) * f;
        if (fill === FRAME) { sendRelayFrame(frame); frame = new Float32Array(FRAME); fill = 0; }
        pos += ratio;
      }
      pos -= input.length;
      prev = input[input.length - 1];
    };
    try {
      if (!ctx.audioWorklet) throw new Error('no worklet');
      if (!ctx.mnWorklet) {
        const url = URL.createObjectURL(new Blob([CAPTURE_WORKLET], { type: 'application/javascript' }));
        ctx.mnWorklet = ctx.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
        ctx.mnWorklet.catch(() => { ctx.mnWorklet = null; });
      }
      await ctx.mnWorklet;
      if (relay.capture !== cap) return; // voice was left meanwhile
      cap.node = new AudioWorkletNode(ctx, 'mn-capture');
      cap.node.port.onmessage = (e) => onSamples(e.data);
    } catch {
      cap.node = ctx.createScriptProcessor(2048, 1, 1); // older browsers
      cap.node.onaudioprocess = (e) => onSamples(e.inputBuffer.getChannelData(0));
    }
    if (relay.capture !== cap) return;
    cap.src.connect(cap.node);
    cap.node.connect(cap.mute);
  }

  function stopRelayCapture() {
    const cap = relay.capture;
    relay.capture = null;
    if (!cap) return;
    try { cap.src.disconnect(); cap.node?.disconnect(); cap.mute.disconnect(); } catch {}
    if (cap.node?.port) cap.node.port.onmessage = null;
  }

  function sendRelayFrame(f32) {
    if (voice.muted || !relay.peers.size || !socket?.connected) return;
    let sum = 0;
    for (let i = 0; i < f32.length; i++) sum += f32[i] * f32[i];
    const now = performance.now();
    if (Math.sqrt(sum / f32.length) > 0.008) relay.lastVoice = now;
    if (now - relay.lastVoice > 600) return; // silence: send nothing
    const pcm = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) pcm[i] = clamp16(Math.round(f32[i] * 32767));
    socket.volatile.emit('vr', { to: [...relay.peers], d: adpcmEncode(pcm).buffer });
  }

  function playRelay(from, data) {
    const ctx = voice.ctx;
    if (!ctx || !data) return;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    let s = relay.sink.get(from);
    if (!s) {
      const gain = ctx.createGain();
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      gain.connect(ctx.destination);
      gain.connect(an);
      s = { gain, next: 0 };
      relay.sink.set(from, s);
      voice.meters.set(from, { an, buf: new Uint8Array(an.fftSize), on: false, last: 0 }); // speaking ring + movie ducking
    }
    const f32 = adpcmDecode(new Uint8Array(data));
    let ab;
    try {
      ab = ctx.createBuffer(1, f32.length, RELAY_RATE);
      ab.copyToChannel(f32, 0);
    } catch { // some browsers refuse 16 kHz buffers — upsample to the context rate
      const r = ctx.sampleRate / RELAY_RATE, n = Math.round(f32.length * r), up = new Float32Array(n);
      for (let j = 0; j < n; j++) {
        const x = j / r, i = Math.floor(x), f = x - i;
        up[j] = f32[i] * (1 - f) + (f32[Math.min(i + 1, f32.length - 1)]) * f;
      }
      ab = ctx.createBuffer(1, n, ctx.sampleRate);
      ab.copyToChannel(up, 0);
    }
    const now = ctx.currentTime;
    // Jitter buffer: start ~150 ms ahead; if we fell behind or drifted too far ahead, re-anchor.
    if (s.next < now + 0.02 || s.next > now + 0.6) s.next = now + 0.15;
    const node = ctx.createBufferSource();
    node.buffer = ab;
    node.connect(s.gain);
    node.start(s.next);
    s.next += ab.duration;
  }

  function goRelay(id, tellPeer = true) {
    if (!voice.active || relay.peers.has(id)) return;
    closePeer(id);
    relay.peers.add(id);
    if (tellPeer) socket.emit('signal', { to: id, data: { relay: true } });
    startRelayCapture();
    renderPeople();
    if (!relay.warned) {
      relay.warned = true;
      toast('🎧  Voice connected through the server');
    }
  }

  function dropRelay(id) {
    relay.peers.delete(id);
    const s = relay.sink.get(id);
    if (s) { try { s.gain.disconnect(); } catch {} relay.sink.delete(id); }
    voice.meters.delete(id);
    setSpeaking(id, false);
    if (!relay.peers.size) stopRelayCapture();
  }

  function resetRelay() {
    [...relay.peers].forEach(dropRelay);
    stopRelayCapture();
    relay.warned = false;
  }

  // Shown next to each friend in People while you're in voice.
  function voiceMode(id) {
    if (relay.peers.has(id)) return 'Via server';
    const p = voice.peers.get(id);
    if (!p || p.pc.connectionState !== 'connected') return 'Connecting…';
    return p.route === 'turn' ? 'Via TURN' : 'Direct';
  }

  // Speaking indicators + auto-lower the movie while friends talk
  function ensureAudio() {
    if (!voice.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) voice.ctx = new AC();
    }
    voice.ctx?.resume?.();
    if (!voice.timer) voice.timer = setInterval(tickMeters, 140);
  }
  function addMeter(id, stream) {
    if (!voice.ctx) return;
    try {
      const src = voice.ctx.createMediaStreamSource(stream);
      const an = voice.ctx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      voice.meters.set(id, { an, buf: new Uint8Array(an.fftSize), on: false, last: 0 });
    } catch {}
  }
  function tickMeters() {
    let remoteTalking = false;
    const now = Date.now();
    voice.meters.forEach((m, id) => {
      m.an.getByteTimeDomainData(m.buf);
      let sum = 0;
      for (let i = 0; i < m.buf.length; i++) { const x = (m.buf[i] - 128) / 128; sum += x * x; }
      const rms = Math.sqrt(sum / m.buf.length);
      if (rms > 0.03 && !(id === 'me' && voice.muted)) m.last = now;
      const on = now - m.last < 350;
      if (on !== m.on) { m.on = on; setSpeaking(id === 'me' ? me?.id : id, on); }
      if (on && id !== 'me') remoteTalking = true;
    });
    duck(remoteTalking);
  }
  function setSpeaking(sid, on) {
    if (!sid) return;
    $$(`[data-sid="${CSS.escape(sid)}"]`).forEach((n) => n.classList.toggle('speaking', on));
    if (me && sid === me.id) [el.micBtn, el.cMic].forEach((b) => b.classList.toggle('speaking', on));
  }
  function duck(on) {
    if (on) {
      clearTimeout(duckTimer);
      duckTimer = null;
      if (!ducked) { ducked = true; video.volume = userVolume * 0.35; }
    } else if (ducked && !duckTimer) {
      duckTimer = setTimeout(() => { ducked = false; duckTimer = null; video.volume = userVolume; }, 800);
    }
  }

  // ---------- On-screen keyboard ----------
  // The layout never changes when the keyboard opens: video, tabs and chat stay put, and only the
  // message box (with the emoji row) slides up to sit on top of the keyboard, covering older messages.
  // The keyboard height is *measured* (full layout height − visible height), so it works whether the
  // browser overlays the keyboard (iOS, Chrome 108+) or shrinks the page (older Android browsers), and
  // it resets as soon as the keyboard hides — even if the box keeps focus (Android back button).
  const vv = window.visualViewport;
  let fullW = window.innerWidth;
  let fullH = window.innerHeight;
  let lastKb = 0;
  function fitViewport() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const typing = document.activeElement === el.msgInput;
    if (!isTouch || Math.abs(w - fullW) > 1) { fullW = w; fullH = h; } // desktop resize or phone rotated
    else if (h > fullH || !typing) fullH = h;                           // toolbar hid/showed, not the keyboard
    // (height shrank while typing on a phone = keyboard: keep the full height so nothing reflows)
    document.documentElement.style.setProperty('--app-h', `${fullH}px`);

    // When the keyboard opens, Chrome/Safari also *scroll the page up* (visualViewport.offsetTop) to
    // reveal the focused box, which pushed the top bar + video off screen. Shift the app back down by
    // that amount so its top stays at the top of what you see, then lift the message box by the full
    // keyboard height (= layout height − visible height).
    // Only while typing on a touch device and not pinch-zoomed, so zooming never moves things.
    const active = isTouch && typing && vv && Math.abs((vv.scale || 1) - 1) < 0.01;
    const offsetTop = active ? Math.max(0, Math.round(vv.offsetTop)) : 0;
    el.app.style.transform = offsetTop ? `translateY(${offsetTop}px)` : '';
    let kb = active ? Math.round(fullH - vv.height) : 0;
    if (kb < 80) kb = 0; // ignore browser-toolbar wiggle
    document.documentElement.style.setProperty('--kb', `${kb}px`);
    el.app.classList.toggle('kb-up', kb > 0);
    if (kb > 0 && lastKb === 0) scrollChat(true);
    lastKb = kb;
    updateImmersive();
  }
  if (vv) {
    vv.addEventListener('resize', fitViewport);
    vv.addEventListener('scroll', fitViewport);
  }
  addEventListener('resize', fitViewport);
  el.msgInput.addEventListener('focus', () => {
    fitViewport();
    // iOS scrolls the page to "reveal" the input; undo that after the keyboard animation.
    setTimeout(() => { window.scrollTo(0, 0); fitViewport(); scrollChat(true); }, 300);
  });
  el.msgInput.addEventListener('blur', () => setTimeout(fitViewport, 50));
  fitViewport();

  // ---------- Go ----------
  setTab('chat');
  renderVoice();
  boot();
})();
