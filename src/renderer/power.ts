/**
 * Battery saver on the UI side. The main process decides when it is active (PowerService:
 * always, never, or while on battery); here it becomes body.power-saver, which switches off
 * the GPU-heavy effects in CSS (backdrop blur, animated background) and the JS motion
 * (view transitions, springs, staggered entrances). Image caches are trimmed when it turns
 * on and whenever the window is hidden while it is on.
 */
import type { PowerState } from '../shared/types';

let state: PowerState = { mode: 'battery', onBattery: false, active: false };

/** True while battery saver is in effect (also used to skip decorative motion). */
export const isPowerSaver = (): boolean => state.active;

function apply(s: PowerState) {
  const turnedOn = s.active && !state.active;
  state = s;
  document.body.classList.toggle('power-saver', s.active);
  if (turnedOn) window.electronAPI.trimMemory();
  document.dispatchEvent(new CustomEvent('power-changed', { detail: s }));
}

export async function setupPower() {
  apply(await window.electronAPI.getPowerState());
  window.electronAPI.onPowerState(apply);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && state.active) window.electronAPI.trimMemory();
  });
}

export const powerState = (): PowerState => ({ ...state });
