"""
harbor-engine spotify-list <playlist|album URL or ID>

Prints one JSON object with the complete track list of a public Spotify playlist or album:
    {"kind", "title", "cover", "description", "total",
     "tracks":  [{"id", "pos", "title", "artist", "album", "duration", "cover"}],
     "skipped": [{... same, "reason": "region" | "local" | "episode" | "unavailable"}]}
"pos" is the place in the original list, so a replacement can go back where it was.

Spotify's embed page (what the app used before) stops at 100 tracks and has no per-track art.
spotapi reads the web player's own API page by page, so a 1250-track playlist comes back whole,
each track with its album cover. Progress goes to stderr as "__PROGRESS__ done total".
"""
import html
import json
import re
import sys


def _best(sources, prefer=300):
    """The image closest to `prefer` px (big enough for a list row, not the 640 px original)."""
    imgs = [s for s in (sources or []) if isinstance(s, dict) and s.get('url')]
    if not imgs:
        return None
    sized = [s for s in imgs if s.get('width')]
    if not sized:
        return imgs[0]['url']
    return min(sized, key=lambda s: abs((s.get('width') or 0) - prefer))['url']


def _artists(node):
    items = ((node or {}).get('artists') or {}).get('items') or []
    return ', '.join(a.get('profile', {}).get('name', '') for a in items if a.get('profile')) or None


def _track_id(uri):
    return uri.split(':')[-1] if isinstance(uri, str) and uri.startswith('spotify:track:') else None


def _text(raw, limit=1000):
    """Spotify descriptions are HTML ("<a href=...>", "&amp;"); keep plain text."""
    if not isinstance(raw, str):
        return None
    text = html.unescape(re.sub(r'<[^>]+>', '', raw)).strip()
    return text[:limit] or None


def _unplayable(data, tid):
    """Why a playlist item can't be played here (None when it can).
    'region' (COUNTRY_RESTRICTED, the usual one), 'local' (a file on the owner's computer),
    'episode' (a podcast episode), 'unavailable' (removed or not released)."""
    uri = data.get('uri') or ''
    if uri.startswith('spotify:local:'):
        return 'local'
    if uri.startswith('spotify:episode:'):
        return 'episode'
    play = data.get('playability') or {}
    if not tid:
        return 'unavailable'
    if play.get('playable') is False:
        return 'region' if play.get('reason') == 'COUNTRY_RESTRICTED' else 'unavailable'
    return None


def _local_title(uri):
    """spotify:local:Artist:Album:Title:Seconds → Title"""
    parts = (uri or '').split(':')
    if len(parts) >= 5 and parts[1] == 'local':
        from urllib.parse import unquote_plus
        return unquote_plus(parts[4]) or None
    return None


def _progress(done, total):
    print(f'__PROGRESS__ {done} {total}', file=sys.stderr, flush=True)


def playlist(pid):
    import spotapi
    pl = spotapi.PublicPlaylist(pid)
    info = pl.get_playlist_info(limit=1)['data']['playlistV2']
    total = (info.get('content') or {}).get('totalCount') or 0
    images = (info.get('images') or {}).get('items') or []
    cover = _best(images[0].get('sources'), prefer=640) if images else None
    _progress(0, total)  # the size is known before the first page: the bar can start filling
    tracks, skipped = [], []
    pos = 0  # place in the playlist, counting the tracks that can't be played too
    for page in pl.paginate_playlist():
        for it in page.get('items') or []:
            data = ((it.get('itemV2') or {}).get('data')) or {}
            album = data.get('albumOfTrack') or {}
            entry = {
                'pos': pos,
                'title': data.get('name'),
                'artist': _artists(data),
                'album': album.get('name') or None,
                'duration': round(((data.get('trackDuration') or {}).get('totalMilliseconds') or 0) / 1000) or None,
                'cover': _best((album.get('coverArt') or {}).get('sources')) or cover,
            }
            pos += 1
            tid = _track_id(data.get('uri'))
            reason = _unplayable(data, tid)
            if reason:
                skipped.append({**entry, 'id': tid, 'title': entry['title'] or _local_title(data.get('uri')), 'reason': reason})
                continue
            tracks.append({**entry, 'id': tid, 'title': entry['title'] or tid})
        _progress(pos, total)
    return {'kind': 'playlist', 'title': info.get('name') or 'Spotify', 'cover': cover,
            'description': _text(info.get('description')), 'total': total, 'tracks': tracks, 'skipped': skipped}


def album(aid):
    import spotapi
    al = spotapi.PublicAlbum(aid)
    info = al.get_album_info()['data']['albumUnion']
    cover = _best((info.get('coverArt') or {}).get('sources'))
    total = ((info.get('tracksV2') or {}).get('totalCount')) or 0
    _progress(0, total)
    tracks, skipped = [], []
    pos = 0
    for page in al.paginate_album():
        for it in page or []:
            data = it.get('track') or it
            entry = {
                'pos': pos,
                'title': data.get('name'),
                'artist': _artists(data),
                'album': info.get('name') or None,
                'duration': round(((data.get('duration') or {}).get('totalMilliseconds') or 0) / 1000) or None,
                'cover': cover,  # an album's tracks share its cover
            }
            pos += 1
            tid = _track_id(data.get('uri'))
            reason = _unplayable(data, tid)
            if reason:
                skipped.append({**entry, 'id': tid, 'title': entry['title'] or '?', 'reason': reason})
                continue
            tracks.append({**entry, 'id': tid, 'title': entry['title'] or tid})
        _progress(pos, total)
    return {'kind': 'album', 'title': info.get('name') or 'Spotify', 'cover': cover, 'total': total,
            'tracks': tracks, 'skipped': skipped}


def main():
    if len(sys.argv) < 2:
        print('usage: spotify-list <playlist|album URL>', file=sys.stderr)
        return 2
    m = re.search(r'(playlist|album)[/:]([A-Za-z0-9]{10,})', sys.argv[1])
    if not m:
        print('not a Spotify playlist or album', file=sys.stderr)
        return 2
    result = playlist(m.group(2)) if m.group(1) == 'playlist' else album(m.group(2))
    sys.stdout.write(json.dumps(result, ensure_ascii=False))
    sys.stdout.flush()
    return 0
