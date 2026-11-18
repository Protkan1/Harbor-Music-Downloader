/**
 * "Edit playlist" dialog: name, description and the playlist's own cover picture.
 * Any picture the user picks (PNG, JPEG, WebP, GIF, AVIF, SVG, and through ffmpeg HEIC, TIFF,
 * ...) is cropped to a 640 px square JPEG here, so the main process only stores a small file.
 */
import type { LibraryPlaylist } from '../shared/types';
import { el, toast } from './dom';
import { t } from './i18n';
import { playlistCover } from './library';

const SIZE = 640;
const DESC_MAX = 1000;

let overlay: HTMLElement | null = null;
let onKey: ((e: KeyboardEvent) => void) | null = null;

function closeEditor() {
  if (!overlay) return;
  document.getElementById('app-container')?.removeAttribute('inert');
  overlay.remove();
  overlay = null;
  if (onKey) document.removeEventListener('keydown', onKey, true);
  onKey = null;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

async function decode(data: Uint8Array, mime: string): Promise<{ src: CanvasImageSource; w: number; h: number }> {
  const blob = new Blob([data as BlobPart], { type: mime });
  if (mime === 'image/svg+xml') {
    // SVG can't go through createImageBitmap; an <img> draws it (scripts in it never run)
    const img = new Image();
    img.src = await blobToDataUrl(blob);
    await img.decode();
    return { src: img, w: img.naturalWidth || SIZE, h: img.naturalHeight || SIZE };
  }
  // Honors the photo's EXIF orientation (phone pictures stay upright)
  const bmp = await createImageBitmap(blob);
  return { src: bmp, w: bmp.width, h: bmp.height };
}

/** Center crop to a square ("cover" fit), 640 px, JPEG. */
async function squareJpeg(data: Uint8Array, mime: string): Promise<{ bytes: Uint8Array; url: string }> {
  const { src, w, h } = await decode(data, mime);
  if (!w || !h) throw new Error('empty image');
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#151515'; // transparent pictures (logos) get a dark backdrop, JPEG has no alpha
  ctx.fillRect(0, 0, SIZE, SIZE);
  ctx.imageSmoothingQuality = 'high';
  const scale = Math.max(SIZE / w, SIZE / h);
  const dw = w * scale;
  const dh = h * scale;
  ctx.drawImage(src, (SIZE - dw) / 2, (SIZE - dh) / 2, dw, dh);
  if ('close' in src && typeof src.close === 'function') src.close();
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
  if (!blob) throw new Error('encode failed');
  return { bytes: new Uint8Array(await blob.arrayBuffer()), url: await blobToDataUrl(blob) };
}

export function openPlaylistEditor(p: LibraryPlaylist) {
  closeEditor();
  // What the dialog will save: a new picture, or "go back to the default cover"
  let picked: { bytes: Uint8Array; url: string } | null = null;
  let removeCustom = false;

  overlay = el('div', 'aura-modal-overlay pl-edit-overlay active');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'pl-edit-title');
  const card = el('form', 'aura-modal-card pl-edit-card');
  const title = el('h3', 'modal-title', t('libEditTitle'));
  title.id = 'pl-edit-title';

  // ── Cover column ──
  const coverCol = el('div', 'pl-edit-cover-col');
  const coverHost = el('div', 'pl-edit-cover-host');
  const choose = el('button', 'btn-browse pl-edit-choose', t('libCoverChoose'));
  choose.type = 'button';
  const remove = el('button', 'modal-btn-ghost pl-edit-remove', t('libCoverRemove'));
  remove.type = 'button';
  const hint = el('p', 'pl-edit-hint', t('libCoverHint'));
  coverCol.append(coverHost, choose, remove, hint);

  const renderCover = () => {
    coverHost.innerHTML = '';
    const override = picked ? picked.url : removeCustom ? null : undefined;
    const c = playlistCover(p, 'lib-cover pl-edit-cover', override);
    coverHost.append(c);
    remove.hidden = !(picked || (p.customCover && !removeCustom));
  };

  // ── Text column ──
  const fields = el('div', 'pl-edit-fields');
  const nameLabel = el('label', 'pl-edit-label', t('libEditName'));
  const nameInput = el('input', 'explore-search-input pl-edit-name') as HTMLInputElement;
  nameInput.id = 'pl-edit-name';
  nameLabel.htmlFor = nameInput.id;
  nameInput.maxLength = 120;
  nameInput.value = p.name;
  nameInput.required = true;
  const descLabel = el('label', 'pl-edit-label', t('libEditDesc'));
  const desc = el('textarea', 'pl-edit-desc') as HTMLTextAreaElement;
  desc.id = 'pl-edit-desc';
  descLabel.htmlFor = desc.id;
  desc.maxLength = DESC_MAX;
  desc.rows = 5;
  desc.placeholder = t('libEditDescPlaceholder');
  desc.value = p.description ?? '';
  const counter = el('span', 'pl-edit-counter');
  const updateCounter = () => (counter.textContent = `${desc.value.length} / ${DESC_MAX}`);
  desc.addEventListener('input', updateCounter);
  updateCounter();
  fields.append(nameLabel, nameInput, descLabel, desc, counter);

  const body = el('div', 'pl-edit-body');
  body.append(coverCol, fields);
  const error = el('p', 'pl-edit-error');
  error.setAttribute('role', 'alert');
  error.hidden = true;
  const showError = (msg: string) => {
    error.textContent = msg;
    error.hidden = false;
  };

  const actions = el('div', 'pl-edit-actions');
  const cancel = el('button', 'modal-btn-ghost', t('libCancel'));
  cancel.type = 'button';
  const save = el('button', 'modal-btn-primary', t('libSave'));
  save.type = 'submit';
  actions.append(cancel, save);

  card.append(title, body, error, actions);
  overlay.append(card);
  document.getElementById('app-container')?.setAttribute('inert', '');
  document.body.append(overlay);
  renderCover();
  nameInput.focus();
  nameInput.select();

  choose.addEventListener('click', async () => {
    error.hidden = true;
    choose.disabled = true;
    try {
      const res = await window.electronAPI.libraryPickCover();
      if (res.canceled) return;
      if (res.error || !res.data || !res.mime) return showError(res.error === 'tooLarge' ? t('libCoverTooLarge') : t('libCoverUnreadable'));
      picked = await squareJpeg(res.data, res.mime);
      removeCustom = false;
      renderCover();
    } catch {
      showError(t('libCoverUnreadable'));
    } finally {
      choose.disabled = false;
    }
  });
  remove.addEventListener('click', () => {
    picked = null;
    removeCustom = true;
    renderCover();
  });
  cancel.addEventListener('click', closeEditor);
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) closeEditor();
  });
  onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeEditor();
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      card.requestSubmit();
    }
  };
  document.addEventListener('keydown', onKey, true);

  card.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = nameInput.value.trim();
    if (!name) return nameInput.focus();
    save.disabled = true;
    try {
      if (picked) {
        const ok = await window.electronAPI.librarySetCover(p.id, picked.bytes);
        if (!ok) return showError(t('libCoverSaveFailed'));
      } else if (removeCustom && p.customCover) {
        await window.electronAPI.libraryClearCover(p.id);
      }
      if (name !== p.name || desc.value.trim() !== (p.description ?? '')) {
        await window.electronAPI.libraryUpdate(p.id, { name, description: desc.value });
      }
      closeEditor();
      toast(t('libSaved'));
    } finally {
      save.disabled = false;
    }
  });
}
