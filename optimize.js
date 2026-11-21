// Builds a low-network friendly version of each movie: adaptive HLS with
// 720p / 480p / 360p / 240p renditions + AAC stereo audio + extracted subtitles.
// The player then switches quality automatically as the connection changes.
//
//   npm run optimize                       -> every movie in ./movies not yet optimized
//   npm run optimize -- "D:\Movies"        -> every movie in that folder
//   npm run optimize -- "D:\Movies\x.mkv"  -> just that file
//   add --force to rebuild (safe while people are watching), --cpu to skip GPU encoders
//   npm run optimize -- --clean            -> delete optimized copies of movies that no longer exist

const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const lib = require('./lib/library');

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const CPU_ONLY = args.includes('--cpu');
const CLEAN = args.includes('--clean');
const { dir, file } = lib.resolveLibrary(args.find((a) => !a.startsWith('--')));

// Keep the movie's ORIGINAL sound — just folded to stereo (a compact stereo track keeps the low-data
// streams small; the untouched 5.1 track is always available via "Original" in the quality menu).
// FFmpeg's default 5.1→stereo (-ac 2) drops the LFE (subwoofer) channel and scales everything down
// ~6 dB, so music/effects sounded thin and quiet. This mix keeps every channel, including the LFE,
// at the standard centre/surround levels. No loudness levelling or compression: the original
// dynamics stay intact; a peak limiter only catches the rare peaks that would otherwise distort.
// Measured on a 5.1 test track: original 5.1 = -26.0 LUFS, this mix = -24.1 LUFS, old -ac 2 = -31.9.
// Channel order: 5.1 = FL FR FC LFE SL SR, 7.1 = FL FR FC LFE BL BR SL SR.
function stereoMix(channels) {
  if (channels >= 8) {
    return 'pan=stereo|FL=c0+0.707*c2+0.6*c3+0.707*c4+0.707*c6|FR=c1+0.707*c2+0.6*c3+0.707*c5+0.707*c7';
  }
  // 6.1 = FL FR FC LFE BC SL SR (the back-centre goes to both sides)
  if (channels === 7) return 'pan=stereo|FL=c0+0.707*c2+0.6*c3+0.5*c4+0.707*c5|FR=c1+0.707*c2+0.6*c3+0.5*c4+0.707*c6';
  if (channels >= 6) return 'pan=stereo|FL=c0+0.707*c2+0.6*c3+0.707*c4|FR=c1+0.707*c2+0.6*c3+0.707*c5';
  if (channels === 1) return 'pan=stereo|FL=c0|FR=c0';
  return 'aformat=channel_layouts=stereo';
}

const LADDER = [
  { name: '720p', w: 1280, vb: 2400, ab: 160 },
  { name: '480p', w: 854, vb: 1100, ab: 128 },
  { name: '360p', w: 640, vb: 600, ab: 96 },
  { name: '240p', w: 426, vb: 280, ab: 64 },
];
const TEXT_SUBS = new Set(['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text']);

function findTool(name) {
  const local = [
    path.join(__dirname, `${name}.exe`),
    // Chocolatey's bin\ffmpeg.exe is a launcher "shim"; call the real binary so that
    // stopping the optimizer also stops ffmpeg (a shim can leave it running).
    path.join('C:/ProgramData/chocolatey/lib/ffmpeg/tools/ffmpeg/bin', `${name}.exe`),
    path.join('C:/ProgramData/chocolatey/lib/ffmpeg-full/tools/ffmpeg/bin', `${name}.exe`),
    path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links', `${name}.exe`),
    path.join('C:/ProgramData/chocolatey/bin', `${name}.exe`),
    path.join('C:/ffmpeg/bin', `${name}.exe`),
  ];
  const hit = local.find((p) => fs.existsSync(p));
  if (hit) return hit;
  return spawnSync(name, ['-version']).status === 0 ? name : null;
}

// Make sure ffmpeg never outlives this script (Ctrl+C, closing the window, errors).
let child = null;
function killChild() {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGKILL');
}
let lockFile = null;
function cleanup() {
  killChild();
  if (lockFile) { try { fs.rmSync(lockFile, { force: true }); } catch {} }
}
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  process.on(sig, () => { console.log('\n  Stopped.'); cleanup(); process.exit(130); });
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

