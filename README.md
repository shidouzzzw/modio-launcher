# Modio Launcher

Tauri + TypeScript masaüstü Minecraft launcher'ı. Arayüz vanilya TS, köprü Rust,
kurulum/başlatma işini `minecraft_launcher_lib` üzerinden yapan bir servis yapar.

```
index.html + src/          Arayüz (Vite)
src-tauri/src/lib.rs       Tauri komutları: dosya işlemleri, mod indirme, başlatma köprüsü
launcher-service/          Python servisi: sürüm + yükleyici kurulumu, oyunu başlatma
└── launcher.py            Asıl iş burada (fabric/quilt/forge, Fabric API, JVM argümanları)
└── build-sidecar.sh       launcher.py'yi tek dosyaya dondurur (yayın için)
```

## Gereksinimler

- **Node.js ≥ 20.12** — Vite 8'in rolldown'u `node:util`'in `styleText` çıktısını
  kullanır; Node 18 ile build hata verir. `nvm use` ile sürümü kontrol et.
- **Rust** (Tauri 2)
- **Geliştirme için Python 3.13** — yalnızca geliştirirken gerekir, son kullanıcı
  Python kurmaz (aşağıya bak).

## Geliştirme

```bash
npm install
npm run tauri dev
```

Servis iki biçimde çalıştırılabilir; Rust tarafı sırayla dener:

1. **Dondurulmuş ikili** (`src-tauri/binaries/launcher-service`) — yayınlanan sürüm.
2. **Sanal ortam** (`launcher-service/.venv`) — geliştirme. Yoksa:

```bash
python3 -m venv launcher-service/.venv
launcher-service/.venv/bin/pip install minecraft_launcher_lib
```

Arayüzü Tauri olmadan tarayıcıda denemek için: `dev/dev-harness.html`
(`npm run dev` sonrası `http://localhost:1420/dev/dev-harness.html`).

## Yayınlama (paketleme)

Kullanıcıdan Python istenmemesi için `launcher.py` PyInstaller ile tek bir
çalıştırılabilir dosyaya dondurulur; yorumlayıcı ve bağımlılıklar ikilinin içine
gömülür (güncel boyut yaklaşık **9,4 MB**).

```bash
./launcher-service/build-sidecar.sh     # -> src-tauri/binaries/launcher-service
npm run build                            # arayüz -> dist/
npm run tauri build                      # paket (deb/AppImage, msi/nsis, dmg)
```

`launcher-service/build-sidecar.sh` her platformda ayrı çalıştırılmalıdır;
PyInstaller çapraz derleme yapamaz. CI'da her işletim sistemi kendi runner'ında
önce bu betiği, sonra `npm run tauri build` komutunu çalıştırmalıdır.

Paketlenen tek servis dosyası `src-tauri/binaries/` içindekidir; `.venv`,
PyInstaller çıktıları ve oyun klasörü pakete girmez.

### Boyut notları

Betik, ikiliyi gereksiz modüllerden arındırır. Ölçülen kazanç: **12,2 MB →
9,4 MB**. Gerekçeler:

- `--exclude-module` listesi (`setuptools`, `pkg_resources`, `pydoc`, `pydoc_data`,
  `distutils`, `tkinter`, `unittest`, `doctest`, `curses`, `lib2to3`, `idlelib`,
  `pip`, `wheel`).
  Dışlama olmadan ikilide **130 setuptools + 3 pydoc modülü** (kaynak olarak
  ~2,3 MB) taşınıyordu ve hiçbiri çalışma zamanında kullanılmıyor.
- `--optimize 2`: docstring ve `assert`'ler atılır.
- `email`, `http`, `multiprocessing` **dışlanmaz**: sırasıyla `http.client`,
  `concurrent.futures` ve `urllib3` bunları gerçekten içe aktarır.

