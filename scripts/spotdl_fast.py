"""
Runs spotdl with one speed fix, without touching the installed packages.

spotdl (4.6+) reads Spotify through SpotipyFree -> spotapi. For every Spotify object
(track, artist, album ...) spotapi builds a fresh client that downloads ~80 web-player
JavaScript chunks *one by one* just to find GraphQL operation hashes: ~6-7 s per call,
~20 s before a single song even starts.

This wrapper patches spotapi.BaseClient.get_sha256_hash in this process only:
  - the chunks are fetched in parallel, and
  - the result is reused by every later client in the same run.
If anything about spotapi looks different (an update changed it), the original method is
used unchanged, so the worst case is the old speed, never a failure.

usage: python spotdl_fast.py <spotdl arguments...>
"""
import sys


def _patch_spotapi():
    try:
        from concurrent.futures import ThreadPoolExecutor
        import spotapi.client as sc
    except Exception:
        return

    base = getattr(sc, 'BaseClient', None)
    original = getattr(base, 'get_sha256_hash', None) if base else None
    needed = ('extract_mappings', 'combine_chunks', '_Undefined')
    if original is None or not all(hasattr(sc, n) for n in needed):
        return

    cache = {}

    def fast_get_sha256_hash(self):
        try:
            if self.js_pack is sc._Undefined:
                self.get_session()
            if self.js_pack is sc._Undefined:
                raise ValueError('no js pack')
            key = str(self.js_pack)
            if key in cache:
                self.raw_hashes = cache[key]
                return

            resp = self.client.get(key)
            if resp.fail:
                raise ValueError('js pack request failed')
            main = resp.response
            str_mapping, hash_mapping = sc.extract_mappings(str(main))
            urls = [
                f'https://open.spotifycdn.com/cdn/build/web-player/{s}'
                for s in sc.combine_chunks(hash_mapping, str_mapping)
            ]

            # Public CDN files: one pooled session (kept-alive connections), 16 at a time
            import requests
            from requests.adapters import HTTPAdapter

            session = requests.Session()
            session.mount('https://', HTTPAdapter(pool_connections=1, pool_maxsize=16))

            def fetch(url):
                r = session.get(url, timeout=20)
                r.raise_for_status()
                return r.text

            with ThreadPoolExecutor(max_workers=16) as pool:
                parts = list(pool.map(fetch, urls))  # keeps the original order
            session.close()

            raw = main + ''.join(parts)
            cache[key] = raw
            self.raw_hashes = raw
        except Exception:
            # Unknown shape or a network hiccup: do exactly what spotapi would have done
            original(self)

    base.get_sha256_hash = fast_get_sha256_hash


if __name__ == '__main__':
    _patch_spotapi()
    from spotdl.console import console_entry_point

    sys.argv = ['spotdl'] + sys.argv[1:]
    sys.exit(console_entry_point())
