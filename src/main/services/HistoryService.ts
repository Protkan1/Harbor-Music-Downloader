import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { app } from 'electron';
import { HistoryEntry } from '../../shared/types';

export type HistoryPatch = Partial<Pick<HistoryEntry, 'title' | 'artist' | 'thumbnail' | 'duration'>>;

const MAX_ENTRIES = 2000;

/** Persistent download history in %APPDATA%/<app>/history.json (newest first). */
export class HistoryService {
  private filePath: string;
  /** Small cover JPEGs extracted from downloaded MP3s (history thumbnails that work offline). */
  public readonly coversDir: string;
  private entries: HistoryEntry[] = [];
  private listeners = new Set<() => void>();

  constructor() {
    this.filePath = path.join(app.getPath('userData'), 'history.json');
    this.coversDir = path.join(app.getPath('userData'), 'covers');
    try {
      if (fs.existsSync(this.filePath)) {
        const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
        if (Array.isArray(parsed)) this.entries = parsed.filter((e) => e && e.id && e.filePath);
      }
    } catch (err) {
      console.error('[HistoryService] Failed to load history:', err);
    }
  }

  public onChange(listener: () => void) {
    this.listeners.add(listener);
  }

  public list(): HistoryEntry[] {
    return this.entries.map((e) => {
      const exists = fs.existsSync(e.filePath);
      return { ...e, exists, fileUrl: exists ? pathToFileURL(e.filePath).href : undefined };
    });
  }

  public get(id: string): HistoryEntry | undefined {
    return this.entries.find((e) => e.id === id);
  }

  public add(items: Omit<HistoryEntry, 'id' | 'completedAt' | 'exists' | 'fileUrl'>[]) {
    if (items.length === 0) return;
    const now = Date.now();
    const added: HistoryEntry[] = items.map((item, i) => ({
      ...item,
      id: `h_${now.toString(36)}_${i}_${Math.random().toString(36).slice(2, 7)}`,
      completedAt: now,
    }));
    // A re-download overwrites the same file: keep a single, fresh entry for it
    const paths = new Set(added.map((e) => path.resolve(e.filePath).toLowerCase()));
    this.entries = [...added, ...this.entries.filter((e) => !paths.has(path.resolve(e.filePath).toLowerCase()))].slice(
      0,
      MAX_ENTRIES
    );
    this.persist();
  }

  public update(id: string, patch: HistoryPatch) {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return;
    Object.assign(entry, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined && v !== null)));
    this.persist();
  }

  public remove(ids: string[]) {
    const set = new Set(ids);
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => !set.has(e.id));
    if (this.entries.length !== before) this.persist();
  }

  /** Called when a file is deleted from the downloads list. */
  public markDeleted(filePaths: string[]) {
    // Entries stay (user may want to re-download) — list() reports exists=false.
    if (filePaths.length > 0) this.notify();
  }

  public clear() {
    this.entries = [];
    this.persist();
  }

  private persist() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.entries, null, 1), 'utf-8');
      fs.renameSync(tmp, this.filePath); // atomic replace: no half-written file on crash
    } catch (err) {
      console.error('[HistoryService] Failed to save history:', err);
    }
    this.notify();
  }

  private notify() {
    for (const l of this.listeners) {
      try {
        l();
      } catch (err) {
        console.error(err);
      }
    }
  }
}
