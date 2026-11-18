"""
harbor-engine spotify-list <playlist|album URL or ID>

Prints one JSON object with the complete track list of a public Spotify playlist or album:
    {"kind", "title", "cover", "total", "tracks": [{"id", "title", "artist", "duration", "cover"}]}

Spotify's embed page (what the app used before) stops at 100 tracks and has no per-track art.
spotapi reads the web player's own API page by page, so a 1250-track playlist comes back whole,
each track with its album cover. Progress goes to stderr as "__PROGRESS__ done total".
"""
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


def _progress(done, total):
    print(f'__PROGRESS__ {done} {total}', file=sys.stderr, flush=True)


def playlist(pid):
    import spotapi
    pl = spotapi.PublicPlaylist(pid)
    info = pl.get_playlist_info(limit=1)['data']['playlistV2']
    total = (info.get('content') or {}).get('totalCount') or 0
    images = (info.get('images') or {}).get('items') or []
    cover = _best(images[0].get('sources')) if images else None
    tracks = []
    for page in pl.paginate_playlist():
        for it in page.get('items') or []:
            data = ((it.get('itemV2') or {}).get('data')) or {}
            tid = _track_id(data.get('uri'))
            if not tid or (data.get('playability') or {}).get('playable') is False:
                continue
            album = data.get('albumOfTrack') or {}
            tracks.append({
                'id': tid,
                'title': data.get('name') or tid,
                'artist': _artists(data),
                'duration': round(((data.get('trackDuration') or {}).get('totalMilliseconds') or 0) / 1000) or None,
                'cover': _best((album.get('coverArt') or {}).get('sources')) or cover,
            })
        _progress(len(tracks), total)
    return {'kind': 'playlist', 'title': info.get('name') or 'Spotify', 'cover': cover, 'total': total, 'tracks': tracks}


def album(aid):
    import spotapi
    al = spotapi.PublicAlbum(aid)
    info = al.get_album_info()['data']['albumUnion']
    cover = _best((info.get('coverArt') or {}).get('sources'))
    total = ((info.get('tracksV2') or {}).get('totalCount')) or 0
    tracks = []
    for page in al.paginate_album():
        for it in page or []:
            data = it.get('track') or it
            tid = _track_id(data.get('uri'))
            if not tid or (data.get('playability') or {}).get('playable') is False:
                continue
            tracks.append({
                'id': tid,
                'title': data.get('name') or tid,
                'artist': _artists(data),
                'duration': round(((data.get('duration') or {}).get('totalMilliseconds') or 0) / 1000) or None,
                'cover': cover,  # an album's tracks share its cover
            })
        _progress(len(tracks), total)
    return {'kind': 'album', 'title': info.get('name') or 'Spotify', 'cover': cover, 'total': total, 'tracks': tracks}


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
