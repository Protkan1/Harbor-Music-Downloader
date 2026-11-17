"""
Reads tags, length and cover art of local audio files for the app's library (read-only).

Usage:
    python scan_media.py <list.json> <covers_dir>

<list.json> is a UTF-8 JSON array of absolute file paths. For every file one line is printed:
    __ITEM__ {"path": ..., "title": ..., "artist": ..., "album": ..., "duration": ..., "cover": ...}
and every 25 files:
    __PROG__ <done>/<total>

Covers are written once per distinct image (named by a hash of the picture bytes), as 300px
JPEGs, so a 1,000-song album collection produces one thumbnail per album, not per song.
"""
import sys
import os
import io
import json
import base64
import hashlib

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding='utf-8', errors='replace')
    except (AttributeError, ValueError):
        pass


def first(tags, key):
    try:
        v = tags.get(key)
    except Exception:
        return None
    if not v:
        return None
    if isinstance(v, (list, tuple)):
        v = ', '.join(str(x) for x in v if str(x).strip())
    v = str(v).strip()
    return v or None


def picture_bytes(path):
    """Embedded front cover bytes for ID3 / MP4 / FLAC / Ogg, or None."""
    import mutagen
    try:
        f = mutagen.File(path)
    except Exception:
        return None
    if f is None:
        return None
    tags = getattr(f, 'tags', None)
    # FLAC
    pics = getattr(f, 'pictures', None)
    if pics:
        pics = sorted(pics, key=lambda p: 0 if getattr(p, 'type', 0) == 3 else 1)
        return pics[0].data
    if tags is None:
        return None
    # ID3 (mp3, wav, aiff)
    try:
        apics = [tags[k] for k in tags.keys() if str(k).startswith('APIC')]
        if apics:
            apics.sort(key=lambda a: 0 if getattr(a, 'type', 0) == 3 else 1)
            return apics[0].data
    except Exception:
        pass
    # MP4 (m4a / aac)
    try:
        covr = tags.get('covr')
        if covr:
            return bytes(covr[0])
    except Exception:
        pass
    # Ogg Vorbis / Opus
    try:
        blocks = tags.get('metadata_block_picture')
        if blocks:
            from mutagen.flac import Picture
            return Picture(base64.b64decode(blocks[0])).data
    except Exception:
        pass
    return None


def save_cover(data, covers_dir, made):
    digest = hashlib.sha1(data).hexdigest()[:20]
    out = os.path.join(covers_dir, f'{digest}.jpg')
    if digest in made or os.path.isfile(out):
        made.add(digest)
        return out
    try:
        from PIL import Image
        img = Image.open(io.BytesIO(data)).convert('RGB')
        img.thumbnail((300, 300), Image.Resampling.LANCZOS)
        img.save(out, format='JPEG', quality=86)
        made.add(digest)
        return out
    except Exception:
        return None


def main():
    if len(sys.argv) < 3:
        print('usage: scan_media.py <list.json> <covers_dir>', file=sys.stderr)
        return 1
    with open(sys.argv[1], encoding='utf-8') as fh:
        paths = json.load(fh)
    covers_dir = sys.argv[2]
    os.makedirs(covers_dir, exist_ok=True)
    import mutagen

    made = set()
    total = len(paths)
    for i, path in enumerate(paths, 1):
        item = {'path': path, 'title': None, 'artist': None, 'album': None, 'duration': None, 'cover': None}
        try:
            easy = mutagen.File(path, easy=True)
            if easy is not None:
                if easy.info is not None and getattr(easy.info, 'length', None):
                    item['duration'] = round(easy.info.length)
                tags = easy.tags or {}
                item['title'] = first(tags, 'title')
                item['artist'] = first(tags, 'artist') or first(tags, 'albumartist')
                item['album'] = first(tags, 'album')
            data = picture_bytes(path)
            if data:
                item['cover'] = save_cover(data, covers_dir, made)
        except Exception as e:
            item['error'] = str(e)[:200]
        print('__ITEM__ ' + json.dumps(item, ensure_ascii=False), flush=False)
        if i % 25 == 0 or i == total:
            print(f'__PROG__ {i}/{total}', flush=True)
    sys.stdout.flush()
    return 0


if __name__ == '__main__':
    sys.exit(main())
