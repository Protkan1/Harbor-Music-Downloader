<div align="center">

<img src="build/icons/128.png" width="96" alt="Harbor ikonu">

# Harbor

**Müzik ve video bulmak, dinlemek ve indirmek için bir masaüstü uygulaması.**
YouTube, Spotify, SoundCloud veya Apple Music bağlantısını yapıştır, kaliteyi seç, sende kalsın.

![Platform](https://img.shields.io/badge/platform-Windows-0078D4)
![Electron](https://img.shields.io/badge/Electron-45-47848F)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6)
![Lisans](https://img.shields.io/badge/lisans-MIT-green)

**Türkçe** · [English](README.en.md)

</div>

![Bağlantıyı yapıştır: Harbor her kaliteyi gerçek dosya boyutuyla gösterir](docs/screenshots/downloads.png)

## Ne yapar

Harbor, [yt-dlp](https://github.com/yt-dlp/yt-dlp) ve [spotDL](https://github.com/spotDL/spotify-downloader) için bir arayüz. Amaç bir komut satırı sarmalayıcısı değil, gerçek bir müzik uygulaması gibi hissettirmesi.

- **Yapıştır ve önizle.** Yapıştırılan bağlantı, Enter'a basmadan önizleme kartına dönüşür. Her çözünürlük gerçek dosya boyutuyla listelenir; 1080p istediğin bir video sessizce 700 MB'lık 4K olarak inmez.
- **Etiketleri düzgün müzik.** 320 kbps MP3 veya M4A. Başlık, sanatçı, albüm ve kare kapak dosyaya gömülür; Windows Gezgini'nde, Apple Music'te ve telefonda doğru görünür.
- **Çalma listeleri ve albümler.** Listenin tamamını indir ya da istediğin şarkıları seç. Uzun listeler başlamadan önce onay ister.
- **İndirmeden izle ve dinle.** Önerilerin olduğu YouTube tarzı bir izleme sayfası; altyazı (otomatik çevirili olanlar dahil), oynatma hızı ve farklı dillerde seslendirme. Spotify tarzı oynatıcı çubuğu sen gezinirken çalmaya devam eder.
- **Akıllı çalma sırası.** Tek bir şarkı başlatınca sıra, aynı aramanın kopyalarıyla değil benzer şarkılarla dolar (radyo).
- **Hesapsız keşfet.** Türkiye ve Dünya Top 100, yeni çıkanlar, tür listeleri ve arama.
- **Kendi kitaplığın.** Müzik ve videoyu karıştıran listeler oluştur; YouTube, Spotify, SoundCloud veya Apple Music listelerini içe aktar ya da yerel müziklerini M3U/M3U8/PLS dosyası, iTunes XML veya klasörden ekle.
- **Geçmiş.** Her indirme kapağı, süresi ve kaynağıyla; tek tıkla yeniden indir veya klasörünü aç.
- **Kendini güncel tutar.** Siteler sık değiştiği için yt-dlp arka planda otomatik güncellenir.
- **Dört tema** (Clay, Midnight, Ember, Glacier), Türkçe ve İngilizce arayüz, akıcı sayfa geçişleri ve `prefers-reduced-motion` (animasyonları azalt) desteği.

| Keşfet | İzleme sayfası |
|---|---|
| ![Türkiye Top 100 ile Keşfet sekmesi](docs/screenshots/explore.png) | ![Öneriler ile izleme sayfası](docs/screenshots/watch.png) |

![Dört temanın olduğu ayarlar](docs/screenshots/settings.png)

## Kurulum

1. [Releases](../../releases) sayfasından `Harbor-Setup-<sürüm>.exe` dosyasını indirip çalıştır.
   Kurulum dosyası dijital olarak imzalı olmadığı için Windows SmartScreen ilk seferde uyarabilir: **Ek bilgi → Yine de çalıştır**.
2. Harbor'ın kullandığı araçları bir kez kur:

   ```powershell
   winget install Python.Python.3.12
   winget install Gyan.FFmpeg
   pip install spotdl yt-dlp mutagen pillow
   ```

   Kenar çubuğu, bulduğu her aracın yanında yeşil **OK** gösterir. Python + mutagen + Pillow olmasa da her şey çalışır; yalnızca kapak/etiket düzenleme adımı atlanır.

## Kaynaktan derleme

Node.js 20+ ve yukarıdaki araçlar gerekir.

```powershell
npm install
npm run dev     # geliştirme: izleme modu, ana süreç kodu değişince uygulama yeniden başlar
npm start       # bir kez derle ve çalıştır
npm run dist    # release/ klasörüne Windows kurulum dosyasını oluştur
```

`npm run build:icon`, ikon setini `build/icon.svg` dosyasından yeniden üretir.

## Nasıl yapıldı

```
src/
├── main/                      Electron ana süreç (Node.js)
│   ├── main.ts                pencere, tek örnek kilidi, uygulama yaşam döngüsü
│   ├── ipcHandlers.ts         tipli IPC API, girdi doğrulama
│   └── services/
│       ├── DownloadManager    eşzamanlılık sınırlı indirme kuyruğu, yt-dlp / spotDL süreçleri, etiketleme
│       ├── ProbeService       bağlantı önizlemesi: kaliteler ve gerçek dosya boyutları
│       ├── StreamManager      akış çözümleme, ses parçaları, altyazılar
│       ├── CatalogService     çalma listeleri, albümler, arama, ilgili videolar
│       ├── LibraryService     kullanıcı listeleri ve içe aktarma
│       ├── LocalImport        M3U / PLS / iTunes XML / klasör içe aktarma
│       └── UpdateService      arka planda yt-dlp güncellemeleri
├── preload/                   contextBridge: arayüz ile Node arasındaki tek kapı
├── renderer/                  arayüz (TypeScript + CSS, framework yok), esbuild ile paketlenir
└── shared/                    iki tarafın da kullandığı tipler ve URL yardımcıları
scripts/
├── tagger.py                  ID3/MP4 etiketleri ve kapak (mutagen + Pillow)
├── scan_media.py              yerel müziklerin etiket ve kapaklarını toplu okur
└── spotdl_fast.py             spotDL'ı daha hızlı Spotify sorgularıyla çalıştırır
```

Öne çıkan birkaç karar:

- **Güvenlik:** Pencere `contextIsolation`, `sandbox` ve sıkı bir İçerik Güvenlik Politikası (CSP) ile çalışır. Arayüzün Node erişimi yoktur; her işlem küçük, tipli bir IPC yüzeyinden geçer ve girdiler ana süreçte doğrulanır.
- **Sağlam süreç yönetimi:** Her indirme kendi geçici klasöründe çalışır. Çıktı yolları konsol metninden ayıklanmaz, yt-dlp'nin kendi `--print-to-file` çıktısından alınır. İptal, tüm süreç ağacını (yt-dlp → ffmpeg) sonlandırır.
- **Hız:** spotDL'ın Spotify istemcisi her şarkı için web oynatıcının ~75 dosyasını yeniden indiriyordu. `spotdl_fast.py` bunu kurulu paketlere dokunmadan, yalnızca çalışan süreçte düzeltir (paralel indirme + yeniden kullanım); beklenmeyen bir durumda orijinal koda döner. Tek şarkılık indirme ~34 sn'den ~22 sn'ye indi.
- **Hareket:** Sekme geçişleri View Transitions API ile yapılır; bir kapağa tıklayınca kapak oynatıcıya dönüşür; seçim göstergeleri yay fiziğiyle (Motion) kayar. "Animasyonları azalt" açıkken hepsi anlık değişime döner.

## Sorumluluk reddi

Harbor kişisel bir projedir. Yalnızca indirme hakkın olan içerikleri indir ve kullandığın sitelerin kullanım koşullarına uy.

## Lisans

[MIT](LICENSE)
