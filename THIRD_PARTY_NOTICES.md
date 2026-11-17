# Third-party software in Harbor

Harbor's own code (everything in this repository) is released under the [MIT license](LICENSE).

The Windows installer also ships two separate programs that Harbor starts as child processes:

## 1. Harbor engine (`resources/engine`)

A frozen Python 3.12 runtime (built with PyInstaller from `engine/`) that contains:

| Component | License | Source |
|---|---|---|
| yt-dlp | Unlicense | https://github.com/yt-dlp/yt-dlp |
| spotDL | MIT | https://github.com/spotDL/spotify-downloader |
| spotapi | GPL-3.0 | https://pypi.org/project/spotapi/ |
| SpotipyFree | MIT | https://pypi.org/project/spotipyFree/ |
| mutagen | GPL-2.0-or-later | https://github.com/quodlibet/mutagen |
| Pillow | MIT-CMU | https://github.com/python-pillow/Pillow |
| pykakasi | GPL-3.0-or-later | https://codeberg.org/miurahr/pykakasi |
| Unidecode, text-unidecode | GPL-2.0-or-later | https://pypi.org/project/Unidecode/ |
| Python | PSF License | https://www.python.org |
| and their dependencies | MIT / BSD / Apache-2.0 / MPL-2.0 / ISC | listed in `engine/requirements.lock.txt` |

Because it includes GPL-licensed packages, **the engine as a whole is distributed under the
GNU GPL, version 3 or later**. Its complete corresponding source is public: Harbor's engine
code is in [`engine/`](engine/) and [`scripts/`](scripts/) of this repository, and every
package is available at the exact version listed in
[`engine/requirements.lock.txt`](engine/requirements.lock.txt) on PyPI. `npm run build:engine`
rebuilds it. The license text of each package is installed next to the engine in
`resources/engine/licenses/`.

## 2. FFmpeg (`resources/ffmpeg`)

FFmpeg 9.0.2, LGPL "shared" build by [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds)
(`ffmpeg-n9.0.2-39-g7adfbe40dc-win64-lgpl-shared-9.0.zip`, verified against the release's
checksums). Licensed under the GNU LGPL, version 2.1 or later; see `resources/ffmpeg/LICENSE.txt`.
Source code: https://ffmpeg.org/download.html and https://github.com/BtbN/FFmpeg-Builds.

## 3. Electron

Electron and Chromium, MIT and various open-source licenses; see `LICENSES.chromium.html` in
the installation folder.
