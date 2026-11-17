const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const srcRenderer = path.join(root, 'src', 'renderer');
const distRenderer = path.join(root, 'dist', 'renderer');
const watch = process.argv.includes('--watch');

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function copyStatic() {
  copyFile(path.join(srcRenderer, 'index.html'), path.join(distRenderer, 'index.html'));
  copyFile(path.join(srcRenderer, 'style.css'), path.join(distRenderer, 'style.css'));
  copyFile(path.join(srcRenderer, 'features.css'), path.join(distRenderer, 'features.css'));
  copyFile(path.join(srcRenderer, 'theme-claude.css'), path.join(distRenderer, 'theme-claude.css'));
  copyFile(path.join(srcRenderer, 'media.css'), path.join(distRenderer, 'media.css'));
  copyFile(path.join(srcRenderer, 'videocontrols.css'), path.join(distRenderer, 'videocontrols.css'));
  copyFile(path.join(srcRenderer, 'motion.css'), path.join(distRenderer, 'motion.css'));

  // Bundled fonts (offline-safe, allowed by the CSP's font-src 'self')
  const fontsDist = path.join(distRenderer, 'fonts');
  copyFile(path.join(srcRenderer, 'fonts', 'fonts.css'), path.join(fontsDist, 'fonts.css'));
  const fontFiles = [
    ['plus-jakarta-sans', 'plus-jakarta-sans-latin-wght-normal.woff2'],
    ['plus-jakarta-sans', 'plus-jakarta-sans-latin-ext-wght-normal.woff2'],
    ['jetbrains-mono', 'jetbrains-mono-latin-wght-normal.woff2'],
    ['jetbrains-mono', 'jetbrains-mono-latin-ext-wght-normal.woff2'],
  ];
  for (const [pkg, file] of fontFiles) {
    copyFile(path.join(root, 'node_modules', '@fontsource-variable', pkg, 'files', file), path.join(fontsDist, file));
  }
  console.log('[renderer] Copied index.html, style.css and fonts');
}

const buildOptions = {
  entryPoints: [path.join(srcRenderer, 'renderer.ts')],
  bundle: true,
  outfile: path.join(distRenderer, 'bundle.js'),
  platform: 'browser',
  target: ['chrome120', 'es2022'],
  sourcemap: true,
  logLevel: 'info',
};

async function main() {
  copyStatic();
  if (!watch) {
    await esbuild.build(buildOptions);
    return;
  }

  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  // Re-copy HTML/CSS when they change (esbuild only watches the TS graph)
  let timer = null;
  fs.watch(srcRenderer, { recursive: true }, (_event, file) => {
    if (!file || !/\.(html|css)$/i.test(file)) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        copyStatic();
      } catch (err) {
        console.error('[renderer] copy failed:', err.message);
      }
    }, 100);
  });
  console.log('[renderer] Watching for changes...');
}

main().catch((err) => {
  console.error('Bundle failed:', err);
  process.exit(1);
});
