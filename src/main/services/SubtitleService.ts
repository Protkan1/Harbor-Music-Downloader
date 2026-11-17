import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { SubtitleTrack } from '../../shared/types';
import { UTF8_ENV, killTree, readLines } from './processUtils';
import { ytdlpCommand } from './tools';

const CACHE_MAX = 40;

/**
 * Subtitles for the watch page as WebVTT text (the renderer turns it into a blob <track>).
 *
 * YouTube's timedtext URLs need a session token when fetched directly (HTTP 429), so yt-dlp
 * downloads them. Its machine-translated tracks ("tlang") are often refused the same way for
 * clients without an account; then the original track is translated here instead, cue by cue,
 * keeping every timestamp.
 */
export class SubtitleService {
  private cache = new Map<string, string>();

  public async get(url: string, track: SubtitleTrack): Promise<{ success: boolean; vtt?: string; error?: string }> {
    const key = `${url}|${track.kind}|${track.lang}`;
    const hit = this.cache.get(key);
    if (hit) return { success: true, vtt: hit };

    let res: { vtt?: string; error?: string };
    if (track.kind === 'translated') {
      // YouTube's own translations ("tlang") answer 429 to clients without an account and
      // yt-dlp's retries make that a 40 s wait — translate the original track ourselves
      if (!track.source) return { success: false, error: 'no source track' };
      const src = await this.download(url, escapeLang(track.source), !!track.sourceAuto);
      if (!src.vtt) return { success: false, error: src.error };
      try {
        res = { vtt: await translateVtt(src.vtt, track.lang) };
      } catch (err: any) {
        res = { error: err?.message ?? String(err) };
      }
    } else {
      res = await this.download(url, escapeLang(track.lang), track.kind === 'auto');
    }
    if (!res.vtt) return { success: false, error: res.error };
    const vtt = cleanVtt(res.vtt);
    this.cache.set(key, vtt);
    if (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
    return { success: true, vtt };
  }

  /** yt-dlp --skip-download into a temp folder; returns the first .vtt written. */
  private download(url: string, langs: string, auto: boolean): Promise<{ vtt?: string; error?: string }> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-subs-'));
    const args = [
      '--skip-download',
      auto ? '--write-auto-subs' : '--write-subs',
      '--sub-langs', langs,
      '--sub-format', 'vtt',
      '--no-playlist',
      '--no-warnings',
      '-o', path.join(dir, 'sub.%(ext)s'),
      url,
    ];
    return new Promise((resolve) => {
      let error = '';
      const yt = ytdlpCommand();
      const p = spawn(yt.cmd, [...yt.prefix, ...args], { shell: false, windowsHide: true, env: UTF8_ENV });
      const timer = setTimeout(() => killTree(p), 45000);
      readLines(p.stdout!, () => {});
      readLines(p.stderr!, (l) => {
        if (l.startsWith('ERROR:')) error = l.replace(/^ERROR:\s*/, '');
      });
      const finish = () => {
        clearTimeout(timer);
        let vtt: string | undefined;
        try {
          const file = fs.readdirSync(dir).find((f) => f.endsWith('.vtt'));
          if (file) vtt = fs.readFileSync(path.join(dir, file), 'utf-8');
        } catch {
          /* none */
        }
        fs.rm(dir, { recursive: true, force: true }, () => {});
        resolve(vtt ? { vtt } : { error: error || 'no subtitles' });
      };
      p.on('error', (err) => {
        error = err.message;
        finish();
      });
      p.on('close', finish);
    });
  }
}

/**
 * --sub-langs takes regexes: anchor so "en" doesn't also pull "en-orig", "en-GB"… Keys are
 * validated as [A-Za-z0-9_-] at the IPC boundary, so nothing else needs escaping.
 */
function escapeLang(lang: string): string {
  return `^${lang}$`;
}

/**
 * YouTube's speech-recognition VTT carries word-timing tags (<00:00:01.200><c> word</c>) and
 * "rolling" cues that repeat the previous line. Strip the tags and the repeated line so each
 * cue shows what is new, which also halves the text to translate.
 */
export function cleanVtt(vtt: string): string {
  const blocks = vtt.replace(/\r/g, '').split(/\n\n+/);
  const out: string[] = [];
  let lastLine = '';
  for (const block of blocks) {
    const lines = block.split('\n');
    const timeIdx = lines.findIndex((l) => l.includes('-->'));
    if (timeIdx < 0) {
      if (/^WEBVTT/.test(block)) out.push('WEBVTT');
      continue;
    }
    const timing = lines[timeIdx].replace(/\s+(align|position|line|size):\S+/g, '');
    const text = lines
      .slice(timeIdx + 1)
      .map((l) => l.replace(/<[^>]+>/g, '').trim())
      .filter((l) => l && l !== lastLine);
    if (!text.length) continue;
    lastLine = text[text.length - 1];
    out.push(`${timing}\n${text.join('\n')}`);
  }
  if (out[0] !== 'WEBVTT') out.unshift('WEBVTT');
  return out.join('\n\n') + '\n';
}

/** Translates cue texts in batches through Google's public translate endpoint, keeping timings. */
async function translateVtt(vtt: string, target: string): Promise<string> {
  const cleaned = cleanVtt(vtt);
  const blocks = cleaned.split('\n\n').slice(1).filter(Boolean);
  const cues = blocks.map((b) => {
    const [timing, ...text] = b.split('\n');
    return { timing, text: text.join(' ').replace(/\s+/g, ' ').trim() };
  });

  const translated: string[] = new Array(cues.length);
  let i = 0;
  while (i < cues.length) {
    // Batches of up to ~3500 characters, one cue per line
    let j = i;
    let len = 0;
    while (j < cues.length && len + cues[j].text.length < 3500) len += cues[j++].text.length + 1;
    if (j === i) j = i + 1;
    const lines = await translateLines(cues.slice(i, j).map((c) => c.text), target);
    for (let k = i; k < j; k++) translated[k] = lines[k - i] ?? cues[k].text;
    i = j;
  }
  return 'WEBVTT\n\n' + cues.map((c, k) => `${c.timing}\n${translated[k]}`).join('\n\n') + '\n';
}

async function translateLines(lines: string[], target: string): Promise<string[]> {
  const tl = target === 'zh-Hans' ? 'zh-CN' : target;
  const body = new URLSearchParams({ q: lines.join('\n') });
  const res = await fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(tl)}&dt=t`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body,
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`translate HTTP ${res.status}`);
  const data: any = await res.json();
  // data[0] = [[translated, source, ...], ...] — segments may split or merge lines; rejoin, then split on \n
  const text = (data?.[0] ?? []).map((seg: any[]) => seg?.[0] ?? '').join('');
  const out = text.split('\n').map((s: string) => s.trim());
  return out.length === lines.length ? out : lines.map((l, i) => out[i] ?? l);
}
