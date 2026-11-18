import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { pathToFileURL } from 'url';
import { BrowserWindow } from 'electron';
import {
  DependencyStatus,
  DownloadErrorCode,
  DownloadProgressPayload,
  DownloadStatus,
  DownloadTaskRequest,
  HistoryEntry,
  ToolType,
} from '../../shared/types';
import { isSpotifyUrl } from '../../shared/urls';
import { SettingsService } from './SettingsService';
import { HistoryService } from './HistoryService';
import { UTF8_ENV, commandSucceeds, killTree, readLines, resolvePython, resolveSpotdl, scriptPath } from './processUtils';
import { engineCommand, ffmpegCommand, ytdlpCommand } from './tools';

interface Task {
  id: string;
  request: DownloadTaskRequest;
  tool: ToolType;
  folder: string;
  status: DownloadStatus;
  percent: number;
  /** yt-dlp only: per-task dir for intermediate files (.part, fragments, thumbnails). */
  tempDir?: string;
  /** yt-dlp only: file yt-dlp appends final file paths to (--print-to-file after_move). */
  printFile?: string;
  child?: ChildProcess;
  cancelled: boolean;
  files: string[];
  lastError?: string;
  displayTitle?: string;
  /** spotdl only: names reported as downloaded/skipped, and folder snapshot before start. */
  spotdlNames: string[];
  snapshot?: Map<string, number>;
  /** yt-dlp only: per-file metadata printed after moving (title, uploader, thumbnail, ...). */
  fileMeta: Map<string, FileMeta>;
}

interface FileMeta {
  title?: string;
  artist?: string;
  thumbnail?: string;
  webpageUrl?: string;
  duration?: number;
}

// Fields written per finished file by --print-to-file, tab separated (see buildYtDlpArgs)
const PRINT_TEMPLATE =
  'after_move:%(filepath)s\t%(title)s\t%(artist,uploader,channel)s\t%(thumbnail)s\t%(webpage_url)s\t%(duration)s';

/** Makes a user/playlist provided name safe to use as a single folder name on Windows. */
export function sanitizeFolderName(name: string): string {
  let s = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim();
  s = s.replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 100).trim();
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s)) s += '_';
  return s;
}

const DEFAULT_CONCURRENCY = 3;

interface TaggerInfo {
  title: string | null;
  artist: string | null;
  album: string | null;
  duration: number | null;
  cover: string | null;
}

export class DownloadManager {
  private tasks = new Map<string, Task>();
  private pending: Task[] = [];
  private running = 0;
  private mainWindow: BrowserWindow | null = null;

  constructor(
    private settingsService: SettingsService,
    private historyService: HistoryService
  ) {}

  public setWindow(win: BrowserWindow) {
    this.mainWindow = win;
  }

