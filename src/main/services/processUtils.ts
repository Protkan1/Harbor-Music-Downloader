import { spawn, ChildProcess } from 'child_process';
import { StringDecoder } from 'string_decoder';
import { Readable } from 'stream';
import * as fs from 'fs';
import * as path from 'path';

/** Env for Python-based CLIs (yt-dlp, spotdl, tagger) so they emit UTF-8 on Windows. */
export const UTF8_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  PYTHONIOENCODING: 'utf-8',
  PYTHONUTF8: '1',
  PYTHONLEGACYWINDOWSSTDIO: 'utf-8',
};

/**
 * Calls onLine for every complete line. Chunks from a child process can split a line
 * (or a multi-byte UTF-8 char) in half, so we buffer until a line break. Carriage
 * returns are treated as line breaks too (progress bars redraw with "\r").
 */
export function readLines(stream: Readable, onLine: (line: string) => void): void {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  stream.on('data', (chunk: Buffer) => {
    buffer += decoder.write(chunk);
    const parts = buffer.split(/\r\n|\n|\r/);
    buffer = parts.pop() ?? '';
    for (const line of parts) {
      if (line.trim()) onLine(line.trimEnd());
    }
  });
  stream.on('end', () => {
    buffer += decoder.end();
    if (buffer.trim()) onLine(buffer.trimEnd());
    buffer = '';
  });
}

/**
 * Kills a process and all of its children. On Windows `child.kill()` only terminates
 * the direct child, leaving e.g. ffmpeg spawned by yt-dlp running, so use taskkill /T.
 */
export function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    killer.on('error', () => child.kill());
  } else {
    child.kill('SIGTERM');
  }
}

/** Runs a command and resolves true if it exits with code 0. Never rejects. */
export function commandSucceeds(cmd: string, args: string[], timeoutMs = 15000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (!settled) {
        settled = true;
        resolve(ok);
      }
    };
    try {
      const p = spawn(cmd, args, { shell: false, windowsHide: true, env: UTF8_ENV });
      const timer = setTimeout(() => {
        killTree(p);
        done(false);
      }, timeoutMs);
      p.on('error', () => {
        clearTimeout(timer);
        done(false);
      });
      p.on('close', (code) => {
        clearTimeout(timer);
        done(code === 0);
      });
    } catch {
      done(false);
    }
  });
}

export interface PythonCommand {
  cmd: string;
  /** Extra leading args, e.g. ['-3'] for the Windows `py` launcher. */
  prefix: string[];
}

let pythonCache: Promise<PythonCommand | null> | null = null;

/**
 * Finds a Python interpreter that has mutagen + Pillow installed (required by tagger.py).
 * Tries `python`, the Windows `py -3` launcher and `python3`. Result is cached.
 */
export function resolvePython(): Promise<PythonCommand | null> {
  if (!pythonCache) {
    pythonCache = (async () => {
      const candidates: PythonCommand[] = [
        { cmd: 'python', prefix: [] },
        { cmd: 'py', prefix: ['-3'] },
        { cmd: 'python3', prefix: [] },
      ];
      for (const c of candidates) {
        if (await commandSucceeds(c.cmd, [...c.prefix, '-c', 'import mutagen, PIL'])) {
          return c;
        }
      }
      return null;
    })();
    // Don't cache a miss: the user may install the packages while the app is open.
    pythonCache.then((found) => {
      if (!found) pythonCache = null;
    });
  }
  return pythonCache;
}

export interface SpotdlCommand {
  cmd: string;
  /** Arguments that go before spotdl's own (the wrapper script) */
  prefix: string[];
}

let spotdlCache: Promise<SpotdlCommand> | null = null;

/**
 * How to run spotdl. Preferably through scripts/spotdl_fast.py with the very Python that
 * spotdl is installed in (found next to spotdl.exe): the wrapper makes Spotify lookups
 * ~3x faster. Anything unexpected (no wrapper, another layout, import fails) falls back to
 * the plain `spotdl` command, exactly as before. Cached; a fallback is retried next time.
 */
export function resolveSpotdl(wrapperPath: string): Promise<SpotdlCommand> {
  const plain: SpotdlCommand = { cmd: 'spotdl', prefix: [] };
  if (!spotdlCache) {
    spotdlCache = (async () => {
      if (!fs.existsSync(wrapperPath)) return plain;
      const exe = await findOnPath(process.platform === 'win32' ? 'spotdl.exe' : 'spotdl');
      if (!exe) return plain;
      // <Python>\Scripts\spotdl.exe → <Python>\python.exe ; <venv>/bin/spotdl → <venv>/bin/python
      const candidates =
        process.platform === 'win32'
          ? [path.join(path.dirname(path.dirname(exe)), 'python.exe'), path.join(path.dirname(exe), 'python.exe')]
          : [path.join(path.dirname(exe), 'python3'), path.join(path.dirname(exe), 'python')];
      for (const py of candidates) {
        if (!fs.existsSync(py)) continue;
        if (await commandSucceeds(py, ['-I', '-c', 'import spotdl.console, spotapi.client'], 30000)) {
          return { cmd: py, prefix: ['-I', '-X', 'utf8', wrapperPath] };
        }
      }
      return plain;
    })();
    spotdlCache.then((c) => {
      if (c.cmd === 'spotdl') spotdlCache = null;
    });
  }
  return spotdlCache;
}

async function findOnPath(name: string): Promise<string | null> {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    const full = path.join(d, name);
    try {
      if (fs.statSync(full).isFile()) return full;
    } catch { /* not here */ }
  }
  return null;
}

/**
 * Runs yt-dlp with the given args (expects -J / --dump-single-json) and parses stdout.
 * Never rejects; on failure `error` holds yt-dlp's last "ERROR:" line.
 */
export function runYtDlpJson(args: string[], timeoutMs = 90000): Promise<{ json: any | null; error?: string }> {
  return new Promise((resolve) => {
    let proc: ChildProcess;
    try {
      proc = spawn('yt-dlp', args, { shell: false, windowsHide: true, env: UTF8_ENV });
    } catch (err: any) {
      resolve({ json: null, error: err?.message });
      return;
    }
    const out: Buffer[] = [];
    let stderr = '';
    const timer = setTimeout(() => killTree(proc), timeoutMs);
    proc.stdout!.on('data', (d: Buffer) => out.push(d));
    proc.stderr!.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ json: null, error: err.message });
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      const errLine = stderr
        .split(/\r?\n/)
        .find((l) => l.startsWith('ERROR:'))
        ?.replace(/^ERROR:\s*/, '');
      const stdout = Buffer.concat(out).toString('utf8');
      if (code === 0 && stdout) {
        try {
          return resolve({ json: JSON.parse(stdout) });
        } catch (e) {
          console.error('Failed to parse yt-dlp JSON:', e);
        }
      } else if (stderr) {
        console.error('yt-dlp failed:', stderr.trim().slice(-500));
      }
      resolve({ json: null, error: errLine });
    });
  });
}
