import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { LibraryItem } from '../../shared/types';
import { UTF8_ENV, readLines, resolvePython, scriptPath } from './processUtils';

export const AUDIO_EXTS = new Set(['.mp3', '.m4a', '.aac', '.flac', '.wav', '.ogg', '.opus', '.oga', '.webm', '.mp4', '.m4b', '.aiff', '.aif']);
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mkv', '.mov']);
const MAX_FILES = 20000;

export interface LocalEntry {
  path: string;
  title?: string;
  artist?: string;
  duration?: number;
}

export interface LocalSource {
  name: string;
  entries: LocalEntry[];
}

// ─────────────────────────────── Playlist files ───────────────────────────────

function readText(file: string): string {
  const buf = fs.readFileSync(file);
  // Apple Music's "Text" export is UTF-16 LE with a BOM
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf[0] === 0xfe && buf[1] === 0xff) return Buffer.from(buf.subarray(2)).swap16().toString('utf16le');
  const utf8 = buf.toString('utf8').replace(/^\uFEFF/, '');
  // Old .m3u files are often ANSI: fall back when UTF-8 decoding produced replacement chars
  return utf8.includes('\uFFFD') ? buf.toString('latin1') : utf8;
}

/** A path from a playlist line: absolute, relative to the playlist, or a file:// URL. */
function resolveEntryPath(raw: string, baseDir: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  if (/^file:/i.test(s)) {
    try {
      // iTunes writes file://localhost/C:/...
      return fileURLToPath(s.replace(/^file:\/\/localhost\//i, 'file:///'));
    } catch {
      return null;
    }
  }
  if (/^[a-z]+:\/\//i.test(s)) return null; // http streams etc.
  return path.isAbsolute(s) ? path.normalize(s) : path.resolve(baseDir, s);
}

function splitArtistTitle(s: string): { artist?: string; title: string } {
  const i = s.indexOf(' - ');
  return i > 0 ? { artist: s.slice(0, i).trim(), title: s.slice(i + 3).trim() } : { title: s.trim() };
}

function parseM3U(file: string): LocalSource {
  const dir = path.dirname(file);
  const entries: LocalEntry[] = [];
  let pending: Partial<LocalEntry> = {};
  for (const line of readText(file).split(/\r?\n/)) {
    const l = line.trim();
    if (!l) continue;
    if (l.startsWith('#EXTINF:')) {
      const m = l.match(/^#EXTINF:(-?\d+(?:\.\d+)?)[^,]*,(.*)$/);
      if (m) {
        const d = parseFloat(m[1]);
        pending = { duration: d > 0 ? Math.round(d) : undefined, ...splitArtistTitle(m[2]) };
      }
      continue;
    }
    if (l.startsWith('#')) continue;
    const p = resolveEntryPath(l, dir);
    if (p) entries.push({ path: p, ...pending });
    pending = {};
  }
  return { name: path.parse(file).name, entries };
}

function parsePLS(file: string): LocalSource {
  const dir = path.dirname(file);
  const files = new Map<number, LocalEntry>();
  for (const line of readText(file).split(/\r?\n/)) {
    const m = line.match(/^(File|Title|Length)(\d+)=(.*)$/i);
    if (!m) continue;
    const n = parseInt(m[2], 10);
    const e = files.get(n) ?? ({ path: '' } as LocalEntry);
    const key = m[1].toLowerCase();
    if (key === 'file') e.path = resolveEntryPath(m[3], dir) ?? '';
    else if (key === 'title') Object.assign(e, splitArtistTitle(m[3]));
    else if (key === 'length' && parseInt(m[3], 10) > 0) e.duration = parseInt(m[3], 10);
    files.set(n, e);
  }
  return { name: path.parse(file).name, entries: [...files.entries()].sort((a, b) => a[0] - b[0]).map(([, e]) => e).filter((e) => e.path) };
}

/** iTunes / Apple Music XML (a plist): the tracks dict plus the first real playlist's order. */
function parseITunesXML(file: string): LocalSource {
  const xml = readText(file);
  const unescape = (s: string) =>
    s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&amp;/g, '&');
  const field = (block: string, key: string) => {
    const m = block.match(new RegExp(`<key>${key}</key>\\s*<(?:string|integer)>([^<]*)</(?:string|integer)>`));
    return m ? unescape(m[1]) : undefined;
  };

  const tracks = new Map<string, LocalEntry>();
  const tracksStart = xml.indexOf('<key>Tracks</key>');
  const playlistsStart = xml.indexOf('<key>Playlists</key>');
  const tracksXml = xml.slice(tracksStart, playlistsStart > 0 ? playlistsStart : undefined);
  for (const m of tracksXml.matchAll(/<key>(\d+)<\/key>\s*<dict>([\s\S]*?)<\/dict>/g)) {
    const loc = field(m[2], 'Location');
    const p = loc ? resolveEntryPath(loc, path.dirname(file)) : null;
    if (!p) continue;
    const time = field(m[2], 'Total Time');
    tracks.set(m[1], {
      path: p,
      title: field(m[2], 'Name'),
      artist: field(m[2], 'Artist'),
      duration: time ? Math.round(parseInt(time, 10) / 1000) : undefined,
    });
  }

  let name = path.parse(file).name;
  let order: string[] = [];
  if (playlistsStart > 0) {
    for (const m of xml.slice(playlistsStart).matchAll(/<dict>\s*<key>Name<\/key>\s*<string>([^<]*)<\/string>([\s\S]*?)<\/array>/g)) {
      if (/<key>Master<\/key>\s*<true\/>|<key>Distinguished Kind<\/key>/.test(m[2])) continue;
      const ids = [...m[2].matchAll(/<key>Track ID<\/key>\s*<integer>(\d+)<\/integer>/g)].map((x) => x[1]);
      if (ids.length) {
        name = unescape(m[1]);
        order = ids;
        break;
      }
    }
  }
  const entries = (order.length ? order.map((id) => tracks.get(id)) : [...tracks.values()]).filter(Boolean) as LocalEntry[];
  return { name, entries };
}

/**
 * Apple Music / iTunes "Text" export: tab-separated, first row headers (localised: "Name" may
 * be "Ad"), so the location column is found by its values (paths), not by its title.
 */
function parseTabText(file: string): LocalSource {
  const rows = readText(file).split(/\r?\n|\r/).filter((r) => r.trim()).map((r) => r.split('\t'));
  if (rows.length < 2) return { name: path.parse(file).name, entries: [] };
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const body = rows.slice(1);
  const isPath = (v?: string) => !!v && (/^[a-z]:[\\/]/i.test(v) || /^\\\\/.test(v) || /^file:/i.test(v));
  const locCol = header.findIndex((_, i) => body.slice(0, 20).filter((r) => isPath(r[i])).length >= Math.min(3, body.length));
  if (locCol < 0) return { name: path.parse(file).name, entries: [] };
  const col = (...names: string[]) => header.findIndex((h) => names.includes(h));
  const nameCol = col('name', 'ad', 'adı', 'şarkı', 'title');
  const artistCol = col('artist', 'sanatçı');
  const timeCol = col('time', 'süre');
  const entries: LocalEntry[] = [];
  for (const r of body) {
    const p = resolveEntryPath(r[locCol] ?? '', path.dirname(file));
    if (!p) continue;
    const t = timeCol >= 0 ? parseInt(r[timeCol], 10) : NaN;
    entries.push({
      path: p,
      title: nameCol >= 0 ? r[nameCol]?.trim() || undefined : undefined,
      artist: artistCol >= 0 ? r[artistCol]?.trim() || undefined : undefined,
      duration: isFinite(t) && t > 0 ? t : undefined,
    });
  }
  return { name: path.parse(file).name, entries };
}

export function parsePlaylistFile(file: string): LocalSource {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.m3u' || ext === '.m3u8') return parseM3U(file);
  if (ext === '.pls') return parsePLS(file);
  if (ext === '.xml') return parseITunesXML(file);
  if (ext === '.txt') return parseTabText(file);
  throw new Error(`unsupported playlist type: ${ext}`);
}

/** Every audio file under `dir`, sorted by path. */
export function scanFolder(dir: string): LocalSource {
  const out: LocalEntry[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 8 || out.length >= MAX_FILES) return;
    let names: fs.Dirent[] = [];
    try {
      names = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const n of names) {
      const full = path.join(d, n.name);
      if (n.isDirectory()) walk(full, depth + 1);
      else if (AUDIO_EXTS.has(path.extname(n.name).toLowerCase())) out.push({ path: full });
      if (out.length >= MAX_FILES) return;
    }
  };
  walk(dir, 0);
  out.sort((a, b) => a.path.localeCompare(b.path));
  return { name: path.basename(dir), entries: out };
}

// ─────────────────────────────── Tags & covers ───────────────────────────────

interface ScanItem {
  path: string;
  title: string | null;
  artist: string | null;
  album: string | null;
  duration: number | null;
  cover: string | null;
}

/**
 * Turns local entries into library items: real tags, length and a cover thumbnail from each
 * file (scripts/scan_media.py), falling back to the playlist's own names or the file name.
 */
export async function toLibraryItems(
  entries: LocalEntry[],
  coversDir: string,
  onProgress: (done: number, total: number) => void
): Promise<{ items: LibraryItem[]; missing: number }> {
  const existing = entries.filter((e) => fs.existsSync(e.path));
  const missing = entries.length - existing.length;
  const scanned = new Map<string, ScanItem>();

  const python = await resolvePython();
  if (python && existing.length) {
    const script = scriptPath('scan_media.py');
    const listFile = path.join(os.tmpdir(), `aura-scan-${Date.now()}.json`);
    fs.writeFileSync(listFile, JSON.stringify(existing.map((e) => e.path)), 'utf-8');
    await new Promise<void>((resolve) => {
      const p = spawn(python.cmd, [...python.prefix, '-I', '-X', 'utf8', script, listFile, coversDir], {
        shell: false,
        windowsHide: true,
        env: UTF8_ENV,
      });
      readLines(p.stdout!, (l) => {
        if (l.startsWith('__ITEM__ ')) {
          try {
            const it: ScanItem = JSON.parse(l.slice(9));
            scanned.set(it.path, it);
          } catch {
            /* ignore */
          }
        } else if (l.startsWith('__PROG__ ')) {
          const [d, t] = l.slice(9).split('/').map(Number);
          onProgress(d, t);
        }
      });
      readLines(p.stderr!, (l) => console.error('[scan_media]', l));
      p.on('error', () => resolve());
      p.on('close', () => resolve());
    });
    fs.rm(listFile, { force: true }, () => {});
  }

  const items: LibraryItem[] = existing.map((e) => {
    const s = scanned.get(e.path);
    const fromName = splitArtistTitle(path.parse(e.path).name.replace(/\s*\[[A-Za-z0-9_-]{11}\]$/, ''));
    const ext = path.extname(e.path).toLowerCase();
    return {
      id: '',
      title: s?.title || e.title || fromName.title,
      artist: s?.artist || e.artist || fromName.artist,
      duration: s?.duration ?? e.duration,
      thumbnail: s?.cover ? pathToFileURL(s.cover).href : undefined,
      url: '',
      filePath: e.path,
      source: 'local',
      isVideo: VIDEO_EXTS.has(ext) && ext !== '.mp4' ? true : false,
    };
  });
  return { items, missing };
}
