import * as fs from 'fs';
import * as path from 'path';
import { UTF8_ENV } from './processUtils';

/**
 * Where Harbor's external tools come from.
 *
 * An installed Harbor carries everything itself (resources/engine and resources/ffmpeg):
 *   - harbor-engine.exe: a frozen Python with yt-dlp, spotDL, mutagen and Pillow, plus the
 *     tagger / scanner scripts (see engine/harbor_engine.py), and
 *   - an LGPL ffmpeg/ffprobe build.
 * In development the same folders are read from vendor/ (npm run build:engine). If neither
 * exists, the tools installed on the system (PATH) are used, as before.
 */
export interface ToolCommand {
  cmd: string;
  /** Arguments that come before the tool's own (the engine's subcommand) */
  prefix: string[];
}

function firstExisting(candidates: string[]): string | undefined {
  return candidates.find((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
}

function bundleRoots(): string[] {
  return [
    process.resourcesPath ?? '',
    path.resolve(__dirname, '../../../vendor'), // dist/main/services → <project>/vendor
  ].filter(Boolean);
}

const exe = process.platform === 'win32' ? '.exe' : '';
export const ENGINE_PATH = firstExisting(bundleRoots().map((r) => path.join(r, 'engine', `harbor-engine${exe}`)));
export const FFMPEG_DIR = (() => {
  const f = firstExisting(bundleRoots().map((r) => path.join(r, 'ffmpeg', `ffmpeg${exe}`)));
  return f ? path.dirname(f) : undefined;
})();

/** True when the app runs on its own bundled tools (nothing has to be installed). */
export const isBundled = (): boolean => !!ENGINE_PATH;

let ytdlpZip = '';

/**
 * Call once at start-up. Puts the bundled ffmpeg first on PATH for every child process
 * (yt-dlp and spotDL both look it up there) and tells the engine where an updated yt-dlp
 * lives (UpdateService downloads it into <userData>/tools).
 */
export function initTools(userDataDir: string) {
  ytdlpZip = path.join(userDataDir, 'tools', 'yt-dlp.zip');
  if (FFMPEG_DIR) {
    const key = Object.keys(UTF8_ENV).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
    UTF8_ENV[key] = FFMPEG_DIR + path.delimiter + (UTF8_ENV[key] ?? '');
  }
  if (ENGINE_PATH) UTF8_ENV.HARBOR_YTDLP_ZIP = ytdlpZip;
}

/** <userData>/tools/yt-dlp.zip: the updated yt-dlp the engine prefers over its own copy. */
export const updatedYtDlpZip = () => ytdlpZip;

export function ytdlpCommand(): ToolCommand {
  return ENGINE_PATH ? { cmd: ENGINE_PATH, prefix: ['yt-dlp'] } : { cmd: 'yt-dlp', prefix: [] };
}

export function ffmpegCommand(): string {
  return FFMPEG_DIR ? path.join(FFMPEG_DIR, `ffmpeg${exe}`) : 'ffmpeg';
}

/** The engine's own subcommand (spotdl / tagger / scan / selftest), or null when not bundled. */
export function engineCommand(sub: 'spotdl' | 'tagger' | 'scan' | 'selftest'): ToolCommand | null {
  return ENGINE_PATH ? { cmd: ENGINE_PATH, prefix: [sub] } : null;
}
