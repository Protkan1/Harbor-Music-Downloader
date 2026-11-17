import { spawn } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { UpdateStatus } from '../../shared/types';
import { SettingsService } from './SettingsService';
import { UTF8_ENV, readLines } from './processUtils';
import { isBundled, updatedYtDlpZip, ytdlpCommand } from './tools';

const CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000; // auto-check at most twice a day
const RELEASES_URL = 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest';
const DOWNLOAD_BASE = 'https://github.com/yt-dlp/yt-dlp/releases/download';

type InstallMethod = 'pip' | 'standalone' | 'unknown';

/** Runs a command and returns its exit code and combined output. Never rejects. */
function run(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(cmd, args, { shell: false, windowsHide: true, env: UTF8_ENV });
    } catch (err: any) {
      resolve({ code: null, out: String(err?.message ?? err) });
      return;
    }
    const timer = setTimeout(() => child.kill(), timeoutMs);
    readLines(child.stdout!, (l) => (out += l + '\n'));
    readLines(child.stderr!, (l) => (out += l + '\n'));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: null, out: out + err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

/** "2026.10.26" vs "2026.11.02.1" → negative / 0 / positive */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Keeps yt-dlp current. YouTube changes often and an old yt-dlp is the most common reason
 * downloads suddenly fail, so the app checks GitHub's latest release and updates with the
 * same tool that installed yt-dlp (pip, or the standalone binary's own `-U`).
 */
export class UpdateService {
  private status: UpdateStatus = { state: 'idle' };
  private listeners = new Set<(s: UpdateStatus) => void>();
  private busy: Promise<UpdateStatus> | null = null;

  constructor(
    private settings: SettingsService,
    private isIdle: () => boolean
  ) {}

  public onChange(listener: (s: UpdateStatus) => void) {
    this.listeners.add(listener);
  }

  public getStatus(): UpdateStatus {
    return { ...this.status };
  }

  private set(patch: Partial<UpdateStatus>) {
    this.status = { ...this.status, ...patch };
    for (const l of this.listeners) l(this.getStatus());
  }

  /** Call once after start-up. Checks (and, if enabled, updates) without blocking anything. */
  public scheduleAutoCheck() {
    setTimeout(() => this.autoCheck(), 8000);
  }

  private async autoCheck() {
    const s = this.settings.getSettings();
    if (Date.now() - (s.lastYtDlpCheck || 0) < CHECK_INTERVAL_MS) {
      // Still report the installed version so the settings panel isn't empty
      this.check(false);
      return;
    }
    const status = await this.check(true);
    if (status.updateAvailable && s.autoUpdateYtDlp !== false) {
      // Never swap the binary under a running download: wait until the queue is empty (max 30 min)
      for (let i = 0; i < 30 && !this.isIdle(); i++) await new Promise((r) => setTimeout(r, 60000));
      if (this.isIdle()) await this.update();
    }
  }

  public check(remote = true): Promise<UpdateStatus> {
    if (this.busy) return this.busy;
    this.busy = (async () => {
      this.set({ state: 'checking', error: undefined });
      const current = await this.currentVersion();
      let latest = this.status.latest;
      if (remote) {
        latest = (await this.latestVersion()) ?? latest;
        this.settings.saveSettings({ lastYtDlpCheck: Date.now() });
      }
      this.set({
        state: 'idle',
        current: current ?? undefined,
        latest,
        updateAvailable: !!(current && latest && compareVersions(latest, current) > 0),
        installed: current !== null,
        checkedAt: remote ? Date.now() : this.status.checkedAt,
      });
      return this.getStatus();
    })().finally(() => (this.busy = null));
    return this.busy;
  }

  public update(): Promise<UpdateStatus> {
    if (this.busy) return this.busy;
    this.busy = (async () => {
      const before = await this.currentVersion();
      this.set({ state: 'updating', error: undefined });
      let result: { code: number | null; out: string };
      const { method, python } = isBundled() ? { method: 'bundled' as const, python: undefined } : await this.installMethod();
      if (method === 'bundled') {
        result = await this.updateBundled();
      } else if (method === 'pip' && python) {
        result = await run(python, ['-m', 'pip', 'install', '--upgrade', '--disable-pip-version-check', 'yt-dlp'], 300000);
      } else {
        result = await run('yt-dlp', ['-U'], 300000);
        // A pip/winget install refuses -U and says how to update instead
        if (/pip/i.test(result.out) && /install|update/i.test(result.out)) {
          result = await run('python', ['-m', 'pip', 'install', '--upgrade', '--disable-pip-version-check', 'yt-dlp'], 300000);
        }
      }
      const after = await this.currentVersion();
      const changed = !!(after && before !== after);
      const ok = result.code === 0 || changed;
      const lastLine = result.out.trim().split('\n').filter(Boolean).pop();
      this.set({
        state: ok ? 'updated' : 'failed',
        current: after ?? before ?? undefined,
        updateAvailable: !!(after && this.status.latest && compareVersions(this.status.latest, after) > 0),
        previous: changed ? before ?? undefined : undefined,
        error: ok ? undefined : lastLine || `exit code ${result.code}`,
      });
      return this.getStatus();
    })().finally(() => (this.busy = null));
    return this.busy;
  }

  /**
   * Bundled Harbor: download the official pure-Python yt-dlp zip of the latest release,
   * check it against the release's SHA2-256SUMS, make sure it runs, then put it where the
   * engine looks first. A bad download never replaces a working one.
   */
  private async updateBundled(): Promise<{ code: number | null; out: string }> {
    const tag = this.status.latest ?? (await this.latestVersion());
    if (!tag) return { code: 1, out: 'Could not reach GitHub' };
    const target = updatedYtDlpZip();
    const tmp = target + '.download';
    try {
      const get = async (url: string) => {
        const res = await fetch(url, { headers: { 'User-Agent': 'Harbor' }, signal: AbortSignal.timeout(120000) });
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
        return Buffer.from(await res.arrayBuffer());
      };
      const [zip, sums] = await Promise.all([get(`${DOWNLOAD_BASE}/${tag}/yt-dlp`), get(`${DOWNLOAD_BASE}/${tag}/SHA2-256SUMS`)]);
      const expected = sums
        .toString('utf8')
        .split('\n')
        .map((l) => l.trim().split(/\s+/))
        .find((p) => p[1] === 'yt-dlp')?.[0];
      const actual = createHash('sha256').update(zip).digest('hex');
      if (!expected || expected.toLowerCase() !== actual) return { code: 1, out: 'Checksum mismatch, update discarded' };

      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(tmp, zip);
      // Try the new copy before trusting it
      const yt = ytdlpCommand();
      const probe = await new Promise<{ code: number | null; out: string }>((resolve) => {
        let out = '';
        const child = spawn(yt.cmd, [...yt.prefix, '--version'], {
          shell: false,
          windowsHide: true,
          env: { ...UTF8_ENV, HARBOR_YTDLP_ZIP: tmp },
        });
        readLines(child.stdout!, (l) => (out += l + '\n'));
        child.on('error', (e) => resolve({ code: null, out: e.message }));
        child.on('close', (code) => resolve({ code, out }));
      });
      if (probe.code !== 0 || !probe.out.includes(tag)) {
        fs.rmSync(tmp, { force: true });
        return { code: 1, out: 'The downloaded yt-dlp did not start, update discarded' };
      }
      fs.renameSync(tmp, target);
      return { code: 0, out: `yt-dlp ${tag}` };
    } catch (err: any) {
      fs.rmSync(tmp, { force: true });
      return { code: 1, out: String(err?.message ?? err) };
    }
  }

  private async currentVersion(): Promise<string | null> {
    const yt = ytdlpCommand();
    const r = await run(yt.cmd, [...yt.prefix, '--version'], 30000);
    const v = r.out.trim().split('\n').pop()?.trim();
    return r.code === 0 && v && /^\d{4}\.\d{2}\.\d{2}/.test(v) ? v : null;
  }

  private async latestVersion(): Promise<string | null> {
    try {
      const res = await fetch(RELEASES_URL, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Harbor' },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return null;
      const data: any = await res.json();
      return typeof data?.tag_name === 'string' ? data.tag_name.replace(/^v/, '') : null;
    } catch {
      return null;
    }
  }

  /** pip when yt-dlp lives in a Python "Scripts"/"bin" folder next to a python executable. */
  private async installMethod(): Promise<{ method: InstallMethod; python?: string }> {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    const r = await run(finder, ['yt-dlp'], 10000);
    const exe = r.out.split('\n').map((l) => l.trim()).find((l) => l && fs.existsSync(l));
    if (!exe) return { method: 'unknown' };
    const dir = path.dirname(exe);
    if (/^(scripts|bin)$/i.test(path.basename(dir))) {
      const root = path.dirname(dir);
      for (const candidate of [path.join(root, 'python.exe'), path.join(dir, 'python.exe'), path.join(dir, 'python3'), path.join(dir, 'python')]) {
        if (fs.existsSync(candidate)) return { method: 'pip', python: candidate };
      }
    }
    return { method: 'standalone' };
  }
}