const FFMPEG = findTool('ffmpeg');
const FFPROBE = findTool('ffprobe');
if (!FFMPEG || !FFPROBE) {
  console.log('\n⚠  ffmpeg is not installed. Install it once (PowerShell):');
  console.log('     winget install --id Gyan.FFmpeg');
  console.log('   then open a NEW terminal and run  npm run optimize  again.\n');
  process.exit(1);
}

function pickEncoder() {
  const candidates = CPU_ONLY ? [] : ['h264_nvenc', 'h264_qsv', 'h264_amf'];
  for (const enc of candidates) {
    const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=640x360:d=0.5',
      '-c:v', enc, '-f', 'null', '-']);
    if (r.status === 0) return enc;
  }
  return 'libx264';
}

// Every rendition needs a keyframe (IDR) every 4s so HLS can cut 4s segments and switch quality.
// Each GPU encoder needs its own flag for that, e.g. QSV ignores forced keyframes unless -forced_idr 1.
const KEYFRAMES = ['-force_key_frames', 'expr:gte(t,n_forced*4)'];
const ENCODER_OPTS = {
  libx264: ['-preset', 'veryfast', '-sc_threshold', '0', ...KEYFRAMES],
  h264_nvenc: ['-preset', 'p4', '-rc', 'vbr', '-forced-idr', '1', ...KEYFRAMES],
  h264_qsv: ['-preset', 'veryfast', '-forced_idr', '1', ...KEYFRAMES],
  h264_amf: ['-quality', 'speed', '-rc', 'vbr_peak'], // relies on -g
};

