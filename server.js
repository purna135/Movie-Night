// Movie Night — stream a movie from this PC to friends, in sync, with chat + voice.
//   npm start                       -> serve ./movies and open a public HTTPS tunnel
//   npm start -- "D:\Movies"        -> serve another folder
//   npm start -- "D:\Movies\x.mkv"  -> serve that folder and pre-select the file
//   npm run local                   -> no tunnel (same Wi-Fi testing only)
//   npm run optimize                -> build low-network adaptive versions (needs ffmpeg)
// Env: PORT, PASSCODE, TURN_URL, TURN_USER, TURN_PASS

const express = require('express');
const compression = require('compression');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Server } = require('socket.io');
const lib = require('./lib/library');

const args = process.argv.slice(2);
const WANT_TUNNEL = args.includes('--tunnel');
const { dir: MOVIES_DIR, file: PRESELECT } = lib.resolveLibrary(args.find((a) => !a.startsWith('--')));

const PORT = Number(process.env.PORT) || 8787;
const PASSCODE = (process.env.PASSCODE || String(crypto.randomInt(100000, 999999))).trim();
const TOKEN = crypto.randomBytes(24).toString('hex');
const COOKIE = 'mn_session';

const movies = () => lib.listMovies(MOVIES_DIR);

const iceServers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
if (process.env.TURN_URL) {
  iceServers.push({ urls: process.env.TURN_URL, username: process.env.TURN_USER, credential: process.env.TURN_PASS });
}

// ---------- HTTP ----------
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(compression()); // gzips html/js/css/playlists; video is left alone
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0 })); // revalidate (cheap 304s) so updates show up
app.get('/vendor/hls.min.js', (req, res) =>
  res.sendFile(path.join(__dirname, 'node_modules/hls.js/dist/hls.min.js'), { maxAge: '7d' }));

