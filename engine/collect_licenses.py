"""Copies the license file(s) of every package in the build venv to <out>/<name>-<version>/."""
import importlib.metadata as metadata
import os
import shutil
import sys

SKIP = {'pip', 'pyinstaller', 'pyinstaller-hooks-contrib', 'altgraph', 'pefile', 'pywin32-ctypes', 'setuptools'}
KEYWORDS = ('license', 'copying', 'notice', 'authors')


def main(out):
    for dist in metadata.distributions():
        name = dist.metadata['Name']
        if name.lower() in SKIP:
            continue
        dest = os.path.join(out, f'{name}-{dist.version}')
        os.makedirs(dest, exist_ok=True)
        for f in dist.files or []:
            if any(k in f.name.lower() for k in KEYWORDS):
                src = dist.locate_file(f)
                if os.path.isfile(src):
                    shutil.copyfile(src, os.path.join(dest, os.path.basename(str(f))))
        declared = dist.metadata.get('License-Expression') or dist.metadata.get('License') or ''
        with open(os.path.join(dest, 'LICENSE-NAME.txt'), 'w', encoding='utf-8') as fh:
            fh.write(declared.strip() + '\n')


if __name__ == '__main__':
    main(sys.argv[1])
