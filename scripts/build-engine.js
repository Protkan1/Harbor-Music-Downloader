/**
 * Builds the tools Harbor ships with into vendor/ (npm run build:engine):
 *
 *   vendor/engine/   harbor-engine.exe + its Python runtime (PyInstaller): yt-dlp, spotDL,
 *                    mutagen, Pillow and the tagger/scanner scripts. Users need no Python.
 *   vendor/ffmpeg/   ffmpeg + ffprobe, LGPL "shared" build from BtbN/FFmpeg-Builds, pinned to
 *                    one monthly release and checked against that release's checksums.sha256.
 *
 * Needs Python 3.12 on the build machine (only to build; the result is self-contained).
 * Package versions are pinned in engine/requirements.lock.txt.
 */
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const vendor = path.join(root, 'vendor');
const venv = path.join(vendor, '.venv');
const py = path.join(venv, 'Scripts', 'python.exe');

const FFMPEG_RELEASE = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-10-31-12-59';
const FFMPEG_ZIP = 'ffmpeg-n9.0.2-39-g7adfbe40dc-win64-lgpl-shared-9.0.zip';
const PYINSTALLER = 'pyinstaller==6.22.3';

function run(cmd, args, opts = {}) {
  console.log(`> ${path.basename(cmd)} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: root, ...opts });
  if (r.status !== 0) {
    console.error(`[engine] failed: ${cmd} (${r.status})`);
    process.exit(r.status ?? 1);
  }
}

async function download(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Harbor build' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function buildFfmpeg() {
  const out = path.join(vendor, 'ffmpeg');
  if (fs.existsSync(path.join(out, 'ffmpeg.exe'))) {
    console.log('[engine] ffmpeg already present');
    return;
  }
  console.log(`[engine] downloading ${FFMPEG_ZIP}`);
  const [zip, sums] = await Promise.all([download(`${FFMPEG_RELEASE}/${FFMPEG_ZIP}`), download(`${FFMPEG_RELEASE}/checksums.sha256`)]);
  const expected = sums
    .toString('utf8')
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .find((p) => p[1] && p[1].replace(/^\*/, '') === FFMPEG_ZIP)?.[0];
  const actual = crypto.createHash('sha256').update(zip).digest('hex');
  if (!expected || expected.toLowerCase() !== actual) throw new Error(`ffmpeg checksum mismatch (${actual})`);
  console.log('[engine] checksum OK');

  const tmp = path.join(vendor, 'ffmpeg-tmp');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  const zipPath = path.join(tmp, FFMPEG_ZIP);
  fs.writeFileSync(zipPath, zip);
  run('tar', ['-xf', zipPath, '-C', tmp]); // Windows 10+ tar reads zip
  const dir = fs.readdirSync(tmp).map((n) => path.join(tmp, n)).find((p) => fs.statSync(p).isDirectory());
  fs.mkdirSync(out, { recursive: true });
  for (const name of fs.readdirSync(path.join(dir, 'bin'))) {
    if (name === 'ffplay.exe') continue; // not needed
    fs.copyFileSync(path.join(dir, 'bin', name), path.join(out, name));
  }
  fs.copyFileSync(path.join(dir, 'LICENSE.txt'), path.join(out, 'LICENSE.txt'));
  fs.writeFileSync(
    path.join(out, 'SOURCE.txt'),
    `FFmpeg ${FFMPEG_ZIP}\nBuilt by https://github.com/BtbN/FFmpeg-Builds (LGPL build)\nFFmpeg source: https://ffmpeg.org/download.html\n`
  );
  fs.rmSync(tmp, { recursive: true, force: true });
}

function buildEngine() {
  if (!fs.existsSync(py)) run('python', ['-m', 'venv', venv]);
  run(py, ['-m', 'pip', 'install', '--disable-pip-version-check', '-q', '-r', path.join('engine', 'requirements.lock.txt'), PYINSTALLER]);
  run(py, [
    '-m', 'PyInstaller', '--noconfirm', '--clean', '--log-level', 'WARN',
    '--distpath', vendor, '--workpath', path.join(vendor, '.pyi-build'),
    path.join('engine', 'harbor-engine.spec'),
  ]);
  run(path.join(vendor, 'engine', 'harbor-engine.exe'), ['selftest']);
  copyLicenses();
}

/** The license file(s) of every bundled package go next to the engine (licenses/<package>/). */
function copyLicenses() {
  const out = path.join(vendor, 'engine', 'licenses');
  fs.rmSync(out, { recursive: true, force: true });
  run(py, [path.join('engine', 'collect_licenses.py'), out]);
  fs.copyFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), path.join(vendor, 'engine', 'THIRD_PARTY_NOTICES.md'));
}

(async () => {
  fs.mkdirSync(vendor, { recursive: true });
  buildEngine();
  await buildFfmpeg();
  console.log('[engine] done: vendor/engine and vendor/ffmpeg');
})().catch((err) => {
  console.error('[engine]', err.message);
  process.exit(1);
});
