// Builds a low-network friendly version of each movie: adaptive HLS with
// 720p / 480p / 360p / 240p renditions + AAC stereo audio + extracted subtitles.
// The player then switches quality automatically as the connection changes.
//
//   npm run optimize                       -> every movie in ./movies not yet optimized
//   npm run optimize -- "D:\Movies"        -> every movie in that folder
//   npm run optimize -- "D:\Movies\x.mkv"  -> just that file
//   add --force to rebuild, --cpu to skip GPU encoders

const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const lib = require('./lib/library');

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const CPU_ONLY = args.includes('--cpu');
const { dir, file } = lib.resolveLibrary(args.find((a) => !a.startsWith('--')));

const LADDER = [
  { name: '720p', w: 1280, vb: 2400, ab: 128 },
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
    const started = Date.now();
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    p.stdout.on('data', (d) => {
      const m = String(d).match(/out_time_(?:us|ms)=(\d+)/g);
      if (!m || !duration) return;
      const t = Number(m[m.length - 1].split('=')[1]) / 1e6;
      const pct = Math.min(100, (t / duration) * 100);
      const elapsed = (Date.now() - started) / 1000;
      const eta = pct > 0.5 ? (elapsed / pct) * (100 - pct) : 0;
      const speed = elapsed > 1 ? `${(t / elapsed).toFixed(1)}x` : '';
      const bar = '█'.repeat(Math.round(pct / 4)).padEnd(25, '░');
      process.stdout.write(`\r  ${label} ${bar} ${pct.toFixed(1).padStart(5)}%  ${speed.padStart(6)}  ETA ${fmt(eta)}   `);
    });
    p.on('close', (code) => {
      child = null;
      process.stdout.write('\n');
      code === 0 ? resolve() : reject(new Error(err));
    });
  });
}

