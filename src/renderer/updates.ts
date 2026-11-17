import type { AppSettings, UpdateStatus } from '../shared/types';
import { $, formatDate, toast } from './dom';
import { t } from './i18n';

/** Settings panel for yt-dlp updates + a toast when an (automatic) update finishes. */
export function setupUpdates(settings: AppSettings) {
  const current = $('ytdlp-current');
  const latest = $('ytdlp-latest');
  const state = $('ytdlp-state');
  const checked = $('ytdlp-checked');
  const checkBtn = $<HTMLButtonElement>('ytdlp-check-btn');
  const updateBtn = $<HTMLButtonElement>('ytdlp-update-btn');
  const autoToggle = $<HTMLInputElement>('setting-auto-update');

  let status: UpdateStatus = { state: 'idle' };
  autoToggle.checked = settings.autoUpdateYtDlp !== false;

  function render() {
    current.textContent = status.current ?? '—';
    latest.textContent = status.latest ?? '—';
    const busy = status.state === 'checking' || status.state === 'updating';
    checkBtn.disabled = busy;
    updateBtn.disabled = busy || !status.updateAvailable;
    updateBtn.style.display = status.updateAvailable || status.state === 'updating' ? '' : 'none';

    let text = '';
    let tone = '';
    if (status.state === 'checking') text = t('updateChecking');
    else if (status.state === 'updating') text = t('updateUpdating');
    else if (status.installed === false) {
      text = t('updateNotInstalled');
      tone = 'bad';
    } else if (status.state === 'failed') {
      text = status.error ? `${t('updateFailed')}: ${status.error}` : t('updateFailed');
      tone = 'bad';
    } else if (status.updateAvailable && status.latest) {
      text = t('updateAvailable', { v: status.latest });
      tone = 'warn';
    } else if (status.current && status.latest) {
      text = t('updateUpToDate');
      tone = 'ok';
    }
    state.textContent = text;
    state.dataset.tone = tone;
    state.title = status.error ?? '';
    checked.textContent = status.checkedAt ? t('lastChecked', { t: formatDate(status.checkedAt) }) : '';
  }

  window.electronAPI.onUpdateStatus((s) => {
    const before = status.state;
    status = s;
    render();
    if (before === 'updating' && s.state === 'updated' && s.previous && s.current) {
      toast(t('updateDone', { v: s.current }));
    } else if (before === 'updating' && s.state === 'failed') {
      toast(t('updateFailed'));
    }
  });

  checkBtn.addEventListener('click', async () => {
    status = await window.electronAPI.checkForUpdate();
    render();
  });
  updateBtn.addEventListener('click', () => window.electronAPI.runUpdate());
  autoToggle.addEventListener('change', () => window.electronAPI.saveSettings({ autoUpdateYtDlp: autoToggle.checked }));
  document.addEventListener('language-changed', render);

  window.electronAPI.getUpdateStatus().then((s) => {
    status = s;
    render();
  });
}