UPX varsayılan olarak kapalıdır. PyInstaller, UPX'i Linux/macOS'ta bilinen
uyumluluk sorunları yüzünden kendisi devre dışı bırakır ("UPX is available but is
disabled on non-Windows"); Windows'ta ise Defender'ın `--onefile` çıktısını
yanlış işaretleme riski vardır. Yine de denemek isterseniz: `YMC_UPX=1
./launcher-service/build-sidecar.sh` (PATH'te `upx` olmalı).

### Çıktılar

| Platform | Dosyalar |
|---|---|
| Linux | `src-tauri/target/release/bundle/deb/*.deb`, `.../rpm/*.rpm`, `.../appimage/*.AppImage` |
| Windows | `src-tauri/target/release/bundle/msi/*.msi`, `.../nsis/*-setup.exe` |

### AppImage notu

Tauri 2.11.4'ün AppImage adımı, `patchelf` kurulu olsa bile **"Finished 1
bundle" deyip exit 0 dönerken hiç dosya üretmiyor** (doğrulandı). AppDir
eksiksiz oluştuğu için son sıkıştırma adımı `appimagetool` ile tamamlanabilir:

```bash
ARCH=x86_64 appimagetool-x86_64.AppImage \
  src-tauri/target/release/bundle/appimage/modio-launcher.AppDir \
  src-tauri/target/release/bundle/appimage/modio-launcher_0.1.0_amd64.AppImage
```

CI'daki "AppImage eksikse appimagetool ile tamamla" adımı bunu otomatik yapar;
hemen ardından gelen "Paketler gerçekten üretildi mi" adımı eksik çıktıyı
başarısız build'e çevirir (sessiz kayıp olmasın diye).

### Windows notları

**.exe/.msi yalnızca Windows'ta üretilebilir:** PyInstaller çapraz derleme
yapamaz (servis ikilisi Windows PE olmalı) ve Tauri Windows kurulum paketlerini
başka platformda paketleyemez. Linux/macOS'ta `npm run tauri build` yalnızca o
platformun paketlerini verir.

Windows'ta (Git Bash gerekir, Node 24 + MSVC Build Tools + WebView2):

```bash
npm ci
./launcher-service/build-sidecar.sh   # -> src-tauri/binaries/launcher-service.exe
npm run tauri build                   # -> bundle/msi/*.msi ve bundle/nsis/*-setup.exe
```

Aynı iş `.github/workflows/build.yml` içindeki `windows-latest` işiyle de
yapılır (depo bir GitHub remote'una itilmelidir).

- Dondurma betiği **Git Bash**'ten çalıştırılır; çıktı `launcher-service.exe`
  olur ve betik sanal ortamı `Scripts/python.exe` üzerinden bulur.
- Bağımlılıklar `launcher-service/requirements.txt`'ten kurulur; bu dosya
  olmadan temiz bir makinede dondurma
  `No module named 'minecraft_launcher_lib'` ile kırılır.
- `reqwest`'in `rustls-tls` özelliği `ring`/`aws-lc-sys` çeker, bunlar C derler:
  Windows'ta MSVC Build Tools kurulu olmalıdır (Tauri zaten bunu ister).
  Derleme burada takılırsa `reqwest`'i `native-tls`'e çevir.
- `--onefile` çıktısını Windows Defender zaman zaman yanlış işaretler; yayın
  için kod imzalama gerekebilir.
- Süreç yönetimi Windows'a özeldir: oyun `taskkill /T /F` ile süreç ağacıyla
  kapatılır ve tüm yardımcı süreçler `CREATE_NO_WINDOW` ile başlatılır
  (konsol penceresi açılmaz).

## Veri yerleşimi

| Ne | Nerede |
|---|---|
| Örnekler, dünyalar, modlar, ayarlar | `~/.local/share/modio-launcher/` (macOS: `~/Library/Application Support/`, Windows: `%APPDATA%`) |
| Varsayılan örnek | `…/modio-launcher/instances/default` |
| Uygulama dosyaları | Kurulum klasörü (güncellemede değişir) |

Oyun verisi **asla** uygulama klasöründe tutulmaz: güncelleme kullanıcının
dünyalarını silmemelidir. Eski sürümlerde `launcher-service/minecraft` içinde
kalan varsayılan örnek, ilk çalıştırmada kullanıcı klasörüne taşınır; taşıma
başarısız olursa (örneğin başka disk) veri yerinde bırakılır.

## Sürüm ve güncelleme

Sürüm numarasının tek kaynağı `src-tauri/tauri.conf.json` içindeki `version`
alanıdır; arayüz bunu Tauri'den okur.

Ayarlar'daki **Güncelleme Kontrol Et** düğmesi, `src-tauri/src/lib.rs` içindeki
`GITHUB_REPO` deposunun en son yayınlanmış Release'ini GitHub API'den okur ve
sürüm çekirdeğini sayısal olarak karşılaştırır. Yeni sürüm varsa indirme
sayfası açılır. Taslak ve ön sürüm etiketleri GitHub'ın `releases/latest`
yanıtına girmediği için kullanıcıya test sürümü önerilmez.

Yeni sürüm yayınlarken:

1. `tauri.conf.json` içindeki `version` alanını artır.
2. Aynı numarayla etiket oluşturup it: `git tag v0.2.0 && git push origin v0.2.0`
3. `Derleme` iş akışı paketleri üretir ve etiketli sürümde Release'e ekler.

Paketler **sabit adlarla** yayınlanır: `Modio Launcher.exe`,
`Modio Launcher.msi`, `Modio Launcher.deb`, `Modio Launcher.rpm`,
`Modio Launcher.AppImage`. Ürün adı `productName`'den geldiği için ad
boşluk içerir; Tauri'nin ürettiği sürüm/mimari ekli dosyalar
(`Modio Launcher_0.1.0_x64-setup.exe` gibi) CI'da bu adlara kopyalanır;
böylece bağlantı sürümden bağımsız kalır. Sürüm bilgisi etiketten okunur.

Boşluk, doğrudan indirme bağlantısında `%20` olarak yazılmalıdır:
`releases/latest/download/Modio%20Launcher.exe`.

Kontrol başarısız olursa (ağ, yayın yokluğu, HTTP hatası) arayüz "güncel"
demek yerine gerçek sebebi gösterir.
