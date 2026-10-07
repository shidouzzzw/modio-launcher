#!/usr/bin/env bash
#
# launcher.py'yi tek bir çalıştırılabilir dosyaya dondurur ve Tauri'nin pakete
# kaynak olarak ekleyeceği klasöre kopyalar.
#
# Amaç: kullanıcı bilgisayarında Python kurulu olmasın. Python yorumlayıcısı,
# minecraft_launcher_lib ve requests ikilinin içine gömülür.
#
# Kullanım:
#     ./launcher-service/build-sidecar.sh [hedef_klasör]
#
# Not: PyInstaller çapraz derleme yapamaz; her işletim sistemi için kendi
# makinesinde (veya CI'da kendi runner'ında) çalıştırılmalıdır.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "${here}/.." && pwd)"
target="${1:-${root}/src-tauri/binaries}"

case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*)
    venv_python="${here}/.venv/Scripts/python.exe"
    suffix=".exe"
    ;;
  *)
    venv_python="${here}/.venv/bin/python"
    suffix=""
    ;;
esac

# Windows'ta genelde `python3` yoktur, `python` vardır.
if command -v python3 >/dev/null 2>&1; then
  base_python="python3"
else
  base_python="python"
fi

if [ ! -x "${venv_python}" ]; then
  echo "→ Sanal ortam oluşturuluyor: ${here}/.venv"
  "${base_python}" -m venv "${here}/.venv"
fi

# Önce çalışma zamanı bağımlılıkları (launcher.py neyi içe aktarıyorsa), sonra
# PyInstaller. requirements.txt olmadan temiz bir makinede/CI'da dondurma
# "No module named 'minecraft_launcher_lib'" ile kırılır.
if [ ! -f "${here}/requirements.txt" ]; then
  echo "✗ ${here}/requirements.txt bulunamadı; bağımlılıklar kurulamaz" >&2
  exit 1
fi
echo "→ Çalışma zamanı bağımlılıkları kuruluyor (requirements.txt)"
"${venv_python}" -m pip install --quiet --disable-pip-version-check --upgrade \
  -r "${here}/requirements.txt"

echo "→ PyInstaller kuruluyor"
"${venv_python}" -m pip install --quiet --disable-pip-version-check --upgrade pyinstaller

# ---------------------------------------------------------------------------
# Kullanılmayan modülleri dışla.
#
# Ölçüm: dışlama olmadan ikilinin içinde 130 setuptools + 3 pydoc modülü
# (kaynak olarak ~2,3 MB) geliyordu; hiçbiri çalışma zamanında kullanılmıyor.
# `email`, `http` ve `multiprocessing` DIŞLANMAZ: sırasıyla http.client,
# concurrent.futures ve urllib3 bunları gerçekten içe aktarıyor.
# ---------------------------------------------------------------------------
excludes=(
  setuptools
  pkg_resources
  pydoc
  pydoc_data
  distutils
  curses
  tkinter
  unittest
  doctest
  lib2to3
  idlelib
  pip
  wheel
)
exclude_args=()
for module in "${excludes[@]}"; do
  exclude_args+=(--exclude-module "${module}")
done

# ---------------------------------------------------------------------------
# UPX sıkıştırması sadece istenirse açılır (YMC_UPX=1) ve PATH'teki upx
# kullanılır. Varsayılan kapalı olmasının iki sebebi:
#   * PyInstaller, UPX'i Linux/macOS'ta bilinen uyumluluk sorunları yüzünden
#     KENDİSİ devre dışı bırakır ("UPX is available but is disabled on
#     non-Windows"); yani oralarda bir kazanç beklenmemeli.
#   * Windows'ta etkilidir ama Defender'ın --onefile çıktısını yanlış
#     işaretlemesine yol açabilir.
# ---------------------------------------------------------------------------
upx_args=(--noupx)
upx_name="upx${suffix}"
if [ -n "${YMC_UPX:-}" ]; then
  if command -v "${upx_name}" >/dev/null 2>&1; then
    upx_bin="$(dirname "$(command -v "${upx_name}")")"
    echo "→ UPX istendi, kullanılacak: ${upx_bin}"
    upx_args=(--upx-dir "${upx_bin}")
  else
    echo "→ YMC_UPX verildi ama PATH'te ${upx_name} yok; sıkıştırma atlanıyor"
  fi
fi

echo "→ launcher.py donduruluyor"
"${venv_python}" -m PyInstaller \
  --noconfirm \
  --clean \
  --onefile \
  --name launcher-service \
  --optimize 2 \
  "${exclude_args[@]}" \
  "${upx_args[@]}" \
  --distpath "${here}/dist" \
  --workpath "${here}/build" \
  --specpath "${here}" \
  "${here}/launcher.py"

mkdir -p "${target}"
cp "${here}/dist/launcher-service${suffix}" "${target}/launcher-service${suffix}"
chmod +x "${target}/launcher-service${suffix}" 2>/dev/null || true

size=$(du -h "${target}/launcher-service${suffix}" | cut -f1)
bytes=$(wc -c < "${target}/launcher-service${suffix}")
echo "✓ Hazır: ${target}/launcher-service${suffix} (${size}, ${bytes} bayt)"
