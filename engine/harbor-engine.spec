# PyInstaller spec for Harbor's Python engine (run by scripts/build-engine.js).
# One folder: harbor-engine.exe + _internal (Python runtime and packages).
import os
from PyInstaller.utils.hooks import collect_all

ROOT = os.path.abspath(os.path.join(SPECPATH, '..'))
SCRIPTS = os.path.join(ROOT, 'scripts')

datas, binaries, hiddenimports = [], [], ['tagger', 'scan_media', 'spotdl_fast']
# Packages that load modules or data files dynamically
for pkg in ('spotdl', 'ytmusicapi', 'pykakasi', 'spotapi', 'SpotipyFree', 'syncedlyrics',
            'curl_cffi', 'certifi', 'yt_dlp_ejs', 'rich'):
    d, b, h = collect_all(pkg)
    datas += d
    binaries += b
    hiddenimports += h

a = Analysis(
    [os.path.join(SPECPATH, 'harbor_engine.py')],
    pathex=[SCRIPTS],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    excludes=['tkinter', 'unittest', 'pydoc_data', 'test'],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [('X utf8', None, 'OPTION')],  # UTF-8 everywhere (song titles in any language)
    exclude_binaries=True,
    name='harbor-engine',
    console=True,  # stdout/stderr are read by the app; it is started with windowsHide
    icon=os.path.join(ROOT, 'build', 'icon.ico'),
    upx=False,
)
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name='engine')
