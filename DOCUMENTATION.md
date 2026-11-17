# Harbor — Kapsamlı Mimari & Geliştirici Kılavuzu

> **Ad:** Uygulamanın görünen adı **Harbor** (liman: akıştaki müziğin ve videonun güvenle demirlediği yer). Eski adı AURA idi. `package.json` içindeki `name` (`spotdl-ytdlp-gui`) bilerek değiştirilmedi: Electron ayar/geçmiş/kitaplık klasörünü (`%APPDATA%/spotdl-ytdlp-gui`) bu addan türetir; değişirse kullanıcı verileri kaybolmuş gibi görünür. Aynı sebeple `productName` eklenmedi.

> **Not (Claude & Diğer AI Ajanları İçin):** Bu dökümantasyon, projenin mevcut durumu, mimarisi, IPC akışları, tema sistemleri, indirme & canlı akış motoru ve bilinen tüm püf noktalarını tek bir kaynakta toplamak üzere hazırlanmıştır. Projeye devam ederken bu dosyayı temel referans alabilirsiniz.

---

## 1. 📌 Proje Özeti ve Vizyonu

**Harbor**, Spotify, YouTube, SoundCloud ve diğer popüler platformlardan en yüksek kalitede ses (MP3) ve video (MP4 / MKV) indiren, aynı zamanda **reklamsız, donmasız ve canlı olarak 4K/2K/1080p medya oynatabilen** yeni nesil bir masaüstü uygulamasıdır.

- **Arayüz Dili:** Modern **iOS 26 Liquid Glass** & **AvaloniaUI Liquid Waves** optik kırılma estetiği, elastik kauçuk yay fiziği (rubber-band spring physics) ve 3 farklı tam teşekküllü tema.
- **Çekirdek Teknolojiler:** **Electron 45+**, **TypeScript 5.7+**, **esbuild**, **Node.js**, **yt-dlp**, **SpotDL**, **FFmpeg**, **Python 3 + Mutagen + Pillow**.

---

## 2. 🏗️ Mimari Yapı ve Süreç Akışı (Architecture)

Uygulama klasik güvenli Electron çift süreçli (Two-Process Architecture) modelini uygular:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        RENDERER PROCESS (Chromium)                     │
│  index.html  │  style.css  │  bundle.js (renderer.ts, ElasticSlider)   │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ window.electronAPI (contextBridge)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        PRELOAD LAYER (preload.ts)                      │
│     Giriş/Çıkış İzolasyonu, Tip Güvenli IPC Metotları                   │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ ipcRenderer.invoke / ipcMain.handle
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        MAIN PROCESS (Node.js)                          │
│  main.ts ──► ipcHandlers.ts                                            │
│                 ├── SettingsService (config.json)                      │
│                 ├── DownloadManager (yt-dlp, spotdl, scripts/tagger.py)│
│                 └── StreamManager (yt-dlp -J doğrudan CDN akışı)       │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 3. 📂 Proje Dosya Ağacı

```text
spotdl_gui/
├── package.json                    # Bağımlılıklar, scriptler, electron sürümü
├── tsconfig.json                   # TypeScript yapılandırması (ES2022, CommonJS)
├── DOCUMENTATION.md                # Bu dosya — ana mimari ve kullanım kılavuzu
├── scripts/
│   ├── build-renderer.js           # index.html, style.css, fontlar ve esbuild bundle (--watch destekli)
│   ├── dev.js                      # npm run dev: tsc/esbuild watch + Electron otomatik yeniden başlatma
│   ├── tagger.py                   # Python MP3 kapak & ID3v2.3 normalizasyonu (clean / preserve / --info-only)
│   ├── scan_media.py               # Yerel dosyaların etiket/süre/kapağını toplu okur (salt okunur)
│   ├── check-thumb.ps1             # Bir MP3'ün Windows'ta görünen etiket/kapak bilgisini kontrol eder
│   ├── check-ui.ps1                # Windows Media Player UI otomasyon kontrolü
│   └── screenshot.ps1              # Ekran görüntüsü (scripts/test_screen.png, git'e girmez)
└── src/
    ├── shared/
    │   ├── types.ts                # AppSettings, DownloadProgressPayload, StreamMediaInfo, Catalog*, HistoryEntry
    │   └── urls.ts                 # isSpotifyUrl, isPlaylistUrl, extractUrls (main + renderer ortak)
    ├── preload/
    │   └── preload.ts              # Electron API köprüsü (contextBridge)
    ├── main/
    │   ├── main.ts                 # BrowserWindow yaratımı, vibrancy ayarları, app yaşam döngüsü
    │   ├── ipcHandlers.ts          # IPC kanalları kaydı (settings, download, stream, system)
    │   └── services/
    │       ├── SettingsService.ts  # %APPDATA%/config.json kalıcı depolama yöneticisi
    │       ├── processUtils.ts     # Satır okuyucu, süreç ağacı sonlandırma (taskkill /T), Python bulucu
    │       ├── DownloadManager.ts  # Kuyruklu yt-dlp & spotdl indirme yöneticisi
    │       ├── CatalogService.ts   # Çalma listesi önizleme (YouTube/Spotify) + YouTube arama
    │       ├── HistoryService.ts   # %APPDATA%/history.json kalıcı indirme geçmişi
    │       ├── UpdateService.ts    # yt-dlp sürüm denetimi + otomatik güncelleme (pip / -U)
    │       ├── ProbeService.ts     # Link önizlemesi: tür, kapak, çözünürlük başına gerçek boyut
    │       ├── LibraryService.ts   # %APPDATA%/library.json: kullanıcı çalma listeleri, içe aktarma
    │       ├── SubtitleService.ts  # Altyazı (yt-dlp) + orijinalden çeviri, VTT temizleme
    │       ├── LocalImport.ts      # Yerel içe aktarma: M3U/M3U8/PLS/XML/TXT ayrıştırma, klasör tarama
    │       └── StreamManager.ts    # Reklamsız 4K/2K/1080p doğrudan akış çözümleme motoru
    └── renderer/
        ├── index.html              # AURA v2.0 & True Liquid Glass DOM yapısı
        ├── style.css               # ~2800 satır optik cam fiziği, temalar, animasyonlar
        ├── features.css            # Keşfet, Geçmiş, Toplu/Liste pencereleri, toast'lar, uyarılar
        ├── theme-claude.css        # 4. tema: Claude Theme — varsayılan (body[data-color-theme="claude"])
        ├── media.css               # Link önizlemesi, izleme sayfası, oynatıcı çubuğu, kitaplık, menüler
        ├── videocontrols.css       # İzleme sayfası video kontrolleri + altyazı (::cue)
        ├── renderer.ts             # Uygulama girişi: ayarlar, indirme kuyruğu kartları, link girişi
        ├── dom.ts                  # $, el, ikonlar, biçimlendiriciler, toast, queueDownloads, switchTab
        ├── player.ts               # İzleme sayfası (YouTube tarzı; modal yok) + mini oynatıcı devri
        ├── videocontrols.ts        # Özel video kontrolleri: ses, hız, dublaj, altyazı, klavye
        ├── playerbar.ts            # Alttaki kalıcı oynatıcı çubuğu (sıra, karıştır, tekrar, Media Session)
        ├── preview.ts              # Link önizleme kartı + kalite seçimi (requestFromOption)
        ├── library.ts              # Kitaplık sekmesi + "Listeye ekle" menüsü
        ├── modals.ts               # Toplu link penceresi + çalma listesi önizleme penceresi
        ├── explore.ts              # Keşfet sekmesi
        ├── history.ts              # Geçmiş sekmesi
        ├── updates.ts              # Ayarlar > Motor Güncellemeleri paneli
        ├── motion.ts               # Motion (Framer Motion) yay animasyonlu seçim göstergeleri
        ├── i18n.ts                 # TR/EN sözlük + t() + data-i18n uygulayıcı
        ├── fonts/fonts.css         # Yerel (offline) değişken font tanımları
        └── components/
            └── ElasticSlider.ts    # Apple iOS logaritmik yay dirençli elastik kaydırıcı
```

