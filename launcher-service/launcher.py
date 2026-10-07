"""YMC Launcher — Minecraft kurulum ve başlatma köprüsü.

Tauri tarafı bu betiği iki modda çalıştırır:

    python launcher.py install   # örnek (instance) için sürüm + yükleyici kurar
    python launcher.py launch    # örneği başlatır (eksikse önce kurar)

Tüm bilgiler ortam değişkenleriyle gelir:
    YMC_VERSION         Minecraft sürümü (varsayılan 1.21.11)
    YMC_LOADER          vanilla | fabric | quilt | forge
    YMC_GAME_DIR        örneğin oyun klasörü
    YMC_PROGRESS_FILE   ilerleme bilgisinin yazılacağı JSON dosyası
    BLOCKFORGE_USERNAME oyuncu adı
    YMC_MEMORY          ayrılan bellek (MB)
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.parse
import urllib.request

import minecraft_launcher_lib

def default_game_dir() -> str:
    """Varsayılan oyun klasörü: kullanıcı veri dizini.

    Paketlenmiş (PyInstaller) sürümde ``__file__`` geçici bir klasöre işaret
    eder; bu yüzden oyun verisi asla betiğin yanına yazılmaz.
    """
    if os.name == "nt":
        base = os.environ.get("APPDATA") or os.path.expanduser("~")
    elif sys.platform == "darwin":
        base = os.path.join(os.path.expanduser("~"), "Library", "Application Support")
    else:
        base = os.environ.get("XDG_DATA_HOME") or os.path.join(
            os.path.expanduser("~"), ".local", "share"
        )
    return os.path.join(base, "modio-launcher", "instances", "default")


# Launcher tek bir sürüm için tasarlandı; ortam değişkeni gelmezse de o sürüm
# kullanılır (eskiden burada olmayan bir sürüm yazıyordu).
MODE = sys.argv[1] if len(sys.argv) > 1 else "launch"
VERSION = os.environ.get("YMC_VERSION") or "1.21.11"
LOADER = (os.environ.get("YMC_LOADER") or "vanilla").lower()
GAME_DIR = os.environ.get("YMC_GAME_DIR") or default_game_dir()
PROGRESS_FILE = os.environ.get("YMC_PROGRESS_FILE") or ""
USERNAME = os.environ.get("BLOCKFORGE_USERNAME") or "Player"
MEMORY = int(os.environ.get("YMC_MEMORY") or 2048)
# Kullanıcının ek JVM argümanları; -Xmx/-Xms ile çakışmaması için Xmx/Xms filtrelenir.
EXTRA_JVM_ARGS = [
    arg
    for arg in (os.environ.get("YMC_JVM_ARGS") or "").split()
    if not arg.startswith(("-Xmx", "-Xms"))
]

# Fabric örneklerinde oyunun çalışması için gereken zorunlu mod.
FABRIC_API_SLUG = "fabric-api"
MODRINTH_HEADERS = {"User-Agent": "ModioLauncher/0.1 (minecraft launcher)"}


class Progress:
    """Kurulum ve oyun durumunu arayüze aktarır (dosya üzerinden)."""

    def __init__(self) -> None:
        self.status = "Hazırlanıyor…"
        self.current = 0
        self.total = 0
        self.pid = None
        self.launcher_pid = os.getpid()

    def flush(self) -> None:
        if not PROGRESS_FILE:
            return
        payload = {
            "status": self.status,
            "current": self.current,
            "total": self.total,
            "time": time.time(),
            "pid": self.pid,
            "launcher_pid": self.launcher_pid,
        }
        try:
            directory = os.path.dirname(PROGRESS_FILE)
            if directory:
                os.makedirs(directory, exist_ok=True)
            with open(PROGRESS_FILE, "w", encoding="utf-8") as handle:
                json.dump(payload, handle)
        except OSError:
            pass

    def set_status(self, text: str) -> None:
        self.status = text
        self.flush()

    def set_progress(self, value: int) -> None:
        self.current = value
        self.flush()

    def set_max(self, value: int) -> None:
        self.total = value
        self.flush()

    def callback(self) -> dict:
        return {
            "setStatus": self.set_status,
            "setProgress": self.set_progress,
            "setMax": self.set_max,
        }


def installed_ids() -> set[str]:
    try:
        return {entry["id"] for entry in minecraft_launcher_lib.utils.get_installed_versions(GAME_DIR)}
    except Exception:  # noqa: BLE001 — bozuk klasör listeyi bozmasın
        return set()


def pick(ids: set[str], prefix: str, suffix: str) -> str | None:
    return next((item for item in sorted(ids) if item.startswith(prefix) and item.endswith(suffix)), None)


def mods_dir() -> str:
    path = os.path.join(GAME_DIR, "mods")
    os.makedirs(path, exist_ok=True)
    return path


def has_fabric_api() -> bool:
    try:
        return any(
            name.lower().startswith("fabric-api") and name.lower().endswith(".jar")
            for name in os.listdir(mods_dir())
        )
    except OSError:
        return False


def latest_release_version(project_slug: str, loader: str) -> dict | None:
    """Sürüm için en yeni **release** sürümünü seçer.

    Alpha/beta sürümleri yalnızca hiç release yoksa kullanılır; böylece
    oyunun açılmadığı test sürümleri kurulmaz.
    """
    query = urllib.parse.urlencode(
        {
            "loaders": json.dumps([loader]),
            "game_versions": json.dumps([VERSION]),
        }
    )
    url = f"https://api.modrinth.com/v2/project/{project_slug}/version?{query}"
    request = urllib.request.Request(url, headers=MODRINTH_HEADERS)
    with urllib.request.urlopen(request, timeout=25) as response:
        versions = json.load(response)

    if not versions:
        return None

    versions.sort(key=lambda item: item.get("date_published") or "", reverse=True)
    for kind in ("release", "beta", "alpha"):
        found = next((item for item in versions if item.get("version_type") == kind), None)
        if found:
            return found
    return versions[0]


def ensure_fabric_api(progress: Progress) -> None:
    """Fabric API modunu bir kez indirir; başarısızlık kurulumu durdurmaz."""
    if has_fabric_api():
        return

    progress.set_status("Fabric API indiriliyor…")
    target = ""
    try:
        version = latest_release_version(FABRIC_API_SLUG, "fabric")
        if not version:
            progress.set_status(f"Fabric API {VERSION} için bulunamadı")
            return

        files = version.get("files") or []
        primary = next((item for item in files if item.get("primary")), None)
        chosen = primary or (files[0] if files else None)
        if not chosen:
            progress.set_status("Fabric API dosyası bulunamadı")
            return

        directory = mods_dir()
        target = os.path.join(directory, chosen["filename"])
        partial = f"{target}.part"
        request = urllib.request.Request(chosen["url"], headers=MODRINTH_HEADERS)
        with urllib.request.urlopen(request, timeout=60) as response, open(partial, "wb") as handle:
            total = int(response.headers.get("Content-Length") or 0)
            if total:
                progress.set_max(total)
                progress.set_progress(0)
            downloaded = 0
            while True:
                chunk = response.read(65536)
                if not chunk:
                    break
                handle.write(chunk)
                downloaded += len(chunk)
                if total:
                    progress.set_progress(downloaded)
        os.replace(partial, target)
        progress.set_status(f"Fabric API kuruldu ({version.get('version_number', '')})")
    except Exception as error:  # noqa: BLE001 — indirme hatası kurulumu bozmasın
        if target and os.path.exists(f"{target}.part"):
            try:
                os.remove(f"{target}.part")
            except OSError:
                pass
        progress.set_status(f"Fabric API atlandı: {error}")


def ensure_version(progress: Progress) -> str:
    """Sürümü ve seçili mod yükleyiciyi kurar; başlatılacak sürüm kimliğini döndürür."""
    os.makedirs(GAME_DIR, exist_ok=True)
    ids = installed_ids()

    if VERSION not in ids:
        progress.set_status(f"Minecraft {VERSION} indiriliyor…")
        minecraft_launcher_lib.install.install_minecraft_version(VERSION, GAME_DIR, progress.callback())
        ids = installed_ids()

    if LOADER == "fabric":
        found = pick(ids, "fabric-loader-", f"-{VERSION}")
        if found is None:
            progress.set_status("Fabric yükleyici kuruluyor…")
            minecraft_launcher_lib.fabric.install_fabric(VERSION, GAME_DIR, callback=progress.callback())
            ids = installed_ids()
            found = pick(ids, "fabric-loader-", f"-{VERSION}")
        # Fabric modları Fabric API olmadan çalışmaz; otomatik kurulur.
        ensure_fabric_api(progress)
        return found or VERSION

    if LOADER == "quilt":
        found = pick(ids, "quilt-loader-", f"-{VERSION}")
        if found is None:
            progress.set_status("Quilt yükleyici kuruluyor…")
            minecraft_launcher_lib.quilt.install_quilt(VERSION, GAME_DIR, callback=progress.callback())
            ids = installed_ids()
            found = pick(ids, "quilt-loader-", f"-{VERSION}")
        return found or VERSION

    if LOADER == "forge":
        found = pick(ids, f"{VERSION}-forge-", VERSION) or pick(ids, f"{VERSION}-forge", VERSION)
        if found is None:
            forge_version = minecraft_launcher_lib.forge.find_forge_version(VERSION)
            if not forge_version:
                raise RuntimeError(f"{VERSION} için Forge sürümü bulunamadı")
            progress.set_status(f"Forge {forge_version} kuruluyor…")
            minecraft_launcher_lib.forge.install_forge_version(
                forge_version, GAME_DIR, callback=progress.callback()
            )
            ids = installed_ids()
            found = pick(ids, f"{VERSION}-forge-", VERSION) or pick(ids, f"{VERSION}-forge", VERSION)
        return found or VERSION

    return VERSION


def launch(launch_id: str, progress: Progress) -> int:
    options = {
        "username": USERNAME,
        "jvmArguments": [
            f"-Xmx{MEMORY}M",
            f"-Xms{max(512, MEMORY // 2)}M",
            *EXTRA_JVM_ARGS,
        ],
    }
    command = minecraft_launcher_lib.command.get_minecraft_command(launch_id, GAME_DIR, options)
    os.makedirs(os.path.join(GAME_DIR, "logs"), exist_ok=True)
    with open(os.path.join(GAME_DIR, "logs", "ymc-last-launch.txt"), "w", encoding="utf-8") as handle:
        handle.write(" ".join(command))

    progress.set_status("Oyun başlatılıyor…")
    # Windows'ta oyun Java süreci ayrı bir konsol penceresi açmasın.
    creation_flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    process = subprocess.Popen(command, cwd=GAME_DIR, creationflags=creation_flags)

    # Süreç kimliği sayesinde launcher oyunu durdurabilir.
    progress.pid = process.pid
    progress.status = "Oyun çalışıyor"
    progress.flush()

    exit_code = process.wait()

    progress.pid = None
    progress.status = "Kapandı"
    progress.flush()
    return exit_code


def main() -> int:
    progress = Progress()
    try:
        progress.set_status("Hazırlanıyor…")
        launch_id = ensure_version(progress)

        if MODE == "install":
            progress.set_status("Kurulum tamam")
            print(f"Kurulum tamam: {launch_id}", flush=True)
            return 0

        exit_code = launch(launch_id, progress)
        progress.set_status("Kapandı")
        return exit_code
    except Exception as error:  # noqa: BLE001 — hatayı arayüze taşı
        progress.set_status(f"Hata: {error}")
        print(f"Hata: {error}", file=sys.stderr, flush=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())
