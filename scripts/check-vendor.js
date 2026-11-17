// npm run dist refuses to build an installer without the bundled tools (npm run build:engine)
const fs = require('fs');
const path = require('path');
const vendor = path.resolve(__dirname, '..', 'vendor');
const missing = ['engine/harbor-engine.exe', 'ffmpeg/ffmpeg.exe', 'ffmpeg/ffprobe.exe'].filter((f) => !fs.existsSync(path.join(vendor, f)));
if (missing.length) {
  console.error(`[dist] missing ${missing.map((m) => 'vendor/' + m).join(', ')}. Run: npm run build:engine`);
  process.exit(1);
}