---

## 4. ⚙️ Çekirdek Servisler ve Çalışma Mekanizmaları

### 4.1. DownloadManager (`src/main/services/DownloadManager.ts`)
- **Kuyruk:** Her istek önce `queued` olur; aynı anda en fazla `maxConcurrentDownloads` (varsayılan 3, Ayarlar > Depolama) görev çalışır, diğerleri sırada bekler. Sıradaki görev iptal edilirse hiç başlatılmaz.
- **Akıllı Araç Yönlendirmesi:**
  - Spotify linki ➔ `spotdl` (`--threads 8 --simple-tui`, çıktı şablonu `{artists} - {title}.{output-ext}`). Spotify her zaman MP3'tür.
  - Diğer tüm linkler ➔ `yt-dlp` (MP3 için `-x --audio-format mp3`, MP4 için `bv*+ba` birleştirme).
- **Görev başına geçici klasör:** yt-dlp `-P temp:%TEMP%/spotdl-gui/<taskId>` ile çalışır; `.part`, fragman ve küçük resim dosyaları hedef klasöre hiç düşmez. Görev bitince/iptal edilince bu klasör silinir. Böylece aynı klasöre paralel indirmeler birbirini bozamaz.
- **Güvenilir dosya yolu:** `--print-to-file after_move:%(filepath)s` ile yt-dlp son dosya yollarını bir dosyaya yazar (çalma listelerinde birden fazla). spotdl yol yazmadığı için, bildirdiği `Downloaded "..."` / `Skipping ...` isimleri klasördeki MP3'lerle eşleştirilir; eşleşme yoksa görev başlangıcındaki klasör anlık görüntüsüyle karşılaştırılır.
- **İlerleme:** `--progress-template` ile makine-okunur `__PROG__ yüzde|hız|ETA` satırları üretilir. Çıktı `readLines()` ile satır satır (`\r` dahil) okunur; yarım satır/UTF-8 bölünmesi sorunu yoktur. spotdl için `N/M complete` satırlarından parça ilerlemesi hesaplanır. Son `ERROR:` satırı kullanıcıya hata detayı olarak gösterilir.
- **İptal:** Windows'ta `taskkill /pid <pid> /T /F` ile süreç ağacı (yt-dlp + ffmpeg) tamamen öldürülür; geçici klasör silinir. Uygulama kapanırken (`before-quit`) tüm görevler sonlandırılır.
- **Hız ayarları:** `-N 16` (DASH/HLS fragmanları için paralel bağlantı) ve `--http-chunk-size 10M` (YouTube'un tek bağlantı kısıtlamasını aşar). Eski `player_client=android,web` zorlaması kaldırıldı; yt-dlp'nin güncel varsayılan istemcileri kullanılır (android istemcisi artık PO token istiyor).
- `--no-playlist`: `watch?v=..&list=..` linkinde sadece video iner (YouTube Mix linkleri sonsuz liste indirmez). Saf `playlist?list=` linkleri yine tüm listeyi indirir.
- **Hata kodları:** main process yerelleştirilmiş metin göndermez; `errorCode` (`spawnFailed` / `exitCode` / `noOutput`) + ham `error` gönderir, metni renderer çevirir.

### 4.2. MP3 Kapak Resmi & Metadata Pipeline (`scripts/tagger.py`)
Windows Dosya Gezgini / Media Player'da kapak görünmesi için her MP3 indirildikten sonra çalışır. Python; `python`, `py -3`, `python3` sırasıyla denenerek `mutagen` + `Pillow` yüklü olan bulunur (`resolvePython()`), bulunamazsa adım atlanır ve kenar çubuğunda **tagger: Yok** görünür.
- **`--mode clean` (YouTube / yt-dlp):** Etiket sıfırdan kurulur: temizlenmiş başlık/sanatçı (`[videoID]`, `(Official Video)` vb. silinir), albüm = başlık, YouTube açıklama/link kalıntıları (`TXXX`, `COMM`) atılır.
- **`--mode preserve` (Spotify / spotdl):** spotdl'in yazdığı albüm, yıl, parça no, sanatçı vb. **korunur**; sadece kapak normalize edilir ve ffmpeg kap çöpleri (`TXXX:major_brand` vb.) silinir.
- Her iki modda: kapak 1:1 ortadan kırpılıp 600x600 JPEG yapılır, tek `APIC` (front cover, boş açıklama) gömülür, ID3v2.3 + ID3v1 olarak kaydedilir.
- Sadece **aynı isimli** eş dosyalar (`Şarkı.jpg`, `Şarkı.webp`...) silinir. Klasördeki diğer dosyalara (kullanıcının `cover.jpg`'si, başka indirmelerin `.part` dosyaları) **dokunulmaz**.

### 4.3. Canlı Reklamsız Medya Oynatıcı (`src/main/services/StreamManager.ts`)
- `yt-dlp -J --no-playlist` ile doğrudan CDN adresleri çözülür; sadece `http(s)` protokollü (doğrudan oynatılabilir) formatlar listelenir.
- **Kalite listesi:** YouTube sesli tek parça akışı en fazla 360p/720p verir; 1080p/2K/4K yalnızca *sessiz* video akışıdır. Bu yüzden bu seçeneklere en iyi ses akışı `audioUrl` olarak eklenir ve renderer gizli bir `<audio id="liquid-audio">` öğesini videoyla senkron çalar (play/pause/seek/waiting/hız/ses seviyesi; 0.3 sn'den fazla kaymada düzeltme). Aynı yükseklik ve fps'de tek parça akış tercih edilir.
- Kalite değişiminde yeni akış `loadedmetadata` olunca kaldığı saniyeye atlanır.
- **Spotify:** Sadece tekil şarkı (`/track/`) desteklenir. Şarkı adı ve sanatçı, public şarkı sayfasının Open Graph etiketlerinden (yedek: oEmbed) alınır, YouTube'da `ytsearch1:Sanatçı - Şarkı audio` aranır; oynatıcıda Spotify kapağı ve bilgileri gösterilir.
- **Ses modu:** Kapak görünümü videonun üzerine biner ama alttaki oynatma kontrolleri (oynat/duraklat, ilerleme, ses) görünür kalır (`.player-screen-wrapper.audio-mode`).
- Picture-in-Picture, tam ekran, Esc ile kapatma.

### 4.4. Ayarlar & Kalıcı Depolama (`src/main/services/SettingsService.ts`)
- Tüm ayarlar `%APPDATA%/spotdl-ytdlp-gui/config.json` dosyasında JSON olarak saklanır.
- Ayar parametreleri: `theme`, `colorTheme`, `language`, `glassEnabled`, `glassBlur`, `glassOpacity`, `mp3DownloadPath`, `mp4DownloadPath`, `maxConcurrentDownloads`.

### 4.5. Yerelleştirme (`src/renderer/i18n.ts`)
- HTML'de metin taşıyan her öğe `data-i18n="anahtar"` (ayrıca `data-i18n-title`, `data-i18n-placeholder`) ile işaretlenir; `applyTranslations()` hepsini doldurur.
- Kodda `t('anahtar', { n: 3 })` kullanılır (`{n}` yer tutucuları). Dil değişince görev kartları ve rozetler de yeniden çizilir.
- Yeni metin eklerken: `tr` ve `en` sözlüğüne aynı anahtarı ekleyin (`en` tipi `Record<LangKey, string>` olduğu için eksik anahtar derleme hatası verir).

### 4.6. Güvenlik
- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` (preload sadece `contextBridge`/`ipcRenderer` kullanır).
- `index.html` içinde sıkı CSP: script yalnızca `'self'`, medya `https:`/`blob:`, font `'self'`.
- İnternetten gelen başlıklar asla `innerHTML` ile basılmaz; görev kartları DOM API + `textContent` ile kurulur.
- Pencere başka bir adrese yönlenemez, yeni pencere açamaz; harici `http(s)` linkleri varsayılan tarayıcıda açılır.
- IPC girişleri main tarafında doğrulanır (`download:start` sadece `url` + `format` kabul eder).
- Fontlar `@fontsource-variable` paketlerinden build sırasında `dist/renderer/fonts/` içine kopyalanır (Google Fonts bağımlılığı yok, çevrimdışı çalışır).
- `main.ts` içinde `SettingsService` ve `DownloadManager` örneklemesi `app.whenReady()` içine taşınmıştır (Electron `app.getPath()` hazır olmadan çağrılmaması için).

### 4.7. Toplu Link İndirme
- Ana link kutusuna birden fazla link yapıştırılınca (veya **Toplu** butonuyla) pencere açılır; her satır bir link. `extractUrls()` `<input>`'un yapıştırırken sildiği satır sonları yüzünden **birbirine yapışmış** linkleri de ayırır.
- Her link ayrı görev olarak kuyruğa girer (eşzamanlılık sınırı geçerli). Spotify linkleri MP3'e zorlanır; batch içindeki çalma listesi linkleri tüm liste olarak (tek görev) indirilir.

### 4.8. Çalma Listesi / Albüm Önizleme (`CatalogService.getPlaylist`)
- İndir'e basılan link `isPlaylistUrl()` ise (YouTube `playlist?list=` veya `v=` içermeyen `list=`; Spotify `/playlist/`, `/album/`) önizleme penceresi açılır. `watch?v=..&list=..` tekil video sayılır.
- **YouTube:** `yt-dlp --flat-playlist -J -I 1:500` (çok hızlı, ilk 500 öğe; fazlası varsa uyarı gösterilir).
- **Spotify:** public `open.spotify.com/embed/<type>/<id>` sayfasındaki `__NEXT_DATA__` JSON'u (anahtar/hesap gerekmez, Spotify'ın kendi editoryal listelerinde de çalışır). `spotdl save` 90 sn+ sürdüğü için kullanılmıyor.
- Kullanıcı parçaları seçer; her seçili parça **ayrı görev** olarak `meta` (başlık/sanatçı/kapak/süre) ile kuyruğa girer. "Liste adıyla alt klasöre kaydet" seçiliyse `subfolder` gönderilir; main `sanitizeFolderName()` ile Windows için güvenli hale getirir.
- Liste okunamazsa "Tüm Listeyi Doğrudan İndir" ile URL tek görev olarak yt-dlp/spotdl'e verilir.

### 4.9. Keşfet Sekmesi (`explore.ts`, `CatalogService.search`)
- Hesapsız. YouTube Trending sayfası 2025'te kaldırıldığı için varsayılan içerik YouTube'un resmi **Top 100 Songs Turkey / Global** chart çalma listeleri; diğer kategoriler dile göre arama sorguları (`CATEGORIES` dizisi).
- Arama: `ytsearchN:` (30'ar artan, en fazla 100). Sonuçlar main'de 10 dk önbelleklenir.
- Kart: kapak (`i.ytimg.com/vi/<id>/mqdefault.jpg`), süre, sıra, kanal, izlenme; ▶ (canlı oynatıcı), MP3, MP4. Canlı yayınlar (`live_status=is_live`) oynatılabilir ama indirilemez.
- Chart kategorisinde "Listeyi İndir" önizleme penceresini açar.

### 4.10. İndirme Geçmişi (`HistoryService`, `history.ts`)
- Her tamamlanan dosya `history.json`'a yazılır (en fazla 2000, en yeni üstte, aynı dosya yolu tekrar indirilirse tek kayıt). Atomik yazma (`.tmp` + rename).
- yt-dlp dosya başına meta veriyi `--print-to-file` şablonuyla sekme ayrımlı yazar: `filepath, title, artist/uploader, thumbnail, webpage_url, duration`. spotdl için meta önizlemeden gelir ya da dosya adından (`Sanatçı - Şarkı`) çıkarılır.
- Sekmede arama, Tümü/Müzik/Video filtresi; satır başına: **Oynat** (dahili oynatıcıda `file://` — CSP `media-src file:`), **Klasörde Göster**, **Tekrar İndir**, **Geçmişten Kaldır**. Diskte olmayan dosyalar "Dosya yok" ile işaretlenir.
- Güvenlik: renderer dosya yolu göndermez; `history:reveal` sadece geçmişteki bir kaydın id'sini kabul eder.

### 4.11. yt-dlp Otomatik Güncelleme (`UpdateService`)
- Açılıştan 8 sn sonra, en fazla 12 saatte bir GitHub'daki son sürüm (`api.github.com/repos/yt-dlp/yt-dlp/releases/latest`) ile yüklü sürüm karşılaştırılır.
- Kurulum yöntemi otomatik algılanır: yt-dlp bir Python `Scripts/` klasöründeyse yanındaki `python.exe -m pip install --upgrade yt-dlp`, değilse `yt-dlp -U` (tek dosya kurulum). `-U` pip'e yönlendirirse pip denenir.
- `autoUpdateYtDlp` açıksa (varsayılan) güncelleme **kuyruk boşken** yapılır (çalışan indirme varsa en fazla 30 dk beklenir). Sonuç toast olarak bildirilir.
- Ayarlar > Motor Güncellemeleri: yüklü/son sürüm, Denetle, Şimdi Güncelle, otomatik güncelleme anahtarı. IPC: `update:status|check|run`, olay `update:changed`.

### 4.12. Uzun Liste Uyarıları
- Önizlemede **25+** parça seçilince tahmin gösterilir: toplam süre, disk alanı (MP3 ≈ 2,4 MB/dk, MP4 ≈ 20 MB/dk) ve yaklaşık indirme süresi (eşzamanlılık sınırına göre).
- **50+** parçada indirme butonu ilk tıklamada "Yine de N Parçayı İndir" onayına döner; seçim 50'nin altına inerse onay sıfırlanır. Toplu pencerede 20+ link için bilgi satırı çıkar.

### 4.13. Keşfet Yenileme
- Keşfet sekmesi **her açılışta** güncel veriyi çeker (`fresh` ile main önbelleği atlanır). Eski kartlar yeni veri gelene kadar ekranda kalır (iskelet yanıp sönmez); yenileme başarısız olursa eskiler korunur.

### 4.14. Link Önizlemesi ve Kalite Seçimi (`ProbeService`, `preview.ts`)
- Link kutusuna **tek bir link** yazılır/yapıştırılır yapıştırılmaz (Enter gerekmez, 300 ms bekleme) giriş ile kuyruk arasında kart açılır: kapak, başlık, kanal, süre.
- `yt-dlp -J` formatlarından **her yükseklik için gerçekten indirilecek format** ve **gerçek boyutu** hesaplanır (video + ses). Örnek: 4K AV1 401 MB · 1080p H.264 102 MB.
  - Ses: önce orijinal dil (`language_preference`; dublajlar düşük), sonra AAC/m4a, sonra bitrate.
  - Video: ≤1080p H.264 (her yerde oynar), üstü AV1 (VP9'dan küçük). mp4 videoya m4a ses → düz MP4.
  - Ses seçenekleri: **MP3** (VBR V0, tahmini) ve **M4A** (YouTube'un orijinal AAC'si, yeniden kodlamasız).
- Varsayılan: hero'daki MP3/MP4 seçimine göre; video için **Ayarlar > Varsayılan Video Kalitesi** (1080p). Bir çipe tıklamak hero kartını da senkronlar.
- İndirme isteği `formatId` (ör. `137+140-19`), `maxHeight` (yedek sınır) ve `audioCodec` taşır; `DownloadManager.videoSelector()` sırası: seçilen format → `height<=N` H.264+AAC → `height<=N` mp4 → `height<=N` herhangi → en iyi. **Kalite seçilmeyen MP4 indirmeleri de (Keşfet vb.) artık varsayılan 1080p ile sınırlı** (eskiden her zaman en yüksek → 4K 700 MB).
- Spotify şarkısı: sadece MP3 (spotdl). Apple Music şarkısı: sayfa adından `ytsearch1:` eşleşmesi. Çalma listesi/albüm: parça sayısı + "Parçaları Seç / Kitaplığa Aktar / Tümünü Çal".

### 4.15. İzleme Sayfası (`player.ts`, `videocontrols.ts`)
- Eski modal kaldırıldı; video `tab-watch` sekmesinde açılır: solda oynatıcı, altında başlık/kanal/eylemler (kalite, Dinle, Listeye Ekle, İndir ▾ — önizlemeyle aynı kalite listesi), sağda **Sıradaki**.
- Öneriler (`CatalogService.related`): videonun YouTube **Mix** listesi (`list=RD<id>`, müzikte ~2 sn), yoksa başlıktan benzer arama. Video bitince ilk öneri otomatik oynar (sayfa açıkken).
- Akış varsayılan kaliteyle (1080p) başlar; `autoplayPolicy: 'no-user-gesture-required'` (akış çözümü 5 sn'lik tıklama iznini aşabiliyordu).
- **Özel kontroller** (yerleşik kontroller kapalı — 1080p+ akışta ses ayrı `<audio>`'da olduğu için Chromium ses kontrolünü devre dışı bırakıyordu): oynat, zaman çubuğu, ses (duyulan öğeye uygulanır), **hız** 0.25–2×, **ses dili / dublaj** (YouTube çok dilli & AI dublaj izleri; konum ve hız korunur), **altyazı**, PiP, tam ekran. 2.5 sn hareketsizlikte gizlenir. Klavye: Boşluk/K, ←/→ 5 sn, ↑/↓ ses, M, F, C. Hız/altyazı dili/ses düzeyi hatırlanır.
- **Altyazı** (`SubtitleService`): yt-dlp ile `--skip-download --write(-auto)-subs --sub-format vtt` (doğrudan timedtext 429 veriyor). Menüde: yaratıcının altyazıları, orijinal dilin otomatik altyazısı (dublaj dillerinin ASR izleri gizlenir) ve 17 dile **otomatik çeviri**. YouTube'un kendi çevirisi (`tlang`) hesapsız istemcilere 429 verdiğinden, çeviri orijinal izden (tercihen manuel) Google Translate genel uç noktasıyla satır satır yapılır, zaman kodları korunur (~6–9 sn). ASR'nin kelime etiketleri ve tekrar eden "kayan" satırlar temizlenir. Dil adları `Intl.DisplayNames` ile uygulama dilinde.
- Sayfadan çıkarken video oynuyorsa **mini oynatıcı** olarak oynatıcı çubuğuna devredilir (önceki = başa sar, sonraki = ilk öneri, "Videoya dön").

### 4.16. Oynatıcı Çubuğu (`playerbar.ts`)
- Altta kalıcı (Spotify/Apple Music tarzı): kapak, başlık/sanatçı · karıştır, önceki, oynat/duraklat, sonraki, tekrar (kapalı/tümü/tek) · geçen süre, ilerleme, **kalan süre** · sıra paneli, ses, kapat.
- Uzak parçaların ses akışı çalarken çözülür (1 saat önbellek), sıradaki önceden hazırlanır; çözülemeyen (ör. HLS-only SoundCloud) parça için YouTube eşleşmesi denenir, olmazsa atlanır.
- **Media Session API**: Windows medya tuşları ve medya paneli (başlık, kapak, konum).
- Kullanım yerleri: Geçmiş (MP3 → çubuk, MP4 → izleme sayfası), Keşfet (🎧 Dinle, "Tümünü Çal"), Kitaplık, önizleme "Dinle", izleme sayfası "Dinle".

### 4.17. Kitaplık (`LibraryService`, `library.ts`)
- Kendi çalma listelerin (müzik + video, yerel dosya + link karışık). "Listeye ekle" (＋) menüsü: Keşfet kartları, Geçmiş satırları, önizleme kartı, izleme sayfası.
- **İçe aktarma** (hesapsız): YouTube (yt-dlp flat), Spotify (embed JSON), **SoundCloud** (yt-dlp flat + oEmbed ile 8 paralel başlık; tam çözüm 45 sn sürüyordu), **Apple Music** (sayfadaki `serialized-server-data`; parçalar `ytsearch1:Sanatçı - Şarkı` olarak çalınır/indirilir). İçe aktarılan liste kaynağını hatırlar, **Yenile** yeni parçaları ekler.
- Liste: Çal, Karıştır, İndir (≥50 parçada onay, liste adıyla alt klasör), yeniden adlandır (satır içi; Electron `prompt()` desteklemez), sil, parça çıkar. Kalıcı: `library.json` (atomik yazma).

### 4.19. Akıllı Çalma Sırası (Radyo)
- Tek bir şarkı kendi başına açıldığında (Keşfet **arama** sonucu, önizleme "Dinle", izleme sayfası "Dinle") sıra, tıklanan listenin geri kalanı değil, o şarkının **YouTube Mix**'i olur (Spotify / YouTube Music radyosu gibi). Keşfet **listeleri** (Top 100) sırayla çalar.
- Sıra son şarkıya geldiğinde, "Bitince benzerleriyle devam et" açıksa (sıra paneli; varsayılan açık) son şarkının benzerleri eklenir.
- Spotify/Apple/arama öğeleri çözüldükleri YouTube sayfasını (`pageUrl`) hatırlar, Mix oradan üretilir. Adında `[videoID]` olan yerel dosyalar (YouTube'dan inmiş) de radyo tohumu olur.

### 4.20. Yerel Müzik İçe Aktarma (`LocalImport.ts`, `scan_media.py`)
- Kitaplık > **Yerel müzik**: **Dosyadan** (M3U, M3U8, PLS, iTunes/Apple Music XML, Apple Music "Metin" TXT — UTF-16, yerelleştirilmiş başlıklar; konum sütunu değerlerden bulunur) veya **Klasörden** (alt klasörler dahil mp3/m4a/aac/flac/wav/ogg/opus…).
- Etiketler, süre ve kapak dosyalardan okunur (salt okunur); kapaklar içerik özetine göre bir kez 300px JPEG olarak `covers/` klasörüne yazılır. Örnek: ~1000 şarkılık bir M3U8 ~10–15 sn sürer. Python yoksa liste içindeki adlar/dosya adı kullanılır. Bulunamayan dosyalar sayılır ve bildirilir.
- Yerel liste kaynağını hatırlar (`origin.source = 'local'`); **Yenile** dosyayı/klasörü yeniden okuyup yeni şarkıları ekler. Yerel parçalar `file://` ile oynatıcı çubuğunda çalar (Chromium ALAC çözemez; AAC/MP3/FLAC/Opus çalar).
- Apple Music (Windows) kütüphane veritabanı (`Library.musicdb`) şifreli olduğundan doğrudan okunmaz; liste Apple Music'ten dışa aktarılır (Dosya > Kitaplık > Çalma Listesini Dışa Aktar).

### 4.21. Geçiş Animasyonları (`transitions.ts`, `motion.css`)
- **Sekme geçişleri** View Transitions API ile: eski sayfa ~140 ms'de söner, yeni sayfa ~320 ms'de güçlü ease-out ile kenar çubuğundaki yön doğrultusunda (aşağı sekme = aşağıdan) yerine oturur. Kenar çubuğu ve oynatıcı çubuğu geçişe katılmaz, yerinde durur. Her sekmenin kaydırma konumu hatırlanır. Geçiş sırasında tıklamalar alttaki canlı sayfaya ulaşır (`::view-transition { pointer-events: none }`).
- **Kapaktan oynatıcıya morph**: Keşfet / önizleme / "Sıradaki" kapağına tıklayınca kapak paylaşılan öğe olarak oynatıcıya büyür (`view-transition-name: hero-media`, ~440 ms). `openStream(url, { title, artist, thumbnail, from })` başlığı ve kapağı (video `poster`) hemen gösterir; akış çözülürken kapak hafif bir perde altında görünür.
- **Link önizlemesi**: kart yüksekliği FLIP ile değişir (`animateHeight`), kapatınca kayarak kapanır (`collapse`); alttaki içerik zıplamaz. Kalite çipine tıklamak giriş animasyonunu tekrar oynatmaz (`.lp-swap`).
- **Keşfet** kategori/arama değişiminde kartlar kademeli gelir (`staggerIn`, ilk 12 kart, ~350 ms içinde); arka plan yenilemesi sessiz değişir. **Kitaplık** liste değişiminde ve **Geçmiş** filtre değişiminde içerik yumuşakça belirir (`fadeIn`).
- **Görseller** yüklenince yumuşakça belirir (`img.is-loaded`; önbellekten gelenler anında işaretlenir). **Tema değişimi** tüm pencerede sakin bir çapraz geçiş. **Oynatıcı çubuğu** ilk görünüşte aşağıdan kayar; açılır menüler ve sıra paneli açıldıkları noktadan büyür (`@starting-style`). Butonlar basınca hafifçe içe göçer.
- `prefers-reduced-motion` açıkken hepsi düz değişime döner; API yoksa doğrudan güncellenir.

### 4.18. Diğer
- **Claude Theme** (eski adıyla Claude's design) artık **varsayılan tema**; `<body data-color-theme="claude">` ile ilk karede de doğru tema.
- `npm run dev` artık açılışta uygulamayı kapatıp yeniden açmaz: `tsc --watch`'ın ilk (aynı içerikli) derlemesi yok sayılır, yeniden başlatma yalnızca derlenen dosyanın içerik özeti değişince yapılır. Uygulama tek örnek çalışır (ikinci açılış mevcut pencereyi öne getirir).
- Fareyle tıklanan butonlarda (Alt+Tab sonrası) odak halkası gizlenir (`body.pointer-input`); Tab ile geri gelir.
- Geçmiş: Spotify (spotdl) indirmelerinin kapağı ve süresi tagger'dan okunur (`__INFO__` satırı, kapak `covers/` klasörüne 300px JPEG); eski kayıtlar açılışta `--info-only` (dosyayı değiştirmeden) ile onarılır. CSP `img-src` `file:` içerir.

---

## 5. 🎨 Tasarım Dili ve 3 Renk Evreni (Themes System)

Uygulamada `body` elementine eklenen `data-color-theme` attribute'u ile dinamik tema değişimi yapılır. Tema kimlikleri (`aura`, `ember`, `true-liquid`, `claude`) ayarlarda saklandığı için değiştirilmedi; yalnızca görünen adlar değişti:

### 1. Midnight (`aura`) — eski adı AURA Cyber Glass
- **Kimlik:** OLED Deep Obsidian zemin (`#0a0d14`), Siber Cyan (`#00f0ff`), Mor (`#8a2be2`) ve Zümrüt Yeşili neon vurgular.
- Arka planda 4 adet dinamik salınan Spatial Mesh orb'u ve mikronize noise overlay.

### 2. Ember (`ember`) — eski adı EMBER Crimson Gold
- **Kimlik:** Derin Bordo/Obsidian zemin (`#0d0306`), Kızıl Ateş (`#ff2d55`), Amber Altın (`#ff9500`), Alev Turuncusu (`#ff6b35`) ve Isıl Sarı (`#ffcc02`).
- Tüm progress barlar, switchler, slider olukları ve rozetler alev gradyanına dönüşür.

### 3. Glacier (`true-liquid`) — eski adı TRUE LIQUID GLASS
- **Kimlik:** `LiquidGlassAvaloniaUI` referansı alınarak geliştirilmiş gerçek sıvı cam deneyimi.
- Arka planda akışkan okyanus dalgaları (`radial-gradient` ve derin gök mavisi geçişleri).
- Ultra transparan kristal cam paneller (`backdrop-filter: blur(34px) saturate(200%)`).
- Işık kırılması sınırları (`1.5px solid rgba(255, 255, 255, 0.65)`) ve prizmatik iç parlama (`inset 0 1.5px 2px rgba(255, 255, 255, 0.9)`).
- "Liquid Button" sıvı jel kapsül butonlar.

### 4. Clay (`claude`) — varsayılan, eski adı Claude Theme
- **Amaç:** Sakin, premium, Apple benzeri bir "Operate" arayüz: araç işin içinde kaybolur. Siberpunk ışık, küre, parlama yok.
- **Kaynaklar:** Emil Kowalski `emil-design-eng` + `apple-design`, Impeccable (`craft-floor`, `quieter`, `colorize`, `typeset`, `animate`), taste-skill `design-taste-frontend`, Motion (Framer Motion).
- **Renk:** Sıcak grafit (#1f1e1d / yüzey #262624) veya fildişi (#faf9f5, aydınlık mod); tek vurgu Claude kil rengi (#d97757, aydınlıkta #bd5b38). Metin kontrastı ≥ 4.5:1. Seçim, imleç, odak halkası ve kaydırma çubuğu da temalı.
- **Yazı:** Sistem fontu (Segoe UI Variable Text/Display); başlıklarda negatif tracking; monospace yalnızca URL/yol verisinde, sayılar `tabular-nums`. Başlık üstü etiket (eyebrow), gradyan yazı, büyük harfli rozetler kaldırıldı.
- **Hareket:** özel eğriler (`cubic-bezier(0.23,1,0.32,1)`), basışta `scale(0.97)`, hover yalnız ince imleçte ve sadece ton değişimi (150/120 ms), pencereler bulanıklıktan "materyalleşir" (çıkış girişten hızlı), toast'lar Sonner gibi 400 ms. Sol menü ve segment kontrollerinde **tek bir gösterge** Motion yayıyla kayar (`bounce: 0`, 0.32 s, kesilebilir). `prefers-reduced-motion`, `prefers-contrast`, `prefers-reduced-transparency` desteklenir.
- Tüm kurallar `theme-claude.css` içinde `body[data-color-theme="claude"]` altında (yerel CSS nesting); paylaşılan tokenlar (`--accent-cyan`, `--text-*`, `--panel-*`) bu paletle eşlenir, böylece eski bileşenler de uyar.

> **Not:** Tema kuralları artık `body[data-color-theme=…]` ile kapsamlıdır. Eskiden `[data-color-theme="true-liquid"] .x` gibi kurallar, aynı niteliği taşıyan *tema kartlarının içine* de uygulanıyordu (TRUE LIQUID kartı diğer temalarda okunmuyordu).

---

## 6. 📱 Elastik Yay Fiziği (Rubber-Band Physics)

Ayarlar sekmesindeki kaydırıcılar Apple iOS'un logaritmik yay direnci formülüyle çalışır:
$$x_{\text{stretch}} = \pm \log_{10}\left(1 + \frac{|\Delta x|}{15}\right) \cdot 18$$

- Bırakıldığı an `cubic-bezier(0.175, 0.885, 0.32, 1.275)` yaylanma ivmesiyle geri seker.
- `ElasticSlider.ts` doğrudan tıklama (`click-to-jump`) ve sürükleme desteğine sahiptir.
- `.elastic-slider-wrapper`, `.elastic-track`, `.elastic-fill`, `.elastic-thumb` sınıfları `style.css` içerisinde donanımsal ivmeli olarak tanımlıdır.

---

## 7. 🚀 Geliştirme ve Derleme Komutları

PowerShell veya Terminal üzerinde:

```bash
# Bağımlılıkları yükleme
npm install

# TypeScript ve Renderer statik dosyalarını derleme
npm run build

# Uygulamayı başlatma
npm start

# Yalnızca TypeScript derlemesi
npm run build:tsc

# Yalnızca Renderer bundle & HTML/CSS kopyalama
npm run build:renderer

# Geliştirme modu: watch + Electron otomatik yeniden başlatma
# (renderer değişikliklerini görmek için uygulamada Ctrl+R)
npm run dev
```

> **Önemli Windows Notu:** Node.js v24 üzerinde `npx electron .` doğrudan CLI script üzerinden çalışırken hata verebilir; Electron'u çalıştırmak için `npm start` veya `.\node_modules\electron\dist\electron.exe .` kullanılması önerilir.

---

## 8. 📋 Yapılan İyileştirmeler ve Sürüm Geçmişi (Changelog)

### Sürüm çıkarma adımları (her yeni sürümde)
1. `package.json` sürümünü yükselt, DOCUMENTATION.md'ye sürüm notu ekle.
2. `npm run build:engine` (motor/ffmpeg değiştiyse ya da `vendor/` yoksa), sonra `npm run dist`.
3. Temiz ortam testi: PATH'te Python/yt-dlp/spotdl/ffmpeg yokken paketlenmiş uygulama ile ilk açılış ekranı + Spotify MP3, YouTube MP3/MP4 indirme.
4. Gizlilik taraması: depo dosyaları, `app.asar`, `resources/` (kişisel yol, e-posta, ad yok); commit kimliği `235872478+Protkan1@users.noreply.github.com`.
5. Commit + push, GitHub release (`v<sürüm>`, Türkçe öncelikli not) + `Harbor-Setup-<sürüm>.exe`.
6. **winget:** `winget/manifests/p/Protkan1/Harbor/<sürüm>/` oluştur (sürüm, URL, `InstallerSha256` = release asset digest, `ReleaseDate`), `winget validate`, kullanıcıya sorup `Protkan1/winget-pkgs` fork'unda yeni dal + microsoft/winget-pkgs'e "Update: Protkan1.Harbor to <sürüm>" PR'ı. CLA bir kez imzalandı (PR #482731), tekrar gerekmez.
7. İsteğe bağlı: yeni exe'yi Microsoft'a "Incorrectly detected" (SmartScreen) olarak gönder (kullanıcı yapar).

### Dağıtım notları (2026-11-18)
- **SmartScreen:** Kurulum dosyası imzasız olduğu için "Windows bilgisayarınızı korudu" uyarısı çıkar. Ücretsiz yollar: Microsoft'a "yanlış tespit" gönderimi (v2.10.0 gönderildi, her sürümde tekrar), winget, ileride SignPath Foundation (ücretsiz açık kaynak imzası; GitHub Actions derlemesi gerektirir).
- **winget:** `winget/manifests/p/Protkan1/Harbor/<sürüm>/` (şema 1.12.0, `nullsoft`, kullanıcı başına kurulum, moniker `harbor-music`). `winget validate` ile doğrulandı. Yeni sürümde: klasörü kopyala, sürüm/URL/`InstallerSha256` (GitHub release asset digest ile aynı) güncelle, microsoft/winget-pkgs'e PR. Kabul edilince: `winget install Protkan1.Harbor`.

### Sürüm 2.10.0 (2026-11-18) - Kurulumsuz çalışma: araçlar pakette, ilk açılış ekranı
- **Motor (`engine/`):** `harbor_engine.py`, PyInstaller ile tek klasörlük `harbor-engine.exe`'ye dönüşür (Python 3.12 + yt-dlp + spotDL + mutagen + Pillow + `scripts/` içindeki tagger/scan/spotdl_fast). Alt komutlar: `yt-dlp`, `spotdl` (spotapi yaması ile), `tagger`, `scan`, `selftest`. Spec: `engine/harbor-engine.spec` (`X utf8` seçeneği, dinamik yüklenen paketler için `collect_all`). Paket sürümleri `engine/requirements.lock.txt` dosyasında sabit. ~87 MB.
- **yt-dlp güncellemesi (paketli mod):** `UpdateService.updateBundled()` en son sürümün resmi saf Python zip'ini (`yt-dlp`) ve `SHA2-256SUMS` dosyasını indirir, SHA-256'yı doğrular, `HARBOR_YTDLP_ZIP` ile önce deneme çalıştırması yapar, sonra `<userData>/tools/yt-dlp.zip` olarak yerine koyar. Motor bu zip'i, PyInstaller'ın dondurulmuş kopyasının önüne koyan bir `meta_path` bulucusuyla içe aktarır (spotDL de aynı yt-dlp'yi kullanır). Eski bir zip ile test edildi.
- **ffmpeg (`vendor/ffmpeg`):** BtbN LGPL shared derlemesi 9.0.2 (31 Ekim 2026 aylık sürümü), sürümün `checksums.sha256` dosyasıyla doğrulanır; libmp3lame/AAC/MJPEG mevcut, GPL/nonfree yok. ffplay alınmaz. ~149 MB.
- **`npm run build:engine`** (`scripts/build-engine.js`): venv → kilitli paketler + PyInstaller 6.22.3 → motor → `selftest` → paket lisanslarını `engine/licenses/` altına toplar (`engine/collect_licenses.py`) → ffmpeg indir/doğrula/çıkar. `npm run dist`, `scripts/check-vendor.js` ile motor/ffmpeg yoksa durur. `vendor/` git dışında.
- **Araç seçimi (`src/main/services/tools.ts`):** önce `resources/engine` + `resources/ffmpeg` (kurulu sürüm), sonra `vendor/` (geliştirme), yoksa sistem PATH. `initTools()` ffmpeg klasörünü alt süreçlerin PATH'ine ekler ve `HARBOR_YTDLP_ZIP`'i ayarlar. Tüm çağrılar (`runYtDlpJson`, altyazı, indirme, tagger, yerel tarama, bağımlılık kontrolü, güncelleme) buradan geçer.
- **İlk açılış ekranı (`SetupService` + `src/renderer/setup.ts`):** sürümün ilk açılışında kapatılamayan "Harbor hazırlanıyor" penceresi: indirme motoru (`selftest`) → ffmpeg → yt-dlp güncellemesi (çevrimdışıysa atlanır). Arkadaki uygulama `inert`. Hata olursa "Tekrar dene" / "Yine de devam et". Bitince `setupDoneFor = app.getVersion()`.
- **Lisans:** motor GPL paketleri içerdiği için (mutagen, spotapi, pykakasi, Unidecode) bütün olarak GPL-3.0+; ffmpeg LGPL-2.1+; Harbor kodu MIT. `THIRD_PARTY_NOTICES.md` repoda ve kurulumda.
- **Gizlilik kontrolü:** motorun PYZ arşivindeki 59.721 kod nesnesinin dosya yolları göreli; derleme makinesinin yolları gömülü değil.
- **Test (PATH'te hiçbir araç yokken, paketlenmiş uygulama):** ilk açılış ekranı tamamlandı; Spotify MP3, YouTube MP3 ve YouTube MP4 indirmeleri 20 sn'de kapak/etiketlerle bitti; yt-dlp güncellemesi doğrulandı; canlı akış çalıştı. Kurulum dosyası ~200 MB.

### Sürüm 2.9.4 (2026-11-17) - Kurulum dosyası ve GitHub
- `npm run dist` → `release/Harbor-Setup-<sürüm>.exe` (electron-builder 26.18.0, NSIS, x64, kullanıcı başına kurulum, klasör seçilebilir, masaüstü + Başlat menüsü kısayolu; kaldırırken kullanıcı verisi silinmez). İmzasız: SmartScreen ilk açılışta uyarır.
- Paket: `dist/**` (kaynak haritaları `.map` hariç) + `package.json` → `app.asar`; Python scriptleri `extraResources` ile `resources/scripts/` altına (Python asar içinden okuyamaz). `processUtils.scriptPath()` önce `process.resourcesPath/scripts`, sonra proje klasörüne bakar. `motion` esbuild ile paketlendiği için devDependency.
- Kullanıcı verisi `%APPDATA%\Harbor`; eski `%APPDATA%\spotdl-ytdlp-gui` varsa o kullanılmaya devam eder (`main.ts`, `app.setPath('userData')`). `--user-data-dir` verilirse o geçerli (izole testler).
- Paketlenmiş uygulama izole veri klasörüyle test edildi: araçların hepsi bulundu, Spotify indirmesi 23 sn, kapak ve etiketler yazıldı.
- README (İngilizce, ekran görüntüleri `docs/screenshots/`), MIT `LICENSE`. GitHub: `Protkan1/Harbor-Music-Downloader`, kurulum dosyası Releases'te (v2.9.4).

### Sürüm 2.9.3 (2026-11-17) - GitHub öncesi gizlilik temizliği
- Git geçmişi tek commit'e indirildi (`main` dalı). Eski geçmiş kişisel e-posta adresi ve bir test scriptindeki kullanıcı klasörü yolunu içeriyordu; repodan tamamen silindi (reflog + gc ile doğrulandı: 80 nesnede 0 eşleşme). Yedeği repo dışında `../spotdl_gui_ESKI_GECMIS_YEDEK.bundle` dosyasında — **asla yüklenmemeli.**
- Repo içi git kimliği `user.email` = GitHub "noreply" adresi `235872478+Protkan1@users.noreply.github.com` (`git config --local`). Global ayardaki kişisel adres bu repoda kullanılmaz; **bu yerel ayar değiştirilmemeli.**
- Belgelerdeki kişisel örnekler (playlist boyutu, şarkı adları) genel örneklerle değiştirildi. `.gitignore`'a `release/` ve `*.bundle` eklendi.

### Sürüm 2.9.2 (2026-11-17) - Menü çubuğu kaldırıldı
- File / Edit / View / Window çubuğu kaldırıldı (`mainWindow.removeMenu()`, Alt ile de açılmaz; macOS standart uygulama menüsünü korur). Kopyala/yapıştır/geri al/tümünü seç metin alanlarında çalışmaya devam eder (Windows'ta Chromium bunları kendisi işler; CDP ile Ctrl+A ve Ctrl+Z doğrulandı).
- Menüyle birlikte giden geliştirici kısayolları yalnızca geliştirmede (`!app.isPackaged`) geri eklendi: Ctrl+R / F5 yeniden yükle, F12 / Ctrl+Shift+I DevTools. Kurulmuş sürümde bunlar yok.

### Sürüm 2.9.1 (2026-11-17) - Uygulama ikonu
- Çapa logosu uygulama ikonu oldu: kaynak `build/icon.svg` (kil rengi yuvarlak kare, beyaz çapa). `npm run build:icon` (`scripts/build-icon.js`) SVG'yi Electron'un Chromium'uyla canvas'a çizer: `build/icon.png` (1024), `build/icons/<boyut>.png`, `build/icon.ico` (16–256, PNG girdili).
- Pencere/görev çubuğu ikonu `main.ts` → `appIcon()` (Windows'ta .ico, diğerlerinde .png); dosya yoksa Electron varsayılanı. Kurulum paketinde (electron-builder) `build/` klasörü varsayılan kaynak klasörüdür, `.exe` ikonu da buradan gelir.

### Sürüm 2.9.0 (2026-11-17) - Yeni ad: Harbor
- Uygulamanın adı **Harbor** oldu (pencere başlığı, logo yazısı; alt başlık "Müzik ve video indirici" / "Music & video downloader"). "PRO v2.0" rozeti kaldırıldı; logodaki dolar işareti ($) yerine çapa ikonu.
- Tema adları: Midnight, Ember, Glacier, Clay; açıklamalar kısa ve net. Ayarlar başlığı "Renk Evrenini Seç" → "Tema".
- Ayar klasörü ve tema kimlikleri aynı kaldı, mevcut ayarlar, geçmiş ve kitaplık korunur.

### Sürüm 2.8.2 (2026-11-17) - Spotify indirmelerinde "Hazırlanıyor" süresi kısaldı
- Sebep: spotdl 4.6'nın kullandığı `spotapi`, her Spotify çağrısında (şarkı, sanatçı, albüm) web oynatıcının ~75 JS parçasını sırayla yeniden indiriyordu (çağrı başına ~6–7 sn).
- `scripts/spotdl_fast.py`: spotdl'ı aynı Python ile çalıştırır, yalnızca bu süreç içinde `spotapi.BaseClient.get_sha256_hash`'i yamalar: parçalar 16 bağlantılı tek oturumla paralel indirilir ve aynı çalıştırmada tekrar kullanılır. Kurulu paketlere dokunulmaz; beklenmeyen bir durumda orijinal metoda düşer.
- `processUtils.resolveSpotdl()`: Python'u `spotdl.exe`'nin yanından bulur ve `spotdl.console` + `spotapi.client` içe aktarmasıyla doğrular; olmazsa düz `spotdl` komutuna döner.
- Ölçüm (tek şarkı): 33,8 sn → 21,7 sn ("Processing query" ~25 sn → ~12 sn). Kalan ~4–5 sn şarkı sözü sağlayıcıları (Genius 429, MusixMatch 403 — şu an başarısız), ~4 sn spotdl'ın açılışı.

### Sürüm 2.8.1 (2026-11-17) - Spotify "İndirilen dosya bulunamadı" düzeltmesi
- Birden çok sanatçılı Spotify şarkılarında spotdl mesajda yalnızca ilk sanatçıyı yazıyor ("Sanatçı A - Şarkı"), dosyayı ise tüm sanatçılarla adlandırıyor ("Sanatçı A, Sanatçı B - Şarkı.mp3"). Şarkı klasörde zaten varsa (atlandığında) dosya eşleşmiyor ve görev "Hata" ile bitiyordu. Artık başlık birebir, sanatçı kısmı ise "ile başlar" olarak eşleştiriliyor; atlanan şarkı tamamlandı olarak görünüyor.

### Sürüm 2.8.0 (2026-11-17) - Akıcı Geçişler
- Sekme geçişleri View Transitions ile yönlü ve hızlı; kenar çubuğu/oynatıcı çubuğu sabit; sekme kaydırma konumu hatırlanır.
- Kapaktan oynatıcıya paylaşılan öğe morph'u; izleme sayfası başlık ve kapakla anında açılır.
- Önizleme kartında FLIP yükseklik/kapanma, Keşfet'te kademeli kartlar, görsellerde yumuşak belirme, tema çapraz geçişi, oynatıcı çubuğu/menü girişleri.
- Test örneği ayrı `--user-data-dir` ile çalıştırılır (açık uygulamaya ve ayarlara dokunmadan).

### Sürüm 2.7.0 (2026-11-16) - Radyo ve Yerel Müzik
- **Akıllı çalma sırası**: tek şarkı → benzer şarkılar (YouTube Mix); sıra bitince benzerleriyle devam (kapatılabilir).
- **Yerel müzik içe aktarma**: M3U/M3U8/PLS/XML/TXT veya klasör; etiket, süre, kapak dosyalardan; yenileme.
- **Düzeltme**: `npm run dev` açılışta uygulamayı kapatıp yeniden açıyordu; tek örnek kilidi.

### Sürüm 2.6.0 (2026-11-16) - Önizleme, İzleme Sayfası, Oynatıcı Çubuğu, Kitaplık
- **Link önizlemesi**: yapıştırınca anında kart; çözünürlük başına gerçek boyut, varsayılan 1080p H.264, M4A seçeneği. Kalite seçilmeyen video indirmeleri de 1080p ile sınırlandı.
- **İzleme sayfası** (modal yerine): öneriler (Mix/benzer), otomatik sonraki, mini oynatıcı.
- **Özel video kontrolleri**: çalışan ses, hız, dublaj/ses dili, altyazı + otomatik çeviri, klavye kısayolları.
- **Oynatıcı çubuğu**: sıra, karıştır, tekrar, kalan süre, ses, Windows medya tuşları.
- **Kitaplık**: kendi listeler + YouTube/Spotify/SoundCloud/Apple Music içe aktarma, yenileme.
- **Claude Theme** varsayılan ve yeniden adlandırıldı.
- **Hata düzeltmeleri:** Spotify geçmiş kaydında kapak/süre yoktu (tagger bilgisi + onarım); 1080p+ akışta ses izi dublaj olabiliyordu (orijinal dil önceliği); yavaş akışlarda otomatik oynatma reddediliyordu; Alt+Tab sonrası tıklanan butonda odak halkası; mini oynatıcıda pasif görünen butonlar.

### Sürüm 2.5.0 (2026-11-16) - Claude's design, yt-dlp Güncelleyici
- **4. tema "Claude's design"**: sakin sıcak nötrler, kil rengi vurgu, sistem tipografisi, Motion yay göstergeleri, materyalleşen pencereler, aydınlık/karanlık mod.
- **yt-dlp otomatik güncelleme** (pip/standalone algılama, kuyruk boşken güncelleme, ayarlar paneli).
- **Uzun liste uyarıları**: 25+ parçada süre/alan/zaman tahmini, 50+ parçada ikinci onay.
- **Keşfet her açılışta yenilenir** (titreme olmadan).
- **Hata düzeltmeleri:** tagger `python -I` altında Türkçe/Unicode dosya adlarında çöküyordu (UTF-8 zorlandı); tema CSS kapsamı tema kartlarına sızıyordu; görev kartı çıkış animasyonu CSS'e taşındı (tema başına).

### Sürüm 2.4.0 (2026-11-15) - Toplu İndirme, Çalma Listesi, Keşfet ve Geçmiş
- **Toplu link indirme** penceresi (çoklu yapıştırma otomatik algılanır).
- **Çalma listesi / albüm önizleme** (YouTube + Spotify), parça seçimi, liste adıyla alt klasör.
- **Keşfet** sekmesi: hesapsız YouTube arama, Türkiye/Global Top 100, kategoriler; kartlardan oynat/MP3/MP4.
- **Geçmiş** sekmesi: kalıcı kayıt, arama/filtre, yerel oynatma, klasörde göster, tekrar indir.
- Renderer modüllere bölündü (`dom`, `player`, `modals`, `explore`, `history`); yeni stiller `features.css`'te ve tema değişkenleriyle (`color-mix`) 3 temaya uyumlu.
- İndirme klasörü oluşturulamazsa artık yanıltıcı "araç başlatılamadı" yerine `folderFailed` hatası gösteriliyor.

### Sürüm 2.3.0 (2026-11-15) - Stabilite, Güvenlik ve Kuyruk
- **Veri kaybı düzeltmeleri:** tagger artık spotdl metadata'sını silmiyor (`preserve` modu); klasördeki tüm `.part/.webp` dosyalarını ve kullanıcının `cover.jpg`'sini silen toplu temizlik kaldırıldı; rastgele bir resmi kapak yapma kaldırıldı.
- **Paralel indirme güvenliği:** görev başına geçici klasör (`-P temp:`), dosya yolu `--print-to-file` ile kesin olarak alınıyor (en yeni MP3'ü tahmin etme kaldırıldı). Çalma listesi/albümlerde tüm dosyalar işleniyor.
- **Kuyruk + eşzamanlılık sınırı** (Ayarlar'dan 1-5).
- **İptal:** Windows'ta süreç ağacı tamamen öldürülüyor, yarım dosya kalmıyor, çift hata mesajı yok; yeni `cancelled` durumu.
- **Canlı oynatıcı:** 1080p+ seçenekleri artık sesli (ayrı ses akışı senkronu); Spotify şarkıları gerçek isimle bulunuyor; kalite değişiminde konum korunuyor; ses modunda oynatma kontrolleri görünür.
- **Güvenlik:** XSS düzeltmesi (başlıklar `textContent`), CSP, `sandbox: true`, navigasyon engeli, IPC doğrulama.
- **i18n:** tüm arayüz `data-i18n` ile TR/EN; main process'ten gelen sabit Türkçe metinler kaldırıldı. Boş-liste kartının i18n tarafından ezilmesi düzeltildi.
- **Diğer:** bağımlılık rozetlerinin CSS sınıfı düzeltildi (`dep-pill`), tagger (Python+mutagen+Pillow) rozeti eklendi, `python`/`py -3`/`python3` otomatik bulma, yerel fontlar, `npm run dev` çalışır hale getirildi, tekrar eden HTML id'leri temizlendi, `player_client=android` zorlaması kaldırıldı, `--no-playlist` eklendi, git deposu oluşturuldu.

### Sürüm 2.2.3 (2026-11-06) - Gigabit Hız Optimizasyonu (Turbo Multi-Thread)
- **Sorun:** 1000 Mbps internete rağmen indirmelerin 1.70 MiB/s hızında kalması.
- **Çözüm:** `-N 16` (`--concurrent-fragments 16`), `--http-chunk-size 10M` ve `--extractor-args "youtube:player_client=android,web"` parametreleri eklendi; hız 30-60+ MiB/s seviyesine çıkarıldı. SpotDL için `--threads 8` eklendi.

### Sürüm 2.2.2 (2026-11-05) - Akış Çözümleme Onarımı
- **Sorun:** 4K videolarda (örn. `How it feels to own a MacBook`) "Medya bilgisi çözümlenemedi" uyarısı.
- **Çözüm:** Katı format filtresi (`--format "best[ext=mp4]/best"`) kaldırıldı; 4K, 2K, 1080p, 720p ve ses formatları dinamik ayrıştırıldı.

### Sürüm 2.2.1 (2026-11-05) - Anti-Overlap Layout & İkiz Buton Sistemi
- **Sorun:** Pencere küçüldüğünde format kartlarının iç içe geçmesi ve "İndirmeyi Başlat" butonunun sıska kalması.
- **Çözüm:** `.hero-actions-deck` içinde iki buton da 52px yüksekliğinde tam eşit ikizler yapıldı. `.hero-controls-row` için responsive kırılma (`flex-wrap: wrap`) ve metin taşma koruması eklendi.

### Sürüm 2.2.0 (2026-11-05) - True Liquid Glass Teması & Canlı Reklamsız Stream Player
- **Yenilik:** AvaloniaUI esintili 3. tema (`true-liquid`) eklendi. Reklamsız, donmasız 4K/2K/1080p canlı medya oynatıcı (`Floating Liquid Glass Player`) ve elastik slider onarımı yapıldı.

### Sürüm 2.1.0 (2026-11-02) - Çoklu Tema Sistemi (AURA + EMBER)
- **Yenilik:** Ayarlar sekmesine "Renk Evrenini Seç" paneli eklendi. EMBER Crimson Gold teması entegre edildi. `main.ts` içinde `app.whenReady()` timing hatası düzeltildi.

### Sürüm 2.0.0 (2026-10-27) - AURA Pro Spatial Glass UI Yenilemesi
- **Yenilik:** Tüm arayüz Google Fonts (`Plus Jakarta Sans` & `JetBrains Mono`), spatial mesh orbları ve modern HUD kartları ile sıfırdan tasarlandı.

---

## 9. 💡 Gelecek Yol Haritası ve Fikirler (Claude İçin Öneriler)

Projeye yeni özellik eklerken değerlendirilebilecek fikirler:
1. ~~İndirme Geçmişi / Kütüphane Paneli~~ ✅ 2.4.0
2. ~~Çoklu Link / Toplu İndirme~~ ✅ 2.4.0
3. **Format Genişletmesi:** FLAC, WAV, OPUS ses formatları; MKV, WebM video formatları seçeneği.
4. ~~Spotify Çalma Listesi Önizlemesi~~ ✅ 2.4.0 (YouTube listeleri dahil)
5. ~~Otomatik Bağımlılık Güncelleyici (yt-dlp)~~ ✅ 2.5.0 (spotdl için de eklenebilir)
