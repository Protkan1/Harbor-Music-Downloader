/**
 * Development mode: `npm run dev`
 *  - tsc --watch for main/preload/shared
 *  - esbuild --watch for the renderer (press Ctrl+R in the app to reload UI changes)
 *  - restarts Electron automatically when main/preload output really changes
 *
 * Why the extra care: `tsc --watch` recompiles everything once when it starts and rewrites
 * dist/ with identical files. Restarting on every write made the app open, close and open
 * again right after launch. Now Electron restarts only after tsc's first watch pass, and only
 * when a file's content hash differs from what Electron was started with.
 */
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const electronPath = require('electron'); // resolves to the electron executable path
const tscBin = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
const WATCHED = ['dist/main', 'dist/preload', 'dist/shared'].map((d) => path.join(root, d));

// 1. One full build first so Electron has something to load
console.log('[dev] Initial build...');
for (const args of [[tscBin], [path.join(__dirname, 'build-renderer.js')]]) {
  const r = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

// Content hashes of the main-process output Electron is running
const hashes = new Map();
const hashFile = (f) => {
  try {
    return crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex');
  } catch {
    return null;
  }
};
const snapshot = () => {
  hashes.clear();
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const n of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, n.name);
      if (n.isDirectory()) walk(full);
      else if (n.name.endsWith('.js')) hashes.set(full, hashFile(full));
    }
  };
  WATCHED.forEach(walk);
};
snapshot();

// 2. Watchers
const children = [];
let tscReady = false; // ignore tsc's initial full re-emit
const tsc = spawn(process.execPath, [tscBin, '--watch', '--preserveWatchOutput'], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] });
children.push(tsc);
tsc.stdout.on('data', (d) => {
  const text = d.toString();
  process.stdout.write(text);
  if (/Watching for file changes/i.test(text) && !tscReady) {
    tscReady = true;
    snapshot(); // whatever the first pass wrote is what Electron already runs
  }
});
children.push(spawn(process.execPath, [path.join(__dirname, 'build-renderer.js'), '--watch'], { cwd: root, stdio: 'inherit' }));

// 3. Electron with auto-restart
let electron = null;
let restarting = false;
function startElectron() {
  electron = spawn(electronPath, ['.'], { cwd: root, stdio: 'inherit' });
  electron.on('exit', () => {
    if (!restarting) shutdown(); // user closed the window
  });
}
function restartElectron() {
  restarting = true;
  if (electron && electron.exitCode === null) {
    electron.once('exit', () => {
      restarting = false;
      startElectron();
    });
    electron.kill();
  } else {
    restarting = false;
    startElectron();
  }
}

let timer = null;
const changed = new Set();
for (const dir of WATCHED) {
  if (!fs.existsSync(dir)) continue;
  fs.watch(dir, { recursive: true }, (_e, file) => {
    if (!tscReady || !file || !file.endsWith('.js')) return;
    changed.add(path.join(dir, file));
    clearTimeout(timer);
    timer = setTimeout(() => {
      const really = [...changed].filter((f) => {
        const h = hashFile(f);
        const differs = h !== hashes.get(f);
        hashes.set(f, h);
        return differs;
      });
      changed.clear();
      if (really.length) {
        console.log(`[dev] Main process changed (${really.map((f) => path.relative(root, f)).join(', ')}), restarting Electron...`);
        restartElectron();
      }
    }, 300);
  });
}

function shutdown() {
  for (const c of children) c.kill();
  process.exit(0);
}
process.on('SIGINT', shutdown);

startElectron();
