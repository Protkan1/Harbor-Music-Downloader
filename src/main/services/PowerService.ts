import { powerMonitor } from 'electron';
import { PowerState } from '../../shared/types';
import { SettingsService } from './SettingsService';

/**
 * Battery saver. Mode "battery" (default) turns it on while the laptop runs on battery,
 * "on" keeps it on, "off" never. While active:
 *  - the UI drops its GPU-heavy effects (backdrop blur, animated background, decorative
 *    motion) — the renderer reads `active` and sets body.power-saver;
 *  - videos start at 720p and prefer H.264, which nearly every GPU decodes in hardware
 *    (VP9/AV1 often fall back to the CPU);
 *  - one download at a time, Explore doesn't reload on every visit, image caches are trimmed.
 */
export class PowerService {
  private listeners = new Set<(s: PowerState) => void>();
  private last: PowerState | null = null;

  constructor(private settings: SettingsService) {
    const changed = () => this.emitIfChanged();
    powerMonitor.on('on-battery', changed);
    powerMonitor.on('on-ac', changed);
  }

  public onChange(listener: (s: PowerState) => void) {
    this.listeners.add(listener);
  }

  public getState(): PowerState {
    const mode = this.settings.getSettings().powerSaver ?? 'battery';
    let onBattery = false;
    try {
      onBattery = powerMonitor.isOnBatteryPower();
    } catch {
      /* desktop without a battery */
    }
    return { mode, onBattery, active: mode === 'on' || (mode === 'battery' && onBattery) };
  }

  public isActive(): boolean {
    return this.getState().active;
  }

  /** Call after the setting changes. */
  public emitIfChanged() {
    const s = this.getState();
    if (this.last && this.last.active === s.active && this.last.mode === s.mode && this.last.onBattery === s.onBattery) return;
    this.last = s;
    for (const l of this.listeners) l(s);
  }
}
