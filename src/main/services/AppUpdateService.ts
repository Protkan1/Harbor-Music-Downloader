import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import { AppUpdateStatus } from '../../shared/types';
import { SettingsService } from './SettingsService';

/**
 * Harbor updates itself from the project's GitHub Releases (electron-updater reads the
 * release's latest.yml, downloads the new installer, checks its SHA-512 and installs it
 * silently). The renderer shows a blocking "Updating Harbor" dialog while this runs, then
 * the app restarts on the new version. Nothing to download or click by hand.
 */
export class AppUpdateService {
  private status: AppUpdateStatus = { state: 'idle', current: app.getVersion() };
  private listeners = new Set<(s: AppUpdateStatus) => void>();
  private wired = false;

  constructor(
    private settings: SettingsService,
    /** Never restart in the middle of a download */
    private isIdle: () => boolean
  ) {}

  public onChange(listener: (s: AppUpdateStatus) => void) {
    this.listeners.add(listener);
  }

  public getStatus(): AppUpdateStatus {
    return { ...this.status };
  }

  private set(patch: Partial<AppUpdateStatus>) {
    this.status = { ...this.status, ...patch };
    for (const l of this.listeners) l(this.getStatus());
  }

  /** Only an installed build can update itself (not `npm run dev`). */
  private get supported(): boolean {
    return app.isPackaged || !!process.env.HARBOR_UPDATE_URL;
  }

  private wire() {
    if (this.wired) return;
    this.wired = true;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = false;
    // Local test feed (a folder served over HTTP with latest.yml + installer)
    if (process.env.HARBOR_UPDATE_URL) {
      autoUpdater.setFeedURL({ provider: 'generic', url: process.env.HARBOR_UPDATE_URL });
      autoUpdater.forceDevUpdateConfig = true;
    }
    autoUpdater.on('checking-for-update', () => this.set({ state: 'checking', error: undefined }));
    autoUpdater.on('update-not-available', () => {
      this.set({ state: 'none', checkedAt: Date.now() });
    });
    autoUpdater.on('update-available', (info) => this.set({ state: 'downloading', version: info.version, percent: 0 }));
    autoUpdater.on('download-progress', (p) => this.set({ state: 'downloading', percent: Math.round(p.percent) }));
    autoUpdater.on('update-downloaded', (info) => {
      this.set({ state: 'downloaded', version: info.version, percent: 100 });
      void this.installWhenIdle();
    });
    autoUpdater.on('error', (err) => {
      this.set({ state: 'error', error: String(err?.message ?? err).split('\n')[0].slice(0, 300) });
    });
  }

  /** On start-up (after the first-run setup) when automatic updates are on. */
  public async checkOnStart(): Promise<AppUpdateStatus> {
    if (this.settings.getSettings().autoUpdateApp === false) return this.getStatus();
    return this.check();
  }

  public async check(): Promise<AppUpdateStatus> {
    if (!this.supported) {
      this.set({ state: 'disabled' });
      return this.getStatus();
    }
    this.wire();
    if (this.status.state === 'downloading' || this.status.state === 'downloaded' || this.status.state === 'installing') {
      return this.getStatus();
    }
    try {
      await autoUpdater.checkForUpdates();
    } catch (err: any) {
      this.set({ state: 'error', error: String(err?.message ?? err).split('\n')[0].slice(0, 300) });
    }
    return this.getStatus();
  }

  private async installWhenIdle() {
    for (let i = 0; i < 120 && !this.isIdle(); i++) {
      this.set({ state: 'downloaded', waitingForDownloads: true });
      await new Promise((r) => setTimeout(r, 5000));
    }
    this.set({ state: 'installing', waitingForDownloads: false });
    // Test runs (HARBOR_UPDATE_DRYRUN) stop here: downloaded and verified, nothing installed
    if (process.env.HARBOR_UPDATE_DRYRUN) return;
    // Let the dialog show "installing" for a moment, then: silent install, start again
    setTimeout(() => autoUpdater.quitAndInstall(true, true), 1200);
  }
}
