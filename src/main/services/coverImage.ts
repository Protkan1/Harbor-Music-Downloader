import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ffmpegCommand } from './tools';
import { killTree } from './processUtils';

/** Formats the renderer (Chromium) draws itself. */
export const BROWSER_IMAGES = ['png', 'jpg', 'jpeg', 'jfif', 'pjpeg', 'pjp', 'webp', 'avif', 'gif', 'bmp', 'ico', 'svg'];
/** Formats that go through ffmpeg first (phone photos, scans, ...). */
export const FFMPEG_IMAGES = ['heic', 'heif', 'tif', 'tiff', 'tga', 'jxl', 'jp2', 'j2k', 'dds', 'psd', 'exr', 'hdr', 'pcx', 'ppm', 'pgm', 'pbm', 'qoi', 'sgi', 'xbm', 'xwd'];

const MAX_INPUT = 60 * 1024 * 1024;

export type CoverImageResult = { data?: Uint8Array; mime?: string; error?: 'tooLarge' | 'unreadable'; canceled?: boolean };

/** What the bytes are, whatever the file is called (an iPhone ".jpg" is often HEIC). */
function sniff(b: Buffer): string | null {
  const ascii = (start: number, end: number) => b.subarray(start, end).toString('latin1');
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && ascii(1, 4) === 'PNG') return 'image/png';
  if (ascii(0, 4) === 'GIF8') return 'image/gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (ascii(0, 2) === 'BM') return 'image/bmp';
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return 'image/x-icon';
  if (ascii(4, 8) === 'ftyp' && /^avi[fs]$/.test(ascii(8, 12))) return 'image/avif';
  const head = ascii(0, 512).replace(/^﻿/, '').trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return 'image/svg+xml';
  return null;
}

/** Any picture → PNG (at most 1600 px) with the bundled ffmpeg. */
function convertWithFfmpeg(file: string): Promise<Buffer | null> {
  const out = path.join(os.tmpdir(), `harbor-cover-${process.pid}-${Date.now().toString(36)}.png`);
  return new Promise((resolve) => {
    const child = spawn(
      ffmpegCommand(),
      ['-v', 'error', '-y', '-i', file, '-frames:v', '1', '-vf', 'scale=w=1600:h=1600:force_original_aspect_ratio=decrease', out],
      { shell: false, windowsHide: true }
    );
    const timer = setTimeout(() => killTree(child), 60000);
    const finish = (ok: boolean) => {
      clearTimeout(timer);
      let data: Buffer | null = null;
      try {
        if (ok) data = fs.readFileSync(out);
      } catch {
        data = null;
      }
      fs.rm(out, { force: true }, () => {});
      resolve(data && data.length ? data : null);
    };
    child.on('error', () => finish(false));
    child.on('close', (code) => finish(code === 0));
  });
}

export async function readCoverImage(file: string): Promise<CoverImageResult> {
  let bytes: Buffer;
  try {
    if (fs.statSync(file).size > MAX_INPUT) return { error: 'tooLarge' };
    bytes = fs.readFileSync(file);
  } catch {
    return { error: 'unreadable' };
  }
  const mime = sniff(bytes);
  if (mime) return { data: new Uint8Array(bytes), mime };
  const png = await convertWithFfmpeg(file);
  return png ? { data: new Uint8Array(png), mime: 'image/png' } : { error: 'unreadable' };
}