async function optimize(rel, encoder) {
  const input = path.join(dir, rel);
  const info = lib.preparedInfo(input);
  if (info.ready && !FORCE) {
    console.log(`✓ Already optimized: ${rel}`);
    return;
  }
  console.log(`\n▶ ${rel}`);
  const meta = probe(input);
  const video = meta.streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  if (!video) return console.log('  No video stream, skipping.');
  const audios = meta.streams.filter((s) => s.codec_type === 'audio');
  const audio = audios.find((s) => s.disposition?.default) || audios[0];
  const duration = Number(meta.format.duration) || Number(video.duration) || 0;
  const [n, d] = String(video.avg_frame_rate || video.r_frame_rate || '24/1').split('/').map(Number);
  const fps = n && d ? n / d : 24;
  const gop = Math.max(24, Math.round(fps * 4));

  let ladder = LADDER.filter((r) => r.w <= (video.width || 1280) + 16);
  if (ladder.length < 2) ladder = LADDER.slice(-2);

  // Refuse to run twice on the same movie (two windows would corrupt the output).
  const lock = path.join(lib.PREPARED_DIR, `${info.key}.lock`);
  if (fs.existsSync(lock)) {
    const pid = Number(fs.readFileSync(lock, 'utf8'));
    if (pid && pid !== process.pid && alive(pid)) {
      console.log(`  ⚠ Already being optimized in another window (process ${pid}). Skipping.`);
      return;
    }
  }
  fs.mkdirSync(lib.PREPARED_DIR, { recursive: true });
  fs.writeFileSync(lock, String(process.pid));
  lockFile = lock;

  // Empty (rather than delete) the folder: Windows refuses to delete a folder that is open in
  // Explorer or a terminal, but emptying it works.
  fs.mkdirSync(info.dir, { recursive: true });
  for (const entry of fs.readdirSync(info.dir)) {
    fs.rmSync(path.join(info.dir, entry), { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
  const out = info.dir.replace(/\\/g, '/');

  const split = ladder.map((_, i) => `[s${i}]`).join('');
  // Downscale once to the top rung, then derive the smaller rungs from that (much cheaper than 4x from 1080p/4K).
  const top = ladder[0].w;
  const scales = ladder.map((r, i) => (i === 0 ? `[s0]null[v0]` : `[s${i}]scale=${r.w}:-2:flags=bicubic,setsar=1[v${i}]`)).join(';');
  const argv = ['-hide_banner', '-y', '-nostats', '-progress', 'pipe:1',
    '-hwaccel', 'auto', // GPU decoding when available (big win for HEVC / 10-bit); falls back to CPU
    '-i', input,
    '-filter_complex', `[0:${video.index}]scale='min(${top},iw)':-2:flags=bicubic,setsar=1,format=yuv420p,split=${ladder.length}${split};${scales}`];
  ladder.forEach((r, i) => {
    argv.push('-map', `[v${i}]`, `-c:v:${i}`, encoder, `-b:v:${i}`, `${r.vb}k`,
      `-maxrate:v:${i}`, `${Math.round(r.vb * 1.3)}k`, `-bufsize:v:${i}`, `${r.vb * 2}k`);
  });
  if (audio) {
    ladder.forEach((r, i) => argv.push('-map', `0:${audio.index}`, `-c:a:${i}`, 'aac', `-b:a:${i}`, `${r.ab}k`));
    argv.push('-ac', '2', '-ar', '48000');
  }
  argv.push('-profile:v', 'main', ...ENCODER_OPTS[encoder],
    '-g', String(gop), '-keyint_min', String(gop),
    '-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'vod', '-hls_flags', 'independent_segments',
    '-hls_segment_filename', `${out}/%v/seg_%05d.ts`, '-master_pl_name', 'master.m3u8',
    '-var_stream_map', ladder.map((r, i) => (audio ? `v:${i},a:${i},name:${r.name}` : `v:${i},name:${r.name}`)).join(' '),
    `${out}/%v/index.m3u8`);

  console.log(`  ${video.codec_name} ${video.width}x${video.height} · ${fmt(duration)} · encoder ${encoder} · ${ladder.map((r) => r.name).join(', ')}`);
  await run(argv, duration, 'Encoding');

  // A 2h movie should give ~1800 four-second segments. If an encoder ignored the keyframe
  // settings we'd get a handful of giant segments — useless on slow networks — so redo on CPU.
  const segs = segmentCount(path.join(info.dir, ladder[ladder.length - 1].name, 'index.m3u8'));
  const expectedSegs = Math.floor(duration / 4);
  if (duration > 20 && segs < expectedSegs * 0.5) {
    if (encoder === 'libx264') throw new Error(`Only ${segs} segments were produced (expected ~${expectedSegs}).`);
    console.log(`  ⚠ ${encoder} ignored keyframe settings (${segs} segments, expected ~${expectedSegs}). Redoing with the CPU encoder…`);
    fs.rmSync(lock, { force: true });
    lockFile = null;
    return optimize(rel, 'libx264');
  }
  console.log(`  ${segs} segments per quality (4s each)`);

  // Embedded text subtitles -> WebVTT files
  const subs = [];
  const subStreams = meta.streams.filter((s) => s.codec_type === 'subtitle' && TEXT_SUBS.has(s.codec_name));
  for (const [i, s] of subStreams.entries()) {
    const fileName = `sub_${i}.vtt`;
    const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-map', `0:${s.index}`, '-c:s', 'webvtt', path.join(info.dir, fileName)]);
    if (r.status === 0) {
      const label = [s.tags?.title, s.tags?.language].filter(Boolean).join(' · ') || `Track ${i + 1}`;
      subs.push({ file: fileName, label });
    }
  }
  if (subs.length) console.log(`  Extracted ${subs.length} subtitle track(s)`);

  fs.writeFileSync(path.join(info.dir, 'ready.json'), JSON.stringify({
    source: input, duration, qualities: ladder.map((r) => r.name), subs, createdAt: new Date().toISOString(),
  }, null, 2));
  console.log('  ✓ Done');
}

(async () => {
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
      console.log(`  ✗ Failed: ${String(e.message).split('\n').slice(-4).join('\n    ')}`);
      if (encoder !== 'libx264') console.log('    Try again with:  npm run optimize -- --cpu');
    }
  }
  console.log('\nAll done. In the app, open Movies and tap refresh — the optimized version is used automatically.');
})();
