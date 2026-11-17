"""
MP3 cover & ID3 normalizer for Windows Explorer / Windows Media Player compatibility.

Usage:
    python tagger.py <file.mp3> [--mode clean|preserve]

Modes:
    clean     (default, for YouTube/yt-dlp sources)
              Rebuilds the tag from scratch: cleaned title/artist, album = title,
              1:1 cover. Drops bloated TXXX/COMM frames (video descriptions, links)
              that break Media Player's parser.
    preserve  (for spotdl sources, which already write rich & correct metadata)
              Keeps every real tag (album, year, track no, lyrics, ...). Only
              normalizes the cover to a single 1:1 JPEG front cover, removes
              ffmpeg container junk (TXXX:major_brand etc.) and saves as ID3v2.3.

Only companion files that share the MP3's base name (e.g. "Song.jpg",
"Song.webp") are removed. Other files in the folder are never touched, so
parallel downloads into the same folder are safe.
"""
import sys
import os
import io
import re
import argparse
import json

# The app runs us with `python -I` (isolated), which ignores PYTHONIOENCODING. On Windows a
# piped stdout then defaults to the ANSI code page and printing a file name such as
# "Şarkı ｜ Live.mp3" raises UnicodeEncodeError before any tag is written. Force UTF-8.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding='utf-8', errors='replace')
    except (AttributeError, ValueError):
        pass

COVER_SIZE = 600
COMPANION_EXTS = ['.jpg', '.jpeg', '.webp', '.png']
# TXXX frames that ffmpeg copies from the source container; meaningless for MP3
CONTAINER_JUNK_TXXX = {'major_brand', 'minor_version', 'compatible_brands', 'encoder', 'handler_name', 'vendor_id'}


def log(msg):
    print(f"[tagger] {msg}", flush=True)


def clean_title_and_artist(raw_title, raw_artist):
    # Remove YouTube video ID: e.g. "Song Name [WbD8UaE2ohE]" -> "Song Name"
    title = re.sub(r'\s*\[[a-zA-Z0-9_-]{11}\]', '', raw_title).strip()
    # Remove common video clutter like (Official Music Video), [Lyric Video], (HD), etc.
    title = re.sub(
        r'\s*[\(\[](?:Official\s+)?(?:Audio|Video|Music\s+Video|Lyric\s+Video|Lyrics|Official\s+Audio|HD|HQ|4K|Visualizer)[\)\]]',
        '', title, flags=re.IGNORECASE).strip()

    artist = raw_artist.strip() if raw_artist else ''

    # If artist is empty and title has "Artist - Song", split it
    if not artist and ' - ' in title:
        parts = title.split(' - ', 1)
        artist = parts[0].strip()
        title = parts[1].strip()

    if not artist:
        artist = 'Unknown Artist'
    if not title:
        title = raw_title

    return title, artist


def to_square_jpeg(data):
    from PIL import Image
    img = Image.open(io.BytesIO(data)).convert('RGB')
    w, h = img.size
    side = min(w, h)
    left = (w - side) // 2
    top = (h - side) // 2
    img = img.crop((left, top, left + side, top + side))
    if side != COVER_SIZE:
        img = img.resize((COVER_SIZE, COVER_SIZE), Image.Resampling.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format='JPEG', quality=95)
    return buf.getvalue()


def find_cover(tags, folder, base_name):
    """Embedded APIC (front cover preferred) first, then a companion image with the same base name."""
    if tags:
        apics = [tags[k] for k in tags.keys() if k.startswith('APIC')]
        apics.sort(key=lambda a: 0 if a.type == 3 else 1)
        if apics:
            log(f"Found embedded cover ({len(apics[0].data)} bytes)")
            return apics[0].data
    for ext in COMPANION_EXTS:
        candidate = os.path.join(folder, base_name + ext)
        if os.path.isfile(candidate):
            try:
                with open(candidate, 'rb') as f:
                    log(f"Using companion image: {candidate}")
                    return f.read()
            except OSError:
                pass
    return None


