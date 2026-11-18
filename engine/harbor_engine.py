"""
Harbor's bundled Python engine. Frozen with PyInstaller into one folder (harbor-engine.exe +
its own Python runtime), so users don't need Python, pip or any package installed.

    harbor-engine yt-dlp  <args>   yt-dlp
    harbor-engine spotdl  <args>   spotDL (with the faster Spotify lookups of spotdl_fast.py)
    harbor-engine tagger  <args>   scripts/tagger.py
    harbor-engine scan    <args>   scripts/scan_media.py
    harbor-engine spotify-list <url>  full Spotify playlist/album as JSON (engine/spotify_list.py)
    harbor-engine selftest         imports everything once (first-run check)

yt-dlp has to stay current because sites change often. The app can download a newer yt-dlp
(the official pure-Python zip) and pass its path in HARBOR_YTDLP_ZIP; it is then imported
instead of the frozen copy, for both yt-dlp and spotDL.
"""
import os
import sys


def _use_updated_ytdlp():
    zip_path = os.environ.get('HARBOR_YTDLP_ZIP')
    if not zip_path or not os.path.isfile(zip_path):
        return
    # Make sure nothing frozen is cached, then let the zip win the import of yt_dlp
    for name in [m for m in sys.modules if m == 'yt_dlp' or m.startswith('yt_dlp.')]:
        del sys.modules[name]
    sys.path.insert(0, zip_path)
    from importlib.machinery import PathFinder

    class _ZipFirst:
        """
        PyInstaller's frozen importer sits early in sys.meta_path, so sys.path order alone
        isn't enough. This finder answers first for yt_dlp: the package from the zip, and its
        submodules from the package's own (zip) __path__.
        """

        def find_spec(self, fullname, path=None, target=None):
            if fullname == 'yt_dlp':
                return PathFinder.find_spec(fullname, [zip_path])
            if fullname.startswith('yt_dlp.') and path:
                return PathFinder.find_spec(fullname, path)
            return None

    sys.meta_path.insert(0, _ZipFirst())


def main():
    if len(sys.argv) < 2:
        print('usage: harbor-engine <yt-dlp|spotdl|spotify-list|tagger|scan|selftest> [args...]', file=sys.stderr)
        return 2
    command = sys.argv[1]
    sys.argv = [command] + sys.argv[2:]

    if command == 'yt-dlp':
        _use_updated_ytdlp()
        import yt_dlp
        return yt_dlp.main()

    if command == 'spotdl':
        _use_updated_ytdlp()
        import spotdl_fast
        spotdl_fast._patch_spotapi()
        from spotdl.console import console_entry_point
        return console_entry_point()

    if command == 'spotify-list':
        import spotdl_fast
        spotdl_fast._patch_spotapi()
        import spotify_list
        return spotify_list.main()

    if command == 'tagger':
        import tagger
        return tagger.main()

    if command == 'scan':
        import scan_media
        return scan_media.main()

    if command == 'selftest':
        _use_updated_ytdlp()
        import yt_dlp, spotdl, mutagen, PIL  # noqa: F401
        import spotdl_fast, tagger, scan_media, spotify_list  # noqa: F401
        from spotdl.console import console_entry_point  # noqa: F401
        print('ok', yt_dlp.version.__version__, spotdl.__version__)
        return 0

    print(f'unknown command: {command}', file=sys.stderr)
    return 2


if __name__ == '__main__':
    sys.exit(main() or 0)
