/**
 * First-run setup screen. On the first start of a version Harbor checks its bundled tools
 * (and updates yt-dlp) before anything can be used: the window shows a modal that can't be
 * dismissed until the steps finish. If a step fails the user can retry, or continue anyway
 * so a blocked component never locks them out of the app.
 */
import type { SetupProgress, SetupStepId } from '../shared/types';
import { el } from './dom';
import { LangKey, t } from './i18n';

const STEPS: { id: SetupStepId; label: LangKey }[] = [
  { id: 'engine', label: 'setupEngine' },
  { id: 'ffmpeg', label: 'setupFfmpeg' },
  { id: 'ytdlp', label: 'setupYtdlp' },
];

const ICON = {
  done: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>',
  failed: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>',
  skipped: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><line x1="6" y1="12" x2="18" y2="12"></line></svg>',
};

/** Resolves once the app may be used (setup finished, not needed, or skipped after a failure). */
export async function runFirstSetup(): Promise<void> {
  const status = await window.electronAPI.getSetupStatus();
  if (!status.needed) return;

  const overlay = el('div', 'aura-modal-overlay setup-overlay active');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'setup-title');
  const card = el('div', 'aura-modal-card setup-card');
  const badge = el('div', 'setup-badge');
  badge.innerHTML =
    '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="3"></circle><path d="M12 22V8"></path><path d="M5 12H2a10 10 0 0 0 20 0h-3"></path></svg>';
  const title = el('h3', 'modal-title', t('setupTitle'));
  title.id = 'setup-title';
  const desc = el('p', 'modal-desc', t('setupDesc'));
  const list = el('ul', 'setup-steps');
  const rows = new Map<SetupStepId, { li: HTMLElement; mark: HTMLElement; detail: HTMLElement }>();
  for (const s of STEPS) {
    const li = el('li', 'setup-step');
    const mark = el('span', 'setup-mark');
    const text = el('span', 'setup-text', t(s.label));
    const detail = el('span', 'setup-detail');
    li.append(mark, text, detail);
    list.append(li);
    rows.set(s.id, { li, mark, detail });
  }
  const error = el('p', 'setup-error');
  error.hidden = true;
  const actions = el('div', 'setup-actions');
  actions.hidden = true;
  const retry = el('button', 'modal-btn-primary', t('setupRetry')) as HTMLButtonElement;
  retry.type = 'button';
  const skip = el('button', 'modal-btn-ghost', t('setupSkip')) as HTMLButtonElement;
  skip.type = 'button';
  actions.append(retry, skip);
  card.append(badge, title, desc, list, error, actions);
  overlay.append(card);
  // Nothing behind the dialog is reachable while it is open
  document.getElementById('app-container')?.setAttribute('inert', '');
  document.body.append(overlay);

  const paint = (p: SetupProgress) => {
    const row = rows.get(p.step);
    if (!row) return;
    row.li.dataset.state = p.state;
    row.mark.innerHTML = p.state === 'running' ? '' : ICON[p.state];
    row.detail.textContent =
      p.step === 'ytdlp' && p.state === 'skipped' ? t('setupYtdlpOffline') : p.detail ? `v${p.detail}` : '';
  };
  const off = window.electronAPI.onSetupProgress(paint);

  await new Promise<void>((resolve) => {
    const attempt = async () => {
      actions.hidden = true;
      error.hidden = true;
      for (const s of STEPS) {
        const row = rows.get(s.id)!;
        delete row.li.dataset.state;
        row.mark.innerHTML = '';
        row.detail.textContent = '';
      }
      const result = await window.electronAPI.runSetup();
      if (result.ok) {
        resolve();
        return;
      }
      error.textContent = status.bundled ? t('setupFailed') : t('setupFailedDev');
      error.hidden = false;
      actions.hidden = false;
      retry.focus();
    };
    retry.addEventListener('click', attempt);
    skip.addEventListener('click', () => resolve());
    void attempt();
  });

  off();
  document.getElementById('app-container')?.removeAttribute('inert');
  overlay.classList.add('closing');
  setTimeout(() => overlay.remove(), 260);
}