def process_file(file_path, mode, cover_out=None, info_only=False):
    from mutagen.mp3 import MP3
    from mutagen.id3 import TIT2, TPE1, TALB, APIC, PictureType, Encoding

    folder = os.path.dirname(os.path.abspath(file_path))
    base_name = os.path.splitext(os.path.basename(file_path))[0]
    log(f"Processing ({mode}): {file_path}")

    m = MP3(file_path)
    cover = find_cover(m.tags, folder, base_name)
    if info_only:
        # Read-only: report tags and cover for the app's history, never touch the file
        report_info(m, cover, cover_out)
        return True
    if cover:
        try:
            cover = to_square_jpeg(cover)
            log(f"Cover normalized to {COVER_SIZE}x{COVER_SIZE} JPEG ({len(cover)} bytes)")
        except Exception as e:
            log(f"Warning: could not normalize cover: {e}")

    if m.tags is None:
        m.add_tags()

    if mode == 'clean':
        orig_title = str(m.tags.get('TIT2', base_name))
        orig_artist = str(m.tags.get('TPE1', ''))
        title, artist = clean_title_and_artist(orig_title, orig_artist)
        # Wipe bloated TXXX descriptions & comments that break Media Player
        m.tags.clear()
        m.tags.add(TIT2(encoding=Encoding.UTF16, text=[title]))
        m.tags.add(TPE1(encoding=Encoding.UTF16, text=[artist]))
        m.tags.add(TALB(encoding=Encoding.UTF16, text=[title]))
        log(f"Clean tags: {title} - {artist}")
    else:
        for key in list(m.tags.keys()):
            if key.startswith('APIC'):
                del m.tags[key]
            elif key.startswith('TXXX:') and key[5:].lower() in CONTAINER_JUNK_TXXX:
                del m.tags[key]
        log("Preserved existing metadata")

    if cover:
        m.tags.add(APIC(encoding=Encoding.LATIN1, mime='image/jpeg',
                        type=PictureType.COVER_FRONT, desc='', data=cover))

    # ID3v2.3 + ID3v1 footer for universal Windows & mobile compatibility
    m.save(v2_version=3, v1=2)
    log("Saved as ID3v2.3")

    report_info(m, cover, cover_out)

    # Remove only this file's own companion files
    for ext in COMPANION_EXTS + ['.part', '.ytdl']:
        junk = os.path.join(folder, base_name + ext)
        if os.path.isfile(junk) and os.path.abspath(junk) != os.path.abspath(file_path):
            try:
                os.remove(junk)
                log(f"Deleted companion file: {junk}")
            except OSError as e:
                log(f"Could not delete {junk}: {e}")
    return True


def report_info(m, cover, cover_out):
    """Prints one `__INFO__ {json}` line the app reads (spotdl prints no metadata of its own)."""
    if cover and cover_out:
        try:
            from PIL import Image
            img = Image.open(io.BytesIO(cover)).convert('RGB')
            img.thumbnail((300, 300), Image.Resampling.LANCZOS)
            os.makedirs(os.path.dirname(cover_out), exist_ok=True)
            img.save(cover_out, format='JPEG', quality=88)
        except Exception as e:
            log(f"Could not write cover thumbnail: {e}")
            cover_out = None
    tags = m.tags or {}

    def text(key):
        frame = tags.get(key)
        return ', '.join(str(t) for t in frame.text) if frame is not None and frame.text else None

    info = {
        'title': text('TIT2'),
        'artist': text('TPE1'),
        'album': text('TALB'),
        'duration': round(m.info.length) if m.info and m.info.length else None,
        'cover': cover_out if cover and cover_out else None,
    }
    print('__INFO__ ' + json.dumps(info, ensure_ascii=False), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('file')
    parser.add_argument('legacy_folder', nargs='?', help=argparse.SUPPRESS)  # ignored, kept for old callers
    parser.add_argument('--mode', choices=['clean', 'preserve'], default='clean')
    parser.add_argument('--cover-out', help='write a 300px JPEG of the cover here')
    parser.add_argument('--info-only', action='store_true', help='only report tags/cover, do not modify the file')
    args = parser.parse_args()

    if not os.path.isfile(args.file):
        print(f"[tagger] Error: file does not exist: {args.file}", file=sys.stderr)
        return 1
    if not args.file.lower().endswith('.mp3'):
        log("Not an MP3, skipping")
        return 0
    try:
        process_file(args.file, args.mode, args.cover_out, args.info_only)
        return 0
    except Exception as e:
        import traceback
        print(f"[tagger] Error: {e}", file=sys.stderr)
        traceback.print_exc()
        return 1


if __name__ == '__main__':
    sys.exit(main())
