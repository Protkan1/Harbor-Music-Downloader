import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { AppSettings } from '../../shared/types';

export class SettingsService {
  private configPath: string;
  private settings: AppSettings;

  constructor() {
    const userData = app.getPath('userData');
    this.configPath = path.join(userData, 'config.json');

    const defaultMusic = path.join(app.getPath('music'), 'SpotDL');
    const defaultVideos = path.join(app.getPath('videos'), 'YtDlp');

    this.settings = {
      theme: 'dark',
      colorTheme: 'claude',
      language: 'tr',
      glassEnabled: true,
      glassBlur: 24,
      glassOpacity: 75,
      mp3DownloadPath: defaultMusic,
      mp4DownloadPath: defaultVideos,
      maxConcurrentDownloads: 3,
      autoUpdateYtDlp: true,
      lastYtDlpCheck: 0,
      defaultVideoHeight: 1080,
    };

    this.loadSettings();
  }

  private loadSettings(): void {
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = fs.readFileSync(this.configPath, 'utf-8');
        const parsed = JSON.parse(raw);
        this.settings = { ...this.settings, ...parsed };
      } else {
        this.saveSettings(this.settings);
      }
    } catch (e) {
      console.error('Failed to load settings:', e);
    }
  }

  public getSettings(): AppSettings {
    return { ...this.settings };
  }

  public saveSettings(newSettings: Partial<AppSettings>): AppSettings {
    this.settings = { ...this.settings, ...newSettings };
    try {
      fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
      fs.writeFileSync(this.configPath, JSON.stringify(this.settings, null, 2), 'utf-8');
    } catch (e) {
      console.error('Failed to save settings:', e);
    }
    return { ...this.settings };
  }
}
