/**
 * Renders build/icon.svg to PNGs with Electron's own Chromium, then packs a Windows .ico.
 *   npx electron scripts/build-icon.js
 * Output: build/icon.png (1024), build/icons/<size>.png, build/icon.ico (16–256)
 * The .ico is packed in plain Node (PNG-compressed entries, supported since Vista).
 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const svg = fs.readFileSync(path.join(root, 'build', 'icon.svg'), 'utf8');
const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256, 512, 1024];
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const outDir = path.join(root, 'build', 'icons');
  fs.mkdirSync(outDir, { recursive: true });
  // One hidden page draws the SVG onto a canvas at every size (vector → crisp at each size)
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html,<!doctype html><title>icon</title>');
  const svgUrl = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
  const dataUrls = await win.webContents.executeJavaScript(`(async () => {
    const img = new Image();
    img.src = ${JSON.stringify(svgUrl)};
    await img.decode();
    const out = {};
    for (const size of ${JSON.stringify(SIZES)}) {
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const g = c.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(img, 0, 0, size, size);
      out[size] = c.toDataURL('image/png');
    }
    return out;
  })()`);
  win.destroy();
  const pngs = new Map();
  for (const size of SIZES) {
    const png = Buffer.from(dataUrls[size].split(',')[1], 'base64');
    pngs.set(size, png);
    fs.writeFileSync(path.join(outDir, `${size}.png`), png);
  }
  fs.writeFileSync(path.join(root, 'build', 'icon.png'), pngs.get(1024));
  fs.writeFileSync(path.join(root, 'build', 'icon.ico'), packIco(ICO_SIZES.map((s) => [s, pngs.get(s)])));
  console.log('[icon] wrote build/icon.png, build/icon.ico and build/icons/*.png');
  app.quit();
});

function packIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + dir.length;
  entries.forEach(([size, png], i) => {
    const o = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, o); // 0 means 256
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1);
    dir.writeUInt8(0, o + 2); // palette
    dir.writeUInt8(0, o + 3);
    dir.writeUInt16LE(1, o + 4); // planes
    dir.writeUInt16LE(32, o + 6); // bpp
    dir.writeUInt32LE(png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += png.length;
  });
  return Buffer.concat([header, dir, ...entries.map(([, png]) => png)]);
}