// Count segments in a variant playlist (sanity check that keyframes were honoured).
function segmentCount(playlist) {
  try { return (fs.readFileSync(playlist, 'utf8').match(/#EXTINF/g) || []).length; } catch { return 0; }
}

function probe(input) {
  const r = spawnSync(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', input], { maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(String(r.stderr));
  return JSON.parse(String(r.stdout));
}

const fmt = (s) => {
  s = Math.max(0, Math.round(s));
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

function run(argv, duration, label) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, argv, { windowsHide: true });
    child = p;
    p.on('error', reject);
    const started = Date.now();
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    // Progress: redraw one line in a real terminal (at most once a second, trimmed to the window width
    // so it never wraps — a wrapped line can't be redrawn and turns into a wall of lines). When output
    // isn't a terminal (piped/logged), print a short line every 5% instead.
    const tty = process.stdout.isTTY;
    let lastDraw = 0, lastStep = -1, lastLine = '';
    p.stdout.on('data', (d) => {
      const m = String(d).match(/out_time_(?:us|ms)=(\d+)/g);
      if (!m || !duration) return;
      const t = Number(m[m.length - 1].split('=')[1]) / 1e6;
      const pct = Math.min(100, (t / duration) * 100);
      const elapsed = (Date.now() - started) / 1000;
      const eta = pct > 0.5 ? (elapsed / pct) * (100 - pct) : 0;
      const speed = elapsed > 1 ? `${(t / elapsed).toFixed(1)}x` : '';
      if (tty) {
        if (Date.now() - lastDraw < 1000) return;
        lastDraw = Date.now();
        const cols = process.stdout.columns || 80;
        const info = `${pct.toFixed(1).padStart(5)}%  ${speed}  ETA ${fmt(eta)}`;
        const barW = Math.max(0, Math.min(25, cols - info.length - label.length - 8));
        const bar = barW >= 8 ? `${'█'.repeat(Math.round((pct / 100) * barW)).padEnd(barW, '░')} ` : '';
        lastLine = `  ${label} ${bar}${info}`.slice(0, cols - 1);
        process.stdout.write(`\r\x1b[2K${lastLine}`);
      } else {
        const step = Math.floor(pct / 5);
        if (step === lastStep) return;
        lastStep = step;
        console.log(`  ${label} ${pct.toFixed(0)}%  ${speed}  ETA ${fmt(eta)}`);
      }
    });
    p.on('close', (code) => {
      child = null;
      if (tty && lastLine) process.stdout.write('\n');
      code === 0 ? resolve() : reject(new Error(err));
    });
  });
}

// Each build goes into its own folder (prepared/<movie>/b<timestamp>/) and ready.json is switched to it
// only once it's complete. So re-optimizing never interrupts people who are watching the current
// version, and the new folder name means phones never mix cached old segments with new ones.
async function optimize(rel, encoder) {
  const input = path.join(dir, rel);
  const info = lib.preparedInfo(input);
  const st = fs.statSync(input);
  const changed = info.ready && info.sourceSize && (info.sourceSize !== st.size || info.sourceMtime !== Math.round(st.mtimeMs));
  if (info.ready && !FORCE && !changed) {
    console.log(`✓ Already optimized: ${rel}`);
    return;
  }
  console.log(`\n▶ ${rel}`);
  if (changed && !FORCE) console.log('  The file changed since it was optimized — rebuilding.');

  // Refuse to run twice on the same movie (two windows would fight over the same folder).
  const lock = path.join(lib.PREPARED_DIR, `${info.key}.lock`);
  if (fs.existsSync(lock)) {
    const pid = Number(fs.readFileSync(lock, 'utf8'));
    if (pid && pid !== process.pid && alive(pid)) {
      console.log(`  ⚠ Already being optimized in another window (process ${pid}). Skipping.`);
      return;
    }
  }
  fs.mkdirSync(info.dir, { recursive: true });
  fs.writeFileSync(lock, String(process.pid));
  lockFile = lock;
  try {
    // Leftovers of an interrupted run (never made it into ready.json).
    for (const e of fs.readdirSync(info.dir)) if (/^b\d+$/.test(e) && e !== info.build) removeQuietly(path.join(info.dir, e));
    await build(input, info, encoder);
  } finally {
    fs.rmSync(lock, { force: true });
    lockFile = null;
  }
}

async function build(input, info, encoder) {
  const meta = probe(input);
  const video = meta.streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  if (!video) return console.log('  No video stream, skipping.');
  const audios = meta.streams.filter((s) => s.codec_type === 'audio');
  const audio = audios.find((s) => s.disposition?.default) || audios[0];
  const duration = Number(meta.format.duration) || Number(video.duration) || 0;
  const [n, d] = String(video.avg_frame_rate || video.r_frame_rate || '24/1').split('/').map(Number);
  const fps = n && d ? n / d : 24;
  const gop = Math.max(24, Math.round(fps * 4));

  // Non-square pixels (DVDs, some TV rips): work out the width the picture is really shown at.
  const [sx, sy] = String(video.sample_aspect_ratio || '1:1').split(':').map(Number);
  const sar = sx > 0 && sy > 0 ? sx / sy : 1;
  const shownWidth = Math.round((video.width || 1280) * sar);
  let ladder = LADDER.filter((r) => r.w <= shownWidth + 16);
  if (ladder.length < 2) ladder = LADDER.slice(-2);

  const buildId = `b${Date.now()}`;
  const outDir = path.join(info.dir, buildId);
  fs.mkdirSync(outDir, { recursive: true });
  const out = outDir.replace(/\\/g, '/');

  const split = ladder.map((_, i) => `[s${i}]`).join('');
  // Downscale once to the top rung, then derive the smaller rungs from that (much cheaper than 4x from 1080p/4K).
  const top = ladder[0].w;
  const scales = ladder.map((r, i) => (i === 0 ? `[s0]null[v0]` : `[s${i}]scale=${r.w}:-2:flags=bicubic,setsar=1[v${i}]`)).join(';');
  const square = Math.abs(sar - 1) > 0.01 ? `scale='trunc(iw*sar/2)*2':ih,setsar=1,` : '';
  let graph = `[0:${video.index}]${square}scale='min(${top},iw)':-2:flags=bicubic,setsar=1,format=yuv420p,split=${ladder.length}${split};${scales}`;
  if (audio) {
    // One audio chain (original sound folded to stereo + peak-only limiter), split to every quality level.
    // level=0 stops alimiter from auto-raising the volume, so loudness and dynamics stay as in the movie.
    const outs = ladder.map((_, i) => `[a${i}]`).join('');
    graph += `;[0:${audio.index}]aformat=sample_fmts=fltp,${stereoMix(audio.channels)},alimiter=limit=0.97:level=0,aresample=48000,asplit=${ladder.length}${outs}`;
  }
  const argv = ['-hide_banner', '-y', '-nostats', '-progress', 'pipe:1'];
  if (encoder !== 'libx264') argv.push('-hwaccel', 'auto'); // GPU decoding (big win for HEVC / 10-bit); CPU mode stays pure CPU
  argv.push('-i', input, '-filter_complex', graph);
  ladder.forEach((r, i) => {
    argv.push('-map', `[v${i}]`, `-c:v:${i}`, encoder, `-b:v:${i}`, `${r.vb}k`,
      `-maxrate:v:${i}`, `${Math.round(r.vb * 1.3)}k`, `-bufsize:v:${i}`, `${r.vb * 2}k`);
  });
  if (audio) ladder.forEach((r, i) => argv.push('-map', `[a${i}]`, `-c:a:${i}`, 'aac', `-b:a:${i}`, `${r.ab}k`));
  argv.push('-profile:v', 'main', ...ENCODER_OPTS[encoder],
    '-g', String(gop), '-keyint_min', String(gop),
    '-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'vod', '-hls_flags', 'independent_segments',
    '-hls_segment_filename', `${out}/%v/seg_%05d.ts`, '-master_pl_name', 'master.m3u8',
    '-var_stream_map', ladder.map((r, i) => (audio ? `v:${i},a:${i},name:${r.name}` : `v:${i},name:${r.name}`)).join(' '),
    `${out}/%v/index.m3u8`);

  console.log(`  ${video.codec_name} ${video.width}x${video.height} · ${fmt(duration)} · encoder ${encoder} · ${ladder.map((r) => r.name).join(', ')}`);
  const retryOnCpu = (why) => {
    console.log(`  ⚠ ${why} Redoing with the CPU encoder…`);
    removeQuietly(outDir);
    return build(input, info, 'libx264');
  };
  try {
    await run(argv, duration, 'Encoding');
  } catch (e) {
    if (encoder === 'libx264') { removeQuietly(outDir); throw e; }
    return retryOnCpu(`${encoder} failed (${String(e.message).trim().split('\n').pop()}).`);
  }

  // A 2h movie should give ~1800 four-second segments. If an encoder ignored the keyframe
  // settings we'd get a handful of giant segments — useless on slow networks — so redo on CPU.
  const segs = segmentCount(path.join(outDir, ladder[ladder.length - 1].name, 'index.m3u8'));
  const expectedSegs = Math.floor(duration / 4);
  if (duration > 20 && segs < expectedSegs * 0.5) {
    if (encoder === 'libx264') { removeQuietly(outDir); throw new Error(`Only ${segs} segments were produced (expected ~${expectedSegs}).`); }
    return retryOnCpu(`${encoder} ignored keyframe settings (${segs} segments, expected ~${expectedSegs}).`);
  }
  console.log(`  ${segs} segments per quality (4s each)`);

  // Embedded text subtitles -> WebVTT files, all in one pass over the file.
  const subStreams = meta.streams.filter((s) => s.codec_type === 'subtitle' && TEXT_SUBS.has(s.codec_name));
  const subs = subStreams.map((s, i) => ({
    file: `sub_${i}.vtt`, index: s.index,
    label: [s.tags?.title, s.tags?.language].filter(Boolean).join(' · ') || `Track ${i + 1}`,
  }));
  if (subs.length) {
    const subArgs = ['-hide_banner', '-loglevel', 'error', '-y', '-i', input];
    for (const s of subs) subArgs.push('-map', `0:${s.index}`, '-c:s', 'webvtt', path.join(outDir, s.file));
    try {
      await run(subArgs, 0, 'Subtitles');
      console.log(`  Extracted ${subs.length} subtitle track(s)`);
    } catch {
      console.log('  ⚠ Could not extract the subtitles (the movie itself is fine).');
      subs.length = 0;
    }
  }
  const skipped = meta.streams.filter((s) => s.codec_type === 'subtitle' && !TEXT_SUBS.has(s.codec_name)).length;
  if (skipped) console.log(`  (${skipped} picture-based subtitle track(s) skipped — only text subtitles can be shown)`);

  // Switch to the new build in one step, then remove the previous one.
  const readyTmp = path.join(info.dir, 'ready.json.tmp');
  fs.writeFileSync(readyTmp, JSON.stringify({
    source: input, sourceSize: fs.statSync(input).size, sourceMtime: Math.round(fs.statSync(input).mtimeMs),
    build: buildId, duration, qualities: ladder.map((r) => r.name),
    subs: subs.map(({ file, label }) => ({ file, label })), createdAt: new Date().toISOString(),
  }, null, 2));
  for (let i = 0; ; i++) {
    try { fs.renameSync(readyTmp, path.join(info.dir, 'ready.json')); break; } catch (e) {
      if (i >= 20) throw e; // ~10 s of "file in use" (antivirus, search indexer)
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  console.log('  ✓ Done');

  const old = fs.readdirSync(info.dir).filter((e) => e !== buildId && e !== 'ready.json');
  if (old.length) {
    if (info.ready) {
      // Anyone watching switches to the new version within ~10 s; give them time before deleting.
      console.log('  Removing the previous version in 20 s (so anyone watching can switch over)…');
      await new Promise((r) => setTimeout(r, 20_000));
    }
    for (const e of old) removeQuietly(path.join(info.dir, e));
  }
}

function removeQuietly(p) {
  try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch {}
}

// Optimized copies are kept per movie file. When a movie is deleted, renamed or moved, its copy
// (often several GB) stays behind; --clean removes those.
function clean() {
  let removed = 0, freed = 0;
  const size = (p) => {
    try {
      const st = fs.statSync(p);
      return st.isDirectory() ? fs.readdirSync(p).reduce((a, e) => a + size(path.join(p, e)), 0) : st.size;
    } catch { return 0; }
  };
  for (const e of fs.existsSync(lib.PREPARED_DIR) ? fs.readdirSync(lib.PREPARED_DIR, { withFileTypes: true }) : []) {
    const d = path.join(lib.PREPARED_DIR, e.name);
    if (!e.isDirectory()) {
      if (e.name.endsWith('.lock') && !alive(Number(fs.readFileSync(d, 'utf8')))) removeQuietly(d); // stale lock
      continue;
    }
    let source = null;
    try { source = JSON.parse(fs.readFileSync(path.join(d, 'ready.json'), 'utf8')).source; } catch {}
    const lock = d + '.lock';
    if (fs.existsSync(lock) && alive(Number(fs.readFileSync(lock, 'utf8')))) continue; // being optimized now
    if (source && fs.existsSync(source)) continue;
    if (source && !fs.existsSync(path.parse(source).root)) { // e.g. a USB drive that's just unplugged
      console.log(`  (keeping ${e.name} — its drive ${path.parse(source).root} isn't connected)`);
      continue;
    }
    const bytes = size(d);
    console.log(`  🗑  ${e.name}  (${human(bytes)}${source ? '' : ', unfinished'})`);
    removeQuietly(d);
    removed++;
    freed += bytes;
  }
  console.log(removed ? `\nRemoved ${removed} leftover folder(s), freed ${human(freed)}.` : 'Nothing to clean — every optimized copy belongs to a movie that still exists.');
}

function human(bytes) {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
}

(async () => {
  if (CLEAN) return clean();
  const list = file ? [file] : lib.listMovies(dir).map((m) => m.id.split('/').join(path.sep));
  if (!list.length) {
    console.log(`No movies found in ${dir}`);
    return;
  }
  const encoder = pickEncoder();
  console.log(`Using encoder: ${encoder}${encoder === 'libx264' ? ' (CPU — a 2h movie can take a while)' : ' (GPU)'}`);
  for (const rel of list) {
    try {
      await optimize(rel, encoder);
    } catch (e) {
      console.log(`  ✗ Failed: ${String(e.message).trim().split('\n').slice(-4).join('\n    ')}`);
    }
  }
  console.log('\nAll done. If the server is running, everyone switches to the optimized version automatically within ~10 s.');
})();