  private emit(task: Task, patch: Omit<DownloadProgressPayload, 'taskId' | 'status' | 'percent'> & { status?: DownloadStatus; percent?: number }) {
    if (patch.status) task.status = patch.status;
    if (patch.percent !== undefined) task.percent = patch.percent;
    const payload: DownloadProgressPayload = {
      ...patch,
      taskId: task.id,
      status: task.status,
      percent: task.percent,
      format: task.request.format,
    };
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('download:progress', payload);
    }
  }

  public async checkDependencies(): Promise<DependencyStatus> {
    const engine = engineCommand('selftest');
    const yt = ytdlpCommand();
    if (engine) {
      // Bundled: one engine runs yt-dlp, spotDL and the tagger
      const [ok, ffmpeg] = await Promise.all([
        commandSucceeds(engine.cmd, engine.prefix, 60000),
        commandSucceeds(ffmpegCommand(), ['-version']),
      ]);
      return { spotdl: ok, ytdlp: ok, ffmpeg, tagger: ok };
    }
    const [spotdl, ytdlp, ffmpeg, python] = await Promise.all([
      commandSucceeds('spotdl', ['--version'], 30000),
      commandSucceeds(yt.cmd, [...yt.prefix, '--version']),
      commandSucceeds(ffmpegCommand(), ['-version']),
      resolvePython(),
    ]);
    return { spotdl, ytdlp, ffmpeg, tagger: python !== null };
  }

  // ─────────────────────────────── Queue ───────────────────────────────

  public startTask(request: DownloadTaskRequest): { taskId: string; success: boolean } {
    const settings = this.settingsService.getSettings();
    const taskId = 'task_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
    const isSpotify = isSpotifyUrl(request.url);
    const tool: ToolType = isSpotify ? 'spotdl' : (request.tool ?? 'yt-dlp');
    // Spotify is audio only
    const format = isSpotify ? 'mp3' : request.format;

    let folder =
      request.customFolder ||
      (format === 'mp3' ? settings.mp3DownloadPath : settings.mp4DownloadPath) ||
      process.cwd();
    const sub = request.subfolder ? sanitizeFolderName(request.subfolder) : '';
    if (sub) folder = path.join(folder, sub);

    const task: Task = {
      id: taskId,
      request: { ...request, format },
      tool,
      folder,
      status: 'queued',
      percent: 0,
      cancelled: false,
      files: [],
      spotdlNames: [],
      fileMeta: new Map(),
    };
    this.tasks.set(taskId, task);
    this.pending.push(task);
    this.emit(task, { status: 'queued', title: this.metaTitle(request) || request.url });
    this.pump();
    return { taskId, success: true };
  }

  private powerSaverActive: () => boolean = () => false;
  /** Battery saver: one download at a time (fewer ffmpeg/yt-dlp processes at once). */
  public setPowerSaver(isActive: () => boolean) {
    this.powerSaverActive = isActive;
  }

  private get maxConcurrent(): number {
    const n = Number(this.settingsService.getSettings().maxConcurrentDownloads);
    const limit = Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_CONCURRENCY;
    return this.powerSaverActive() ? 1 : limit;
  }

  /** Re-check the queue (e.g. battery saver turned off: more downloads may start now). */
  public refreshQueue() {
    this.pump();
  }

  private pump() {
    while (this.running < this.maxConcurrent && this.pending.length > 0) {
      const task = this.pending.shift()!;
      this.running++;
      this.runTask(task)
        .catch((err) => {
          console.error('[DownloadManager] task crashed:', err);
          this.emit(task, { status: 'error', errorCode: 'spawnFailed', error: String(err?.message ?? err) });
        })
        .finally(() => {
          this.running--;
          this.pump();
        });
    }
  }

  public cancelTask(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || task.status === 'completed' || task.status === 'error' || task.status === 'cancelled') return false;
    task.cancelled = true;
    const idx = this.pending.indexOf(task);
    if (idx >= 0) {
      // Not started yet: just drop it from the queue
      this.pending.splice(idx, 1);
      this.emit(task, { status: 'cancelled' });
      return true;
    }
    // Running: kill the whole process tree; the close handler reports "cancelled" once
    if (task.child) killTree(task.child);
    return true;
  }

  // ─────────────────────────────── Run ───────────────────────────────

  private async runTask(task: Task): Promise<void> {
    if (task.cancelled) return;
    try {
      fs.mkdirSync(task.folder, { recursive: true });
    } catch (err: any) {
      // Without a usable folder the tool can't even start (spawn reports a misleading ENOENT)
      console.error('[DownloadManager] Error creating directory:', err);
      this.emit(task, { status: 'error', errorCode: 'folderFailed', error: `${task.folder}: ${err?.message ?? err}` });
      return;
    }

    const args = task.tool === 'spotdl' ? this.buildSpotdlArgs(task) : this.buildYtDlpArgs(task);
    console.log(`[DownloadManager] Starting ${task.tool}`, args);
    this.emit(task, { status: 'downloading', title: this.metaTitle(task.request) || task.request.url });

    // spotdl runs through scripts/spotdl_fast.py when possible (much faster Spotify lookups)
    const launch =
      task.tool === 'spotdl'
        ? engineCommand('spotdl') ?? (await resolveSpotdl(scriptPath('spotdl_fast.py')))
        : ytdlpCommand();
    if (task.cancelled) {
      this.emit(task, { status: 'cancelled' });
      return;
    }
    const exit = await new Promise<{ code: number | null; spawnError?: Error }>((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(launch.cmd, [...launch.prefix, ...args], {
          cwd: task.folder,
          shell: false,
          windowsHide: true,
          // COLUMNS: keep spotdl's rich console from wrapping long song names onto two lines
          env: { ...UTF8_ENV, COLUMNS: '1000' },
        });
      } catch (err: any) {
        resolve({ code: null, spawnError: err });
        return;
      }
      task.child = child;
      const onLine = (line: string) => {
        if (task.tool === 'spotdl') this.parseSpotdlLine(task, line);
        else this.parseYtDlpLine(task, line);
      };
      readLines(child.stdout!, onLine);
      readLines(child.stderr!, onLine);
      child.on('error', (err) => resolve({ code: null, spawnError: err }));
      child.on('close', (code) => resolve({ code }));
    });
    task.child = undefined;

    if (task.cancelled) {
      this.cleanupTemp(task);
      this.emit(task, { status: 'cancelled' });
      return;
    }
    if (exit.spawnError) {
      this.cleanupTemp(task);
      this.emit(task, { status: 'error', errorCode: 'spawnFailed', error: exit.spawnError.message });
      return;
    }

    task.files = task.tool === 'spotdl' ? this.collectSpotdlFiles(task) : this.collectYtDlpFiles(task);
    this.cleanupTemp(task);

    if (task.files.length === 0) {
      const errorCode: DownloadErrorCode = exit.code === 0 ? 'noOutput' : 'exitCode';
      this.emit(task, {
        status: 'error',
        errorCode,
        error: task.lastError ?? (exit.code !== 0 ? `exit code ${exit.code}` : undefined),
      });
      return;
    }

    // Post-process MP3s so covers show in Windows Explorer / Media Player
    const mp3s = task.files.filter((f) => f.toLowerCase().endsWith('.mp3'));
    if (mp3s.length > 0) {
      this.emit(task, { status: 'converting', percent: 99 });
      const mode = task.tool === 'spotdl' ? 'preserve' : 'clean';
      for (const file of mp3s) {
        const unchanged = task.tool === 'spotdl' && !this.changedSinceSnapshot(task, file);
        // A skipped (already present) spotdl file is only read, never rewritten
        const info = await this.runTagger(file, mode, unchanged);
        if (info) this.mergeTaggerInfo(task, file, info);
      }
    }

    this.recordHistory(task);

    this.emit(task, {
      status: 'completed',
      percent: 100,
      title: path.basename(task.files[0]),
      filePath: task.files[0],
      fileCount: task.files.length,
      // Partial playlist failures: files exist but the tool still reported an error
      error: exit.code !== 0 ? task.lastError : undefined,
    });
  }

  private buildYtDlpArgs(task: Task): string[] {
    task.tempDir = path.join(os.tmpdir(), 'spotdl-gui', task.id);
    fs.mkdirSync(task.tempDir, { recursive: true });
    task.printFile = path.join(task.tempDir, 'final-files.txt');

    const common = [
      '-N', '16', // concurrent fragments (DASH/HLS)
      '--http-chunk-size', '10M', // chunked HTTP downloads avoid YouTube's per-connection throttling
      '--no-playlist', // a "watch?v=..&list=.." link downloads just the video; pure playlist links still work
      '--embed-metadata',
      '--embed-thumbnail',
      '--convert-thumbnails', 'jpg',
      '--newline',
      '--progress',
      '--no-colors',
      '--progress-template', 'download:__PROG__ %(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s',
      // Final paths after all post-processing & moving; '%' must be escaped (FILE is an output template)
      '--print-to-file', PRINT_TEMPLATE, task.printFile.replace(/%/g, '%%'),
      '-P', task.folder,
      '-P', `temp:${task.tempDir}`,
    ];

    const req = task.request;
    if (req.format === 'mp3' && req.audioCodec === 'm4a') {
      // YouTube's own AAC stream, remuxed into .m4a without re-encoding
      return [
        '-f', `${req.formatId ? req.formatId + '/' : ''}ba[ext=m4a]/ba`,
        '-x',
        '--audio-format', 'm4a',
        ...common,
        req.url,
      ];
    }
    if (req.format === 'mp3') {
      return [
        '-x',
        '--audio-format', 'mp3',
        '--audio-quality', '0',
        '--parse-metadata', '%(title)s:%(meta_album)s',
        '--postprocessor-args', 'ExtractAudio:-id3v2_version 3',
        ...common,
        req.url,
      ];
    }
    return ['-f', this.videoSelector(req), '--merge-output-format', 'mp4', ...common, req.url];
  }

  /**
   * The exact format picked in the preview first; then the same height cap with H.264 + AAC
   * preferred (plays everywhere), then anything up to the cap. Without a choice the cap is the
   * "default video quality" setting (1080p), so a plain MP4 click never pulls a 700 MB 4K file.
   */
  private videoSelector(req: DownloadTaskRequest): string {
    const setting = Number(this.settingsService.getSettings().defaultVideoHeight);
    const cap = req.maxHeight ?? (Number.isFinite(setting) ? setting : 1080);
    const h = cap > 0 ? `[height<=${cap}]` : '';
    return [
      req.formatId,
      `bv*${h}[vcodec^=avc1]+ba[ext=m4a]`,
      `bv*${h}[ext=mp4]+ba[ext=m4a]`,
      `bv*${h}+ba`,
      `b${h}`,
      'bv*+ba/b',
    ]
      .filter(Boolean)
      .join('/');
  }

  private buildSpotdlArgs(task: Task): string[] {
    task.snapshot = this.snapshotMp3s(task.folder);
    return [
      'download', task.request.url,
      '--output', path.join(task.folder, '{artists} - {title}.{output-ext}'),
      '--threads', '8',
      '--simple-tui',
    ];
  }

  // ─────────────────────────────── Parsing ───────────────────────────────

  private parseYtDlpLine(task: Task, line: string) {
    const prog = line.match(/^__PROG__\s*([\d.]+)%\|\s*([^|]*)\|\s*(.*)$/);
    if (prog) {
      const percent = Math.min(parseFloat(prog[1]), 100);
      const speed = prog[2].trim();
      const eta = prog[3].trim();
      this.emit(task, {
        status: 'downloading',
        percent: percent >= 100 ? 99 : percent,
        speed: /unknown|n\/a/i.test(speed) ? undefined : speed,
        eta: /unknown|^na$/i.test(eta) ? undefined : eta,
        title: task.displayTitle,
      });
      return;
    }

    const dest = line.match(/^\[download\]\s+Destination:\s+(.+)$/);
    if (dest) {
      task.displayTitle = this.prettyTitle(dest[1].trim(), this.outputExt(task));
      this.emit(task, { status: 'downloading', title: task.displayTitle });
      return;
    }

    const already = line.match(/^\[download\]\s+(.+?)\s+has already been downloaded/);
    if (already) {
      task.displayTitle = this.prettyTitle(already[1].trim(), this.outputExt(task));
      return;
    }

    if (/^\[(ExtractAudio|Merger|EmbedThumbnail|Metadata|VideoConvertor|FixupM3u8|FixupM4a|MoveFiles)\]/.test(line)) {
      this.emit(task, { status: 'converting', percent: 99, title: task.displayTitle });
      return;
    }

    if (/^ERROR:/.test(line)) {
      task.lastError = line.replace(/^ERROR:\s*/, '');
      console.warn(`[yt-dlp ${task.id}]`, line);
    }
  }

  private parseSpotdlLine(task: Task, line: string) {
    const text = line.trim();

    const downloaded = text.match(/^Downloaded\s+"(.+)":/);
    if (downloaded) {
      task.spotdlNames.push(downloaded[1]);
      task.displayTitle = downloaded[1];
      return;
    }
    // "Skipping Artist - Title (file already exists) (duplicate)"
    const skipped = text.match(/^Skipping\s+(.+?)\s+\(file already exists\)/i);
    if (skipped) {
      task.spotdlNames.push(skipped[1]);
      return;
    }

    const complete = text.match(/^(\d+)\/(\d+)\s+complete/);
    if (complete) {
      const done = parseInt(complete[1], 10);
      const total = parseInt(complete[2], 10);
      this.emit(task, {
        status: 'downloading',
        percent: total > 0 ? Math.min(99, (done / total) * 100) : 0,
        itemsDone: done,
        itemsTotal: total,
        title: task.displayTitle,
      });
      return;
    }

    // "<Artist - Title>: Searching for song | Downloading | Embedding metadata | Done"
    const step = text.match(/^(.+):\s+(Searching for song|Getting audio meta|Downloading|Converting|Embedding metadata|Done|Skipped)$/);
    if (step) {
      task.displayTitle = step[1];
      const converting = step[2] === 'Converting' || step[2] === 'Embedding metadata';
      this.emit(task, { status: converting ? 'converting' : 'downloading', title: step[1] });
      return;
    }

    if (/\b\w*Error\b:/.test(text)) {
      task.lastError = text;
      console.warn(`[spotdl ${task.id}]`, text);
    }
  }

  /** "C:\tmp\Song [id].f137.mp4" -> "Song [id].mp4" (target extension instead of intermediate one) */
  private outputExt(task: Task): string {
    return task.request.format === 'mp3' && task.request.audioCodec === 'm4a' ? 'm4a' : task.request.format;
  }

  private prettyTitle(filePath: string, format: string): string {
    let base = path.basename(filePath).replace(/\.(part|ytdl)$/i, '');
    base = base.replace(/\.[a-z0-9]{2,5}$/i, ''); // extension
    base = base.replace(/\.f\d+(-\d+)?$/i, ''); // yt-dlp format id suffix
    return `${base}.${format}`;
  }

  // ─────────────────────────────── Output files ───────────────────────────────

  private collectYtDlpFiles(task: Task): string[] {
    if (!task.printFile) return [];
    try {
      const files: string[] = [];
      for (const line of fs.readFileSync(task.printFile, 'utf-8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        const [file, title, artist, thumbnail, webpageUrl, duration] = line.split('\t').map((v) => {
          const t = (v ?? '').trim();
          return t === 'NA' ? '' : t;
        });
        if (!file || !fs.existsSync(file) || files.includes(file)) continue;
        files.push(file);
        task.fileMeta.set(file, {
          title: title || undefined,
          artist: artist || undefined,
          thumbnail: thumbnail || undefined,
          webpageUrl: webpageUrl || undefined,
          duration: duration ? Math.round(parseFloat(duration)) || undefined : undefined,
        });
      }
      return files;
    } catch {
      return [];
    }
  }

  private snapshotMp3s(folder: string): Map<string, number> {
    const snap = new Map<string, number>();
    try {
      for (const name of fs.readdirSync(folder)) {
        if (!name.toLowerCase().endsWith('.mp3')) continue;
        try {
          snap.set(name, fs.statSync(path.join(folder, name)).mtimeMs);
        } catch { /* file vanished */ }
      }
    } catch { /* folder missing */ }
    return snap;
  }

  private changedSinceSnapshot(task: Task, file: string): boolean {
    const before = task.snapshot?.get(path.basename(file));
    if (before === undefined) return true;
    try {
      return fs.statSync(file).mtimeMs !== before;
    } catch {
      return false;
    }
  }

  /**
   * spotdl doesn't print file paths, so match the names it reported against the MP3s in
   * the folder (names are sanitized for the file system, so compare loosely). If nothing
   * matches, fall back to MP3s that are new/changed since the task started.
   */
  private collectSpotdlFiles(task: Task): string[] {
    const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
    // "Artist - Title" → [artist, title]. spotdl reports only the first artist
    // ("Artist A - Song") but names the file with all of them ("Artist A, Artist B - Song"),
    // so the title must match and the file's artist list must start with the reported one.
    const split = (s: string): [string, string] => {
      const i = s.indexOf(' - ');
      return i > 0 ? [norm(s.slice(0, i)), norm(s.slice(i + 3))] : ['', norm(s)];
    };
    const wanted = task.spotdlNames.map(split);
    const matches = (fileName: string) => {
      const [fa, ft] = split(fileName);
      return wanted.some(([wa, wt]) => wt === ft && fa.startsWith(wa));
    };
    const current = this.snapshotMp3s(task.folder);
    const all = [...current.keys()].map((name) => path.join(task.folder, name));

    const matched = all.filter((f) => matches(path.parse(f).name));
    if (matched.length > 0) return matched;
    return all.filter((f) => this.changedSinceSnapshot(task, f));
  }

  private cleanupTemp(task: Task) {
    if (task.tempDir) {
      try {
        fs.rmSync(task.tempDir, { recursive: true, force: true });
      } catch (err) {
        console.warn('[DownloadManager] temp cleanup failed:', err);
      }
    }
  }

  /** Where the cover thumbnail of an MP3 is cached (one file per path). */
  private coverPathFor(file: string): string {
    const key = createHash('sha1').update(path.resolve(file).toLowerCase()).digest('hex').slice(0, 20);
    return path.join(this.historyService.coversDir, `${key}.jpg`);
  }

  /** Fills in what yt-dlp didn't print (spotdl prints nothing): real tags, length and cover. */
  private mergeTaggerInfo(task: Task, file: string, info: TaggerInfo) {
    const fm = task.fileMeta.get(file) ?? {};
    task.fileMeta.set(file, {
      ...fm,
      title: fm.title ?? info.title ?? undefined,
      artist: fm.artist ?? info.artist ?? undefined,
      duration: fm.duration ?? info.duration ?? undefined,
      thumbnail: fm.thumbnail ?? (info.cover ? pathToFileURL(info.cover).href : undefined),
    });
  }

  /**
   * Runs scripts/tagger.py. With `infoOnly` the file is only read. Returns the tags, length and
   * cover thumbnail it reports, or null when Python/mutagen is missing or the run failed.
   */
  public async runTagger(file: string, mode: 'clean' | 'preserve', infoOnly = false): Promise<TaggerInfo | null> {
    // Bundled engine first; otherwise a system Python with mutagen + Pillow
    const engine = engineCommand('tagger');
    const python = engine ? null : await resolvePython();
    if (!engine && !python) {
      console.warn('[DownloadManager] Python with mutagen+Pillow not found; skipping tagger');
      return null;
    }
    const taggerArgs = [file, '--mode', mode, '--cover-out', this.coverPathFor(file)];
    if (infoOnly) taggerArgs.push('--info-only');
    const cmd = engine ? engine.cmd : python!.cmd;
    const args = engine ? [...engine.prefix, ...taggerArgs] : [...python!.prefix, '-I', '-X', 'utf8', scriptPath('tagger.py'), ...taggerArgs];
    return new Promise<TaggerInfo | null>((resolve) => {
      let info: TaggerInfo | null = null;
      const p = spawn(cmd, args, { shell: false, windowsHide: true, env: UTF8_ENV });
      readLines(p.stdout, (l) => {
        if (l.startsWith('__INFO__ ')) {
          try {
            info = JSON.parse(l.slice(9));
          } catch {
            /* ignore */
          }
        } else console.log(l);
      });
      readLines(p.stderr, (l) => console.error(l));
      p.on('error', (err) => {
        console.error('[DownloadManager] tagger spawn failed:', err);
        resolve(null);
      });
      p.on('close', () => resolve(info));
    });
  }

  /**
   * One-off repair for history entries saved before covers/lengths were recorded (e.g. a
   * Spotify song downloaded by link): read the MP3 without changing it and fill the gaps.
   */
  public async backfillHistory() {
    const missing = this.historyService
      .list()
      .filter((e) => e.exists && e.filePath.toLowerCase().endsWith('.mp3') && (!e.thumbnail || !e.duration));
    for (const e of missing) {
      const info = await this.runTagger(e.filePath, 'preserve', true);
      if (!info) continue;
      this.historyService.update(e.id, {
        duration: e.duration ?? info.duration ?? undefined,
        thumbnail: e.thumbnail ?? (info.cover ? pathToFileURL(info.cover).href : undefined),
        artist: e.artist ?? info.artist ?? undefined,
      });
    }
  }

  private metaTitle(request: DownloadTaskRequest): string | undefined {
    const m = request.meta;
    if (!m?.title) return undefined;
    return m.artist ? `${m.artist} - ${m.title}` : m.title;
  }

  private recordHistory(task: Task) {
    const source: HistoryEntry['source'] =
      task.tool === 'spotdl' ? 'spotify' : /youtube\.com|youtu\.be/i.test(task.request.url) ? 'youtube' : 'other';
    const single = task.files.length === 1;
    const reqMeta = task.request.meta;

    const items = task.files.map((file) => {
      const fm = task.fileMeta.get(file);
      let title = fm?.title;
      let artist = fm?.artist;
      if (!title && single && reqMeta?.title) {
        title = reqMeta.title;
        artist = artist ?? reqMeta.artist;
      }
      if (!title) {
        // spotdl names files "Artist - Title.mp3"
        const base = path.parse(file).name;
        const dash = base.indexOf(' - ');
        if (task.tool === 'spotdl' && dash > 0) {
          artist = artist ?? base.slice(0, dash);
          title = base.slice(dash + 3);
        } else {
          title = base;
        }
      }
      let size: number | undefined;
      try {
        size = fs.statSync(file).size;
      } catch {
        /* ignore */
      }
      return {
        title,
        artist,
        sourceUrl: fm?.webpageUrl || task.request.url,
        filePath: file,
        format: task.request.format,
        source,
        thumbnail: fm?.thumbnail || (single ? reqMeta?.thumbnail : undefined),
        duration: fm?.duration ?? (single ? reqMeta?.duration : undefined),
        size,
      };
    });
    try {
      this.historyService.add(items);
    } catch (err) {
      console.error('[DownloadManager] history add failed:', err);
    }
  }

  // ─────────────────────────────── Task file actions ───────────────────────────────

  public getTaskFolder(taskId: string): string | undefined {
    return this.tasks.get(taskId)?.folder;
  }

  public getTaskFile(taskId: string): string | undefined {
    return this.tasks.get(taskId)?.files.find((f) => fs.existsSync(f));
  }

  public deleteDownloadedFile(taskId: string): { success: boolean; errorCode?: 'noPath' | 'notOnDisk' | 'failed'; error?: string } {
    const task = this.tasks.get(taskId);
    if (!task || task.files.length === 0) return { success: false, errorCode: 'noPath' };
    const existing = task.files.filter((f) => fs.existsSync(f));
    if (existing.length === 0) return { success: false, errorCode: 'notOnDisk' };
    try {
      for (const f of existing) fs.unlinkSync(f);
      task.files = [];
      this.historyService.markDeleted(existing);
      return { success: true };
    } catch (err: any) {
      return { success: false, errorCode: 'failed', error: err?.message };
    }
  }

  /** True when nothing is downloading or waiting (safe moment to update yt-dlp). */
  public isIdle(): boolean {
    return this.running === 0 && this.pending.length === 0;
  }

  /** Kill everything on app quit so no yt-dlp/ffmpeg is left running in the background. */
  public shutdown() {
    this.pending = [];
    for (const task of this.tasks.values()) {
      if (task.child) {
        task.cancelled = true;
        killTree(task.child);
      }
      this.cleanupTemp(task);
    }
  }
}
