import { app } from 'electron';
import { SetupProgress, SetupResult, SetupStatus } from '../../shared/types';
import { SettingsService } from './SettingsService';
import { UpdateService } from './UpdateService';
import { commandSucceeds } from './processUtils';
import { engineCommand, ffmpegCommand, isBundled, ytdlpCommand } from './tools';

/**
 * First start (and the first start of every new version): make sure the bundled tools run
 * before the user can do anything, then bring yt-dlp up to date. The first run of the engine
 * is slow on purpose-built antivirus scanning, so this is real work, not a splash screen.
 */
export class SetupService {
  private running: Promise<SetupResult> | null = null;

  constructor(
    private settings: SettingsService,
    private updates: UpdateService,
    private emit: (p: SetupProgress) => void
  ) {}

  public status(): SetupStatus {
    return { needed: this.settings.getSettings().setupDoneFor !== app.getVersion(), bundled: isBundled() };
  }

  public run(): Promise<SetupResult> {
    if (!this.running) this.running = this.steps().finally(() => (this.running = null));
    return this.running;
  }

  private async steps(): Promise<SetupResult> {
    // 1. The engine: yt-dlp, spotDL and the tagger (system tools when not bundled)
    this.emit({ step: 'engine', state: 'running' });
    let engineOk: boolean;
    const engine = engineCommand('selftest');
    if (engine) {
      engineOk = await commandSucceeds(engine.cmd, engine.prefix, 180000);
    } else {
      const yt = ytdlpCommand();
      const [a, b] = await Promise.all([
        commandSucceeds(yt.cmd, [...yt.prefix, '--version'], 60000),
        commandSucceeds('spotdl', ['--version'], 60000),
      ]);
      engineOk = a && b;
    }
    this.emit({ step: 'engine', state: engineOk ? 'done' : 'failed' });

    // 2. ffmpeg
    this.emit({ step: 'ffmpeg', state: 'running' });
    const ffmpegOk = await commandSucceeds(ffmpegCommand(), ['-version'], 60000);
    this.emit({ step: 'ffmpeg', state: ffmpegOk ? 'done' : 'failed' });

    if (!engineOk || !ffmpegOk) {
      return { ok: false, error: !engineOk ? 'engine' : 'ffmpeg' };
    }

    // 3. Latest yt-dlp (needs the internet; offline is fine, the bundled copy works)
    this.emit({ step: 'ytdlp', state: 'running' });
    const checked = await this.updates.check(true);
    if (!checked.latest) {
      this.emit({ step: 'ytdlp', state: 'skipped', detail: checked.current });
    } else if (checked.updateAvailable && this.settings.getSettings().autoUpdateYtDlp !== false) {
      const after = await this.updates.update();
      this.emit({
        step: 'ytdlp',
        state: after.state === 'failed' ? 'skipped' : 'done',
        detail: after.current,
      });
    } else {
      this.emit({ step: 'ytdlp', state: 'done', detail: checked.current });
    }

    this.settings.saveSettings({ setupDoneFor: app.getVersion() });
    return { ok: true };
  }
}
