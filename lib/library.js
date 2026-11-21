// Shared movie-library helpers used by the server and the optimizer.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const PREPARED_DIR = path.join(ROOT, 'prepared');
const VIDEO_EXT = new Set(['.mp4', '.m4v', '.webm', '.mkv', '.mov', '.avi', '.ogv']);
const SUB_EXT = new Set(['.srt', '.vtt']);

// Resolve the movies folder (or single file) from a CLI argument.
function resolveLibrary(pathArg) {
  let dir = path.join(ROOT, 'movies');
  let file = null;
  if (pathArg) {
    const p = path.resolve(pathArg);
    if (!fs.existsSync(p)) {
      // Don't silently create a folder named after a mistyped file, or fail on an unplugged drive.
      console.log(`\n⚠  Not found: ${p}\n   Check the path (put it in "quotes" if it has spaces), or plug the drive in.\n`);
      process.exit(1);
    }
    if (fs.statSync(p).isFile()) {
      dir = path.dirname(p);
      file = path.basename(p);
    } else {
      dir = p;
    }
  } else {
    fs.mkdirSync(dir, { recursive: true });
  }
  return { dir, file };
}

const toId = (rel) => rel.split(path.sep).join('/');

function safeResolve(base, rel) {
  const abs = path.resolve(base, rel);
  const root = base.endsWith(path.sep) ? base : base + path.sep; // a drive root like "E:\" already ends in one
  if (abs !== base && !abs.startsWith(root)) return null;
  return abs;
}

// All files under `dir` (relative paths), up to a few folders deep. Unreadable folders (e.g.
// "System Volume Information" at a drive root) are skipped instead of hiding the whole library,
// as are hidden/system folders. Capped, so pointing it at a whole drive can't stall the server.
const WALK_LIMIT = 20000;
function walk(dir, depth = 4, rel = '', out = []) {
  let entries;
  try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (out.length >= WALK_LIMIT) break;
    if (e.name.startsWith('.') || e.name.startsWith('$') || e.name === 'System Volume Information') continue;
    const r = rel ? path.join(rel, e.name) : e.name;
    if (e.isFile()) out.push(r);
    else if (e.isDirectory() && depth > 0) walk(dir, depth - 1, r, out);
  }
  return out;
}

// Folder that holds the adaptive (HLS) version of a movie.
function preparedKey(absFile) {
  const name = path.basename(absFile, path.extname(absFile)).replace(/[^a-z0-9]+/gi, '-').slice(0, 40);
  const hash = crypto.createHash('sha1').update(absFile.toLowerCase()).digest('hex').slice(0, 8);
  return `${name}-${hash}`;
}

function preparedInfo(absFile) {
  const key = preparedKey(absFile);
  const dir = path.join(PREPARED_DIR, key);
  const done = path.join(dir, 'ready.json');
  if (!fs.existsSync(done)) return { key, dir, ready: false };
  try {
    return { key, dir, ready: true, ...JSON.parse(fs.readFileSync(done, 'utf8')) };
  } catch {
    return { key, dir, ready: false };
  }
}

// "Rab.Ne.Bana.Di.Jodi.(2008).1080p.BluRay.x265-GRP" -> "Rab Ne Bana Di Jodi (2008)"
const RELEASE_TAGS = /\b(2160p|1440p|1080p|720p|576p|480p|4k|uhd|hdr10?|dv|bluray|blu ray|brrip|bdrip|remux|web ?dl|webrip|web|hdrip|dvdrip|dvdscr|hdtv|hdcam|camrip|x26[45]|h ?26[45]|hevc|avc|xvid|10 ?bit|8 ?bit|aac|ac3|eac3|dts|ddp?|truehd|atmos|5 1|7 1|2 0|proper|repack|remastered|imax|extended|unrated|directors cut|dual audio|multi|esub|esubs|hindi|english)\b/i;
function cleanTitle(base) {
  const s = base.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
  const paren = s.match(/^(.+?)\s*[([]((?:19|20)\d{2})[)\]]/);
  if (paren) return `${paren[1].trim()} (${paren[2]})`;
  const tag = s.search(RELEASE_TAGS);
  let head = (tag > 0 ? s.slice(0, tag) : s).replace(/[\s\-[(]+$/, '').trim();
  const yr = head.match(/^(.+?)\s+((?:19|20)\d{2})$/);
  if (yr) head = `${yr[1]} (${yr[2]})`;
  return head || s;
}

function listMovies(dir) {
  const files = walk(dir);
  const subs = files.filter((f) => SUB_EXT.has(path.extname(f).toLowerCase()));

  const movies = [];
  for (const f of files.filter((x) => VIDEO_EXT.has(path.extname(x).toLowerCase()))) {
    const abs = path.join(dir, f);
    let size;
    try { size = fs.statSync(abs).size; } catch { continue; } // deleted/renamed while we were listing
    const base = f.slice(0, -path.extname(f).length);
    const prep = preparedInfo(abs);
    // "Movie.srt", "Movie.en.srt", "Movie - English.srt" belong to Movie.mkv; "Movie 2.srt" does not.
    const tracks = subs
      .filter((s) => s.startsWith(base) && /^(?:$|[._]|\s*-)/.test(s.slice(base.length, -path.extname(s).length)))
      .map((s) => ({
        src: `/subs/${toId(s).split('/').map(encodeURIComponent).join('/')}`,
        label: s.slice(base.length, -path.extname(s).length).replace(/^[._\s-]+/, '') || 'Subtitles',
      }));
    // Each optimize run writes a new build folder, so a re-optimized movie gets brand-new URLs.
    // (Older builds, from before build folders, sit directly in the movie's folder.)
    const hlsBase = prep.ready ? `/hls/${prep.key}${prep.build ? `/${prep.build}` : ''}` : null;
    if (prep.ready && Array.isArray(prep.subs)) {
      for (const s of prep.subs) tracks.push({ src: `${hlsBase}/${s.file}`, label: s.label });
    }
    movies.push({
      id: toId(f),
      name: cleanTitle(path.basename(base)),
      ext: path.extname(f).slice(1).toLowerCase(),
      size,
      duration: prep.duration || null,
      hls: prep.ready ? `${hlsBase}/master.m3u8` : null,
      qualities: prep.ready ? prep.qualities : null,
      subs: tracks,
    });
  }
  return movies.sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = { PREPARED_DIR, VIDEO_EXT, SUB_EXT, resolveLibrary, safeResolve, preparedInfo, listMovies, toId };