function readCookie(req) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([a-f0-9]+)`));
  return m ? m[1] : null;
}
const authed = (req) => readCookie(req) === TOKEN || req.query.k === TOKEN;
function auth(req, res, next) {
  if (!authed(req)) return res.status(401).end();
  next();
}

let failed = 0;
let lockedUntil = 0;
app.post('/api/join', (req, res) => {
  if (Date.now() < lockedUntil) return res.status(429).json({ error: 'Too many attempts. Try again in a minute.' });
  const code = String(req.body?.code || '').trim();
  const ok = code.length === PASSCODE.length && crypto.timingSafeEqual(Buffer.from(code), Buffer.from(PASSCODE));
  if (!ok) {
    if (++failed >= 15) { lockedUntil = Date.now() + 60_000; failed = 0; }
    return res.status(401).json({ error: 'Wrong passcode' });
  }
  failed = 0;
  res.cookie(COOKIE, TOKEN, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 7 * 864e5 });
  res.json({ token: TOKEN, iceServers });
});

// Lets a refreshed / reconnecting page skip the passcode screen.
app.get('/api/session', (req, res) => {
  if (!authed(req)) return res.json({ token: null }); // 200, so browsers don't log an error
  res.json({ token: TOKEN, iceServers });
});

app.get('/media/*', auth, (req, res) => {
  const abs = lib.safeResolve(MOVIES_DIR, req.params[0]);
  if (!abs || !lib.VIDEO_EXT.has(path.extname(abs).toLowerCase()) || !fs.existsSync(abs)) return res.status(404).end();
  // Chrome plays most Matroska files when labelled webm; the real MIME type makes it refuse.
  const headers = path.extname(abs).toLowerCase() === '.mkv' ? { 'Content-Type': 'video/webm' } : {};
  res.sendFile(abs, { acceptRanges: true, headers, dotfiles: 'allow' });
});

app.get('/subs/*', auth, (req, res) => {
  const abs = lib.safeResolve(MOVIES_DIR, req.params[0]);
  if (!abs || !lib.SUB_EXT.has(path.extname(abs).toLowerCase()) || !fs.existsSync(abs)) return res.status(404).end();
  let text = fs.readFileSync(abs, 'utf8').replace(/^\uFEFF/, '').replace(/\r/g, '');
  if (path.extname(abs).toLowerCase() === '.srt') {
    text = 'WEBVTT\n\n' + text.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  }
  res.type('text/vtt').send(text);
});

app.use('/hls', auth, express.static(lib.PREPARED_DIR, {
  maxAge: '1d',
  setHeaders(res, file) {
    if (file.endsWith('.m3u8')) res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    else if (file.endsWith('.ts')) res.setHeader('Content-Type', 'video/mp2t');
    else if (file.endsWith('.vtt')) res.setHeader('Content-Type', 'text/vtt');
  },
}));

const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e5, pingInterval: 10000, pingTimeout: 20000 });

// ---------- Room state ----------
const COLORS = ['#ff7a59', '#ffc94a', '#5ee2a0', '#5ab8ff', '#b78cff', '#ff6fb5', '#4fe0e0', '#ffa24a'];
const users = new Map(); // socket.id -> user
const recent = new Map(); // clientId -> last seen (to hide join/leave spam on flaky networks)
const history = [];
const room = { movie: null, playing: false, time: 0, updatedAt: Date.now(), autoPaused: false, ignoreWaitUntil: 0 };

room.movie = PRESELECT ? lib.toId(PRESELECT) : movies()[0]?.id || null;

const position = () => (room.playing ? room.time + (Date.now() - room.updatedAt) / 1000 : room.time);
const snapshot = (extra = {}) => ({ movie: room.movie, playing: room.playing, time: position(), serverNow: Date.now(), ...extra });
const publicUsers = () => [...users.values()].map(({ clientId, ...u }) => u);
const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, n);

function setRoom(patch, extra) {
  Object.assign(room, patch, { updatedAt: Date.now() });
  io.emit('state', snapshot(extra));
}

function system(text) {
  const msg = { id: crypto.randomUUID(), system: true, text, ts: Date.now() };
  history.push(msg);
  if (history.length > 150) history.shift();
  io.emit('chat', msg);
}

// "Wait for everyone": if someone is buffering while playing, pause the room
// at their position, then resume automatically once nobody is buffering.
let waitTimer = null;
function checkBuffering() {
  const stuck = [...users.values()].filter((u) => u.status === 'buffering');
  if (!stuck.length) {
    clearTimeout(waitTimer);
    waitTimer = null;
    if (room.autoPaused) setRoom({ playing: true, autoPaused: false }, { action: 'resume' });
    return;
  }
  if (room.autoPaused) return io.emit('waiting', stuck.map((u) => u.name));
  if (!room.playing || waitTimer || Date.now() < room.ignoreWaitUntil) return;
  waitTimer = setTimeout(() => {
    waitTimer = null;
    const still = [...users.values()].filter((u) => u.status === 'buffering');
    if (!room.playing || !still.length || Date.now() < room.ignoreWaitUntil) return;
    const times = still.map((u) => u.time).filter(Number.isFinite);
    const t = times.length ? Math.min(position(), ...times) : position();
    setRoom({ playing: false, time: Math.max(0, t), autoPaused: true }, { action: 'wait', waitingFor: still.map((u) => u.name) });
  }, 2500);
}

io.use((socket, next) => {
  if (socket.handshake.auth?.token !== TOKEN) return next(new Error('unauthorized'));
  next();
});

io.on('connection', (socket) => {
  socket.on('join', ({ name, clientId } = {}) => {
    const cid = clean(clientId, 64) || socket.id;
    // Drop a stale socket from the same device (reconnect on a flaky network).
    for (const [sid, u] of users) if (u.clientId === cid && sid !== socket.id) users.delete(sid);
    const used = new Set([...users.values()].map((u) => u.color));
    const color = COLORS.find((c) => !used.has(c)) || COLORS[users.size % COLORS.length];
    const uid = crypto.createHash('sha1').update(cid).digest('hex').slice(0, 12);
    const user = { id: socket.id, uid, clientId: cid, name: clean(name, 24) || 'Guest', color, status: 'paused', voice: false, muted: false, quality: null };
    users.set(socket.id, user);
    const { clientId: _, ...me } = user;
    const list = movies();
    if (!room.movie && list[0]) Object.assign(room, { movie: list[0].id, playing: false, time: 0, updatedAt: Date.now() });
    socket.emit('welcome', { me, movies: list, state: snapshot(), history });
    io.emit('users', publicUsers());
    const seen = recent.get(cid);
    if (!seen || Date.now() - seen > 60_000) system(`${user.name} joined`);
    recent.set(cid, Date.now());
  });

  socket.on('clock', (_t0, cb) => typeof cb === 'function' && cb(Date.now()));

  socket.on('control', ({ action, time } = {}) => {
    const user = users.get(socket.id);
    if (!user || !room.movie) return;
    const t = Number.isFinite(time) ? Math.max(0, time) : position();
    if (action === 'play') setRoom({ time: t, playing: true, autoPaused: false, ignoreWaitUntil: Date.now() + 8000 }, { by: user.name, byId: user.id, action });
    else if (action === 'pause') setRoom({ time: t, playing: false, autoPaused: false }, { by: user.name, byId: user.id, action });
    else if (action === 'seek') setRoom({ time: t }, { by: user.name, byId: user.id, action });
  });

  socket.on('select', ({ id } = {}) => {
    const user = users.get(socket.id);
    const movie = movies().find((m) => m.id === id);
    if (!user || !movie) return;
    setRoom({ movie: movie.id, playing: false, time: 0, autoPaused: false }, { by: user.name, byId: user.id, action: 'select' });
    system(`${user.name} picked "${movie.name}"`);
  });

  socket.on('refresh-movies', () => {
    const list = movies();
    io.emit('movies', list);
    if ((!room.movie || !list.some((m) => m.id === room.movie)) && list[0]) {
      setRoom({ movie: list[0].id, playing: false, time: 0, autoPaused: false }, { action: 'select' });
    }
  });

  socket.on('chat', ({ text } = {}) => {
    const user = users.get(socket.id);
    const t = clean(text, 600);
    if (!user || !t) return;
    const msg = { id: crypto.randomUUID(), uid: user.uid, name: user.name, color: user.color, text: t, ts: Date.now() };
    history.push(msg);
    if (history.length > 150) history.shift();
    io.emit('chat', msg);
  });

  socket.on('typing', () => {
    const user = users.get(socket.id);
    if (user) socket.broadcast.emit('typing', { id: user.id, name: user.name });
  });

  socket.on('react', ({ emoji } = {}) => {
    const user = users.get(socket.id);
    const e = clean(emoji, 8);
    if (user && e) io.emit('react', { emoji: e, name: user.name, color: user.color });
  });

  socket.on('status', ({ status, time, quality } = {}) => {
    const user = users.get(socket.id);
    if (!user || !['playing', 'paused', 'buffering'].includes(status)) return;
    const changed = user.status !== status || user.quality !== (quality || null);
    user.status = status;
    user.time = Number(time);
    user.quality = quality ? clean(quality, 12) : null;
    if (changed) io.emit('users', publicUsers());
    checkBuffering();
  });

  // ---- Voice: WebRTC mesh, the server only relays signaling ----
  socket.on('voice-join', () => {
    const user = users.get(socket.id);
    if (!user) return;
    const peers = [...users.values()].filter((u) => u.voice && u.id !== socket.id).map((u) => u.id);
    Object.assign(user, { voice: true, muted: false });
    socket.emit('voice-peers', peers); // the newcomer calls everyone already in voice
    io.emit('users', publicUsers());
  });

  socket.on('voice-leave', () => {
    const user = users.get(socket.id);
    if (!user) return;
    user.voice = false;
    io.emit('voice-left', socket.id);
    io.emit('users', publicUsers());
  });

  socket.on('voice-mute', ({ muted } = {}) => {
    const user = users.get(socket.id);
    if (!user) return;
    user.muted = !!muted;
    io.emit('users', publicUsers());
  });

  socket.on('signal', ({ to, data } = {}) => {
    if (users.get(to)?.voice && users.get(socket.id)?.voice) io.to(to).emit('signal', { from: socket.id, data });
  });

  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    if (!user) return;
    users.delete(socket.id);
    io.emit('voice-left', socket.id);
    io.emit('users', publicUsers());
    recent.set(user.clientId, Date.now());
    // Only announce leaving if they don't come back quickly.
    setTimeout(() => {
      const back = [...users.values()].some((u) => u.clientId === user.clientId);
      if (!back) system(`${user.name} left`);
    }, 15_000);
    if (users.size === 0 && room.playing) { room.time = position(); room.playing = false; room.updatedAt = Date.now(); }
    checkBuffering();
  });
});

// Periodic drift correction
setInterval(() => {
  if (room.playing && users.size) io.emit('sync', snapshot());
}, 3000);

// When `npm run optimize` finishes (or a movie is added) while people are watching, push the new
// library so everyone switches to the adaptive stream without tapping refresh.
let librarySig = '';
setInterval(() => {
  if (!users.size) return;
  const list = movies();
  const sig = list.map((m) => `${m.id}|${m.hls ? 1 : 0}|${m.subs.length}`).join('\n');
  if (librarySig && sig !== librarySig) {
    io.emit('movies', list);
    if (list.some((m) => m.id === room.movie && m.hls)) console.log('⚡ Optimized version ready — viewers switched to adaptive quality.');
  }
  librarySig = sig;
}, 10000);

// ---------- Startup ----------
function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) return i.address;
  }
  return 'localhost';
}

function findCloudflared() {
  const candidates = [
    path.join(__dirname, 'cloudflared.exe'),
    'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
    'C:\\Program Files\\cloudflared\\cloudflared.exe',
    path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links', 'cloudflared.exe'),
  ];
  return candidates.find((p) => fs.existsSync(p)) || 'cloudflared';
}

function banner(url) {
  const list = movies();
  const line = '─'.repeat(60);
  console.log(`\n┌${line}┐`);
  console.log('  🎬  Movie Night is live — send this to your friend');
  console.log(`  Link:      ${url}`);
  console.log(`  Passcode:  ${PASSCODE}`);
  console.log(`  Movies:    ${list.length} in ${MOVIES_DIR}`);
  const slow = list.filter((m) => !m.hls);
  if (slow.length) console.log(`  Tip:       ${slow.length} not optimized for slow networks — run: npm run optimize`);
  console.log(`└${line}┘\n`);
  try {
    require('qrcode-terminal').generate(`${url}/?code=${PASSCODE}`, { small: true });
    console.log('  Scan with a phone camera to join (passcode included)\n');
  } catch {}
}

function startTunnel() {
  const cf = spawn(findCloudflared(), ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`], { windowsHide: true });
  let found = false;
  const onData = (buf) => {
    const m = !found && String(buf).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m) { found = true; banner(m[0]); }
  };
  cf.stdout.on('data', onData);
  cf.stderr.on('data', onData);
  cf.on('error', () => {
    console.log('\n⚠  cloudflared is not installed, so there is no public link yet.');
    console.log('   Install it once (PowerShell):  winget install --id Cloudflare.cloudflared');
    console.log('   then open a new terminal and run  npm start  again.\n');
  });
  cf.on('exit', (code) => found && console.log(`Tunnel closed (code ${code}).`));
  const stop = () => { cf.kill(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

let port = PORT;
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && port < PORT + 20) {
    console.log(`Port ${port} is busy, trying ${port + 1}…`);
    server.listen(++port);
  } else {
    throw err;
  }
});

server.listen(port, () => {
  console.log(`Local:    http://localhost:${port}`);
  console.log(`LAN:      http://${lanAddress()}:${port}  (voice chat needs the HTTPS tunnel link on phones)`);
  console.log(`Passcode: ${PASSCODE}`);
  if (!movies().length) console.log(`\n⚠  No videos found. Put your movie file in: ${MOVIES_DIR}`);
  if (WANT_TUNNEL) {
    console.log('\nOpening public tunnel…');
    startTunnel();
  }
});
