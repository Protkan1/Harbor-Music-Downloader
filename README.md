# SpotDL & yt-dlp Liquid GUI (iOS 26 Liquid Glass Architecture)

Bu proje, **yt-dlp** ve **spotdl** araçlarını **Electron**, **TypeScript** ve **iOS 26 Liquid Glass** tasarım diliyle modern bir masaüstü uygulamasına dönüştüren mimariyi sunar.

---

## 📁 Proje Dizin Yapısı (Folder Structure)

```text
spotdl_gui/
├── package.json                    # Bağımlılıklar ve derleme scriptleri
├── tsconfig.json                   # TypeScript yapılandırması
├── scripts/
│   └── build-renderer.js           # HTML/CSS statik varlık kopyalama aracı
├── src/
│   ├── shared/
│   │   └── types.ts                # Main ve Renderer arası tip tanımları
│   ├── main/                       # Electron Main Process (Node.js)
│   │   ├── main.ts                 # Pencere yönetimi ve uygulama yaşam döngüsü
│   │   ├── ipcHandlers.ts          # IPC dinleyicileri (Settings, Dialog, Downloads)
│   │   └── services/
│   │       ├── DownloadManager.ts  # spotdl & yt-dlp spawn ve stdout ayrıştırıcı
│   │       └── SettingsService.ts  # Yerel kalıcı JSON ayar saklama
│   ├── preload/                    # Güvenli IPC Köprüsü
│   │   └── preload.ts              # contextBridge ile expose edilen API
│   └── renderer/                   # Electron Renderer Process (Arayüz)
│       ├── index.html              # Sıvı cam ve sekme yapısı
│       ├── style.css               # iOS 26 Liquid Glass & CSS değişkenleri
│       ├── renderer.ts             # Arayüz durumu, IPC iletişimi ve olaylar
│       ├── i18n.ts                 # TR / EN çoklu dil sözlüğü
│       └── components/
│           └── ElasticSlider.ts    # iOS elastik yay fiziği (Rubber-Band Resistance)
└── README.md
```

---

## 🚀 Kurulum ve Çalıştırma

### 1. Bağımlılıkları Yükleyin:
```bash
npm install
```

### 2. Derleyin ve Başlatın:
```bash
npm run build
npm start
```

### 3. Geliştirme Modu:
```bash
npm run dev   # watch + otomatik yeniden başlatma (UI değişiklikleri için Ctrl+R)
```

---

## ✨ Öne Çıkan Özellikler ve Mimari

1. **iOS 26 Liquid Glass Tasarımı:**
   - CSS `backdrop-filter: blur(...)` ve dinamik `opacity` katmanları.
   - Gerçek zamanlı parlama (glow) ve derinlik hissi veren ortam küreleri (`ambient orbs`).
   - Ayarlar üzerinden sıvı camı anlık kapatabilme veya bulanıklık/şeffaflık seviyesini ayarlayabilme.

2. **Elastik Yay (Rubber-Band Physics) Kontrolleri:**
   - Apple'ın ses ve kaydırma elemanlarında kullandığı **logaritmik direnç formülü**:
     $$x_{\text{stretch}} = \pm \log_{10}\left(1 + \frac{|\Delta x|}{k}\right) \cdot \alpha$$
   - Fare/dokunma bırakıldığında `cubic-bezier(0.175, 0.885, 0.32, 1.275)` ile yerine yay gibi sekme etkisi.

3. **Güvenli IPC & Child Process İletişimi:**
   - `contextIsolation: true` ve `nodeIntegration: false` ile tam Electron güvenlik standartları.
   - `child_process.spawn` ile hem `spotdl` hem `yt-dlp` arka planda donma yapmadan çalıştırılır.
   - `stdout` üzerinden yüzde, indirme hızı ve kalan süre regex ile anlık ayrıştırılıp arayüze aktarılır.

4. **Kalıcı Ayarlar & İki Ayrı Dizin Desteği:**
   - MP3 (SpotDL) ve MP4 (yt-dlp) indirmeleri için bağımsız hedef klasörler atanabilir.
   - Tüm ayarlar `userData/config.json` dosyasına JSON olarak kaydedilir.
   - Türkçe / İngilizce anında dil geçişi ve OLED Karanlık / Kristal Aydınlık tema desteği.
