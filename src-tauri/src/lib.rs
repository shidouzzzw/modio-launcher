use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use tauri::Manager;

/* ==========================================================================
   Yollar
   ========================================================================== */

/// Proje kökü (src-tauri'nin bir üstü) üzerinden launcher-service klasörü.
/// Kurulu uygulamada yürütülebilir dosyanın yanında aranır; bulunamazsa
/// geliştirme ortamındaki repo kökü kullanılır.
fn service_dir() -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        let mut current = exe.parent().map(|p| p.to_path_buf());
        while let Some(dir) = current {
            let candidate = dir.join("launcher-service");
            if candidate.join("launcher.py").exists() {
                return candidate;
            }
            current = dir.parent().map(|p| p.to_path_buf());
        }
    }
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."))
        .join("launcher-service")
}

/// launcher-service ikilisinin dosya adı (platforma göre).
fn service_binary_name() -> &'static str {
    if cfg!(windows) {
        "launcher-service.exe"
    } else {
        "launcher-service"
    }
}

fn python_bin() -> PathBuf {
    let venv = service_dir().join(".venv");
    if cfg!(windows) {
        venv.join("Scripts").join("python.exe")
    } else {
        venv.join("bin").join("python")
    }
}

fn python_script() -> PathBuf {
    service_dir().join("launcher.py")
}

/// Paketlenmiş (dondurulmuş) launcher-service ikilisini arar.
///
/// Yayınlanan sürümde kullanıcıdan Python istenmesin diye `launcher.py`
/// PyInstaller ile tek dosyaya dondurulup pakete kaynak olarak eklenir.
/// Geliştirmede bulunamazsa `None` döner ve Python'a düşülür.
fn frozen_service(app: &tauri::AppHandle) -> Option<PathBuf> {
    let name = service_binary_name();
    let mut candidates: Vec<PathBuf> = Vec::new();

    // 1) Paket kaynak klasörü (kurulu sürüm).
    if let Ok(resources) = app.path().resource_dir() {
        candidates.push(resources.join("binaries").join(name));
        candidates.push(resources.join(name));
    }

    // 2) Ana ikilinin yanı (bazı paket biçimleri dosyaları buraya koyar).
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join(name));
            candidates.push(dir.join("binaries").join(name));
        }
    }

    let found = candidates.into_iter().find(|path| path.is_file())?;
    ensure_executable(&found);
    Some(found)
}

/// Paketleme sırasında çalıştırma izni düşmüş olabilir; düzeltmeyi dener.
#[cfg(unix)]
fn ensure_executable(path: &PathBuf) {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(meta) = path.metadata() {
        let mode = meta.permissions().mode();
        if mode & 0o111 == 0 {
            let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode | 0o755));
        }
    }
}

#[cfg(not(unix))]
fn ensure_executable(_path: &PathBuf) {}

/// Alt süreçler Windows'ta konsol penceresi açmasın.
#[cfg(windows)]
fn hide_console(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    /// `CREATE_NO_WINDOW`: konsol penceresi olmadan başlat.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_console(_command: &mut Command) {}

/// launcher-service'in nasıl çalıştırılacağı: dondurulmuş ikili mi, Python mu?
struct Service {
    program: PathBuf,
    args: Vec<String>,
}

impl Service {
    /// Argümanları hazır bir komut üretir; ortam değişkenlerini çağıran ekler.
    fn command(&self) -> Command {
        let mut command = Command::new(&self.program);
        command.args(&self.args);
        // Windows'ta servis süreci siyah bir konsol penceresi açmasın.
        hide_console(&mut command);
        command
    }
}

/// launcher-service'i bulur. Öncelik dondurulmuş ikilide, sonra geliştirme
/// ortamındaki sanal ortamdadır.
fn resolve_service(app: &tauri::AppHandle, mode: &str) -> Result<Service, String> {
    let frozen = || {
        frozen_service(app).map(|binary| Service {
            program: binary,
            args: vec![mode.to_string()],
        })
    };
    let live = || {
        let python = python_bin();
        python.is_file().then(|| Service {
            program: python,
            args: vec![
                python_script().to_string_lossy().to_string(),
                mode.to_string(),
            ],
        })
    };

    // Geliştirmede launcher.py canlı çalışır: dondurulmuş ikili kaynağı
    // değiştirdikten sonra eskiyip yanıltıcı olur. Yayında ise önce
    // dondurulmuş ikili denenir, çünkü kullanıcıda Python olmayabilir.
    let service = if cfg!(debug_assertions) {
        live().or_else(frozen)
    } else {
        frozen().or_else(live)
    };

    service.ok_or_else(|| {
        format!(
            "launcher-service bulunamadı: '{}' pakete eklenmemiş ve {} yok",
            service_binary_name(),
            python_bin().display()
        )
    })
}

fn sanitize_id(id: &str) -> String {
    let cleaned: String = id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    if cleaned.is_empty() {
        "instance".to_string()
    } else {
        cleaned
    }
}

/// Kullanıcı veri kökü (~/.local/share/modio-launcher, macOS ve Windows'ta
/// platformun kendi veri klasörü). Eski `ymc-launcher` klasörü buraya taşınır.
fn data_root() -> Result<PathBuf, String> {
    let data = dirs::data_dir().ok_or_else(|| "Veri dizini bulunamadı".to_string())?;
    let root = data.join("modio-launcher");
    let legacy = data.join("ymc-launcher");
    // Eski sürümden kalan veri klasörünü yeni ada taşı; kullanıcı kaybı olmasın.
    if !root.exists() && legacy.exists() {
        let _ = std::fs::rename(&legacy, &root);
    }
    Ok(root)
}

/// Varsayılan örneğin oyun klasörü.
///
/// Eskiden uygulama klasörünün içindeydi (`launcher-service/minecraft`); bu
/// yüzden bir güncelleme kullanıcının dünyalarını ve modlarını silebilirdi.
/// İlk çalıştırmada veri kullanıcı klasörüne taşınır; taşınamazsa (başka disk)
/// mevcut veri yerinde bırakılır ve kaybolmaz.
fn default_instance_dir() -> Result<PathBuf, String> {
    let target = data_root()?.join("instances").join("default");
    if target.is_dir() {
        return Ok(target);
    }

    let legacy = service_dir().join("minecraft");
    if legacy.is_dir() {
        if let Some(parent) = target.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if std::fs::rename(&legacy, &target).is_ok() {
            return Ok(target);
        }
        // Taşınamadı: veriyi riske atmamak için mevcut klasör kullanılmaya devam eder.
        return Ok(legacy);
    }

    std::fs::create_dir_all(&target).map_err(|e| format!("Oyun klasörü oluşturulamadı: {e}"))?;
    Ok(target)
}

/// Örneğin oyun klasörü. "default" örneği kullanıcı veri klasöründe durur.
fn instance_game_dir(instance: Option<&str>) -> Result<PathBuf, String> {
    let dir = match instance {
        None | Some("") | Some("default") => default_instance_dir()?,
        Some(id) => data_root()?.join("instances").join(sanitize_id(id)),
    };
    std::fs::create_dir_all(&dir).map_err(|e| format!("Oyun klasörü oluşturulamadı: {e}"))?;
    Ok(dir)
}

fn progress_file(instance: Option<&str>) -> Result<PathBuf, String> {
    Ok(instance_game_dir(instance)?.join(".ymc-progress.json"))
}

/// Kategoriye göre hedef klasör: mods / shaderpacks / resourcepacks.
fn category_dir(kind: &str, instance: Option<&str>) -> Result<PathBuf, String> {
    let folder = match kind {
        "shader" => "shaderpacks",
        "resourcepack" => "resourcepacks",
        _ => "mods",
    };
    let dir = instance_game_dir(instance)?.join(folder);
    std::fs::create_dir_all(&dir).map_err(|e| format!("{folder} klasörü oluşturulamadı: {e}"))?;
    Ok(dir)
}

/* ==========================================================================
   Başlatma

   Launcher tek bir sürüm için tasarlandı (arayüzde LOCKED_VERSION);
   bu yüzden sürüm listesi indirilmez, oyun sürümü arayüzden gelir.
   ========================================================================== */

#[tauri::command]
fn game_dir(instance: Option<String>) -> Result<String, String> {
    Ok(instance_game_dir(instance.as_deref())?
        .to_string_lossy()
        .to_string())
}

/// Oyunu, seçili örneğin klasöründe ve sürümünde başlatır.
/// Sürüm kurulu değilse launcher.py önce kurar.
#[tauri::command]
fn launch_minecraft(
    app: tauri::AppHandle,
    username: String,
    version: String,
    loader: Option<String>,
    instance: Option<String>,
    memory: Option<u32>,
    jvm_args: Option<String>,
) -> Result<String, String> {
    let dir = instance_game_dir(instance.as_deref())?;
    let progress = progress_file(instance.as_deref())?;
    let service = resolve_service(&app, "launch")?;

    service
        .command()
        .env("BLOCKFORGE_USERNAME", &username)
        .env("YMC_VERSION", &version)
        .env("YMC_LOADER", loader.unwrap_or_else(|| "vanilla".to_string()))
        .env("YMC_GAME_DIR", &dir)
        .env("YMC_PROGRESS_FILE", &progress)
        .env("YMC_MEMORY", memory.unwrap_or(2048).to_string())
        .env("YMC_JVM_ARGS", jvm_args.unwrap_or_default())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Minecraft başlatılamadı: {e}"))?;

    Ok(format!("Minecraft {version} başlatılıyor…"))
}

/// Örneği kurar (sürüm + mod yükleyici). Kurulum bitene kadar bekler.
#[tauri::command]
async fn install_instance(
    app: tauri::AppHandle,
    version: String,
    loader: Option<String>,
    instance: Option<String>,
) -> Result<String, String> {
    let dir = instance_game_dir(instance.as_deref())?;
    let progress = progress_file(instance.as_deref())?;
    let loader = loader.unwrap_or_else(|| "vanilla".to_string());
    let service = resolve_service(&app, "install")?;

    let output = tauri::async_runtime::spawn_blocking(move || {
        service
            .command()
            .env("YMC_VERSION", &version)
            .env("YMC_LOADER", &loader)
            .env("YMC_GAME_DIR", &dir)
            .env("YMC_PROGRESS_FILE", &progress)
            .output()
    })
    .await
    .map_err(|e| format!("Kurulum başlatılamadı: {e}"))?
    .map_err(|e| format!("Kurulum başlatılamadı: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let last = stderr.lines().last().unwrap_or("Kurulum başarısız");
        return Err(last.to_string());
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[derive(serde::Serialize, serde::Deserialize)]
struct InstallProgress {
    status: String,
    current: f64,
    total: f64,
    time: f64,
    #[serde(default)]
    pid: Option<i64>,
    #[serde(default)]
    launcher_pid: Option<i64>,
    /// Oyun süreci gerçekten ayakta mı? (dosyadan değil, /proc üzerinden doğrulanır)
    #[serde(default)]
    running: bool,
}

#[cfg(unix)]
fn process_alive(pid: i64) -> bool {
    std::path::Path::new(&format!("/proc/{pid}")).exists()
}

/// Windows'ta `tasklist` CSV çıktısının PID sütununa bakar; dile bağlı
/// bilgi metinlerine güvenmez.
#[cfg(windows)]
fn process_alive(pid: i64) -> bool {
    let mut command = Command::new("tasklist");
    let pid_arg = format!("PID eq {pid}");
    command.args(["/FI", pid_arg.as_str(), "/NH", "/FO", "CSV"]);
    hide_console(&mut command);
    match command.output() {
        Ok(output) => String::from_utf8_lossy(&output.stdout).contains(&format!("\"{pid}\",")),
        Err(_) => false,
    }
}

/// launcher.py'nin yazdığı ilerleme dosyasını okur ve süreç durumunu doğrular.
fn read_progress(instance: Option<&str>) -> Result<Option<InstallProgress>, String> {
    let path = progress_file(instance)?;
    if !path.exists() {
        return Ok(None);
    }

    let raw = std::fs::read_to_string(&path).map_err(|e| format!("İlerleme okunamadı: {e}"))?;
    let mut parsed: InstallProgress = match serde_json::from_str(&raw) {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };

    parsed.running = parsed.pid.map(process_alive).unwrap_or(false);
    Ok(Some(parsed))
}

#[tauri::command]
fn instance_progress(instance: Option<String>) -> Result<Option<InstallProgress>, String> {
    read_progress(instance.as_deref())
}

#[cfg(unix)]
fn terminate(pid: i64) {
    let _ = Command::new("kill").arg("-TERM").arg(pid.to_string()).status();
    std::thread::sleep(std::time::Duration::from_millis(700));
    if process_alive(pid) {
        let _ = Command::new("kill").arg("-KILL").arg(pid.to_string()).status();
    }
}

/// Windows'ta süreç ağacıyla birlikte kapatılır: Java kendi alt süreçlerini
/// açabildiği için yalnızca ana süreci öldürmek oyunu açık bırakır.
#[cfg(windows)]
fn terminate(pid: i64) {
    let mut command = Command::new("taskkill");
    let pid_arg = pid.to_string();
    command.args(["/PID", pid_arg.as_str(), "/T", "/F"]);
    hide_console(&mut command);
    let _ = command.status();
}

/// Çalışan Minecraft sürecini (ve bekleyen launcher.py'yi) kapatır.
#[tauri::command]
fn stop_minecraft(instance: Option<String>) -> Result<String, String> {
    let progress =
        read_progress(instance.as_deref())?.ok_or_else(|| "Çalışan bir oyun bulunamadı".to_string())?;

    let pid = progress
        .pid
        .ok_or_else(|| "Oyun süreci bulunamadı".to_string())?;

    terminate(pid);

    if let Some(launcher) = progress.launcher_pid {
        if process_alive(launcher) {
            terminate(launcher);
        }
    }

    Ok("Oyun kapatılıyor…".to_string())
}

/* ================= MODS (Modrinth + CurseForge linkleri) ================= */

#[derive(serde::Serialize)]
struct InstalledMod {
    file_name: String,
    size_bytes: u64,
}

#[derive(Clone, serde::Serialize)]
struct DownloadState {
    status: String,
    current: u64,
    total: u64,
}

/// Devam eden indirmelerin ilerlemesi (id -> durum).
#[derive(Default)]
struct Downloads(std::sync::Mutex<std::collections::HashMap<String, DownloadState>>);

fn set_download(state: &Downloads, id: &str, patch: DownloadState) {
    if let Ok(mut map) = state.0.lock() {
        map.insert(id.to_string(), patch);
    }
}

#[tauri::command]
fn download_progress(state: tauri::State<'_, Downloads>, id: String) -> Option<DownloadState> {
    state.0.lock().ok()?.get(&id).cloned()
}

fn sanitize_filename(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if cleaned.is_empty() {
        "download.jar".to_string()
    } else {
        cleaned
    }
}

#[tauri::command]
async fn list_mods(kind: Option<String>, instance: Option<String>) -> Result<Vec<InstalledMod>, String> {
    let dir = category_dir(kind.as_deref().unwrap_or("mod"), instance.as_deref())?;
    let mut mods = Vec::new();

    let entries = std::fs::read_dir(&dir).map_err(|e| format!("Klasör okunamadı: {e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        let extension = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        // Modlar .jar, shader ve doku paketleri .zip olarak gelir.
        if extension == "jar" || extension == "zip" {
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            mods.push(InstalledMod {
                file_name: entry.file_name().to_string_lossy().to_string(),
                size_bytes: size,
            });
        }
    }

    mods.sort_by(|a, b| a.file_name.to_lowercase().cmp(&b.file_name.to_lowercase()));
    Ok(mods)
}

#[tauri::command]
async fn delete_mod(
    file_name: String,
    kind: Option<String>,
    instance: Option<String>,
) -> Result<(), String> {
    let dir = category_dir(kind.as_deref().unwrap_or("mod"), instance.as_deref())?;
    // Path traversal koruması: sadece dosya adına izin ver
    if file_name.contains('/') || file_name.contains('\\') || file_name.contains("..") {
        return Err("Geçersiz dosya adı".to_string());
    }
    let path = dir.join(&file_name);
    std::fs::remove_file(&path).map_err(|e| format!("Dosya silinemedi: {e}"))?;
    Ok(())
}

#[tauri::command]
async fn download_mod(
    state: tauri::State<'_, Downloads>,
    id: Option<String>,
    url: String,
    file_name: String,
    kind: Option<String>,
    instance: Option<String>,
) -> Result<InstalledMod, String> {
    if !url.starts_with("https://cdn.modrinth.com/") {
        return Err("Yalnızca Modrinth CDN bağlantılarına izin veriliyor".to_string());
    }

    let dir = category_dir(kind.as_deref().unwrap_or("mod"), instance.as_deref())?;
    let safe_name = sanitize_filename(&file_name);
    let dest = dir.join(&safe_name);
    let download_id = id.unwrap_or_else(|| safe_name.clone());

    set_download(
        &state,
        &download_id,
        DownloadState {
            status: "İndiriliyor…".to_string(),
            current: 0,
            total: 0,
        },
    );

    let mut response = reqwest::get(&url)
        .await
        .map_err(|e| format!("İndirme başlatılamadı: {e}"))?;

    if !response.status().is_success() {
        return Err(format!("İndirme başarısız (HTTP {})", response.status()));
    }

    let total = response.content_length().unwrap_or(0);
    set_download(
        &state,
        &download_id,
        DownloadState {
            status: "İndiriliyor…".to_string(),
            current: 0,
            total,
        },
    );

    let mut file = std::fs::File::create(&dest).map_err(|e| format!("Dosya yazılamadı: {e}"))?;
    let mut written: u64 = 0;

    // Parça parça yazıp ilerlemeyi arayüze bildiriyoruz.
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("İndirme kesildi: {e}"))?
    {
        file.write_all(&chunk)
            .map_err(|e| format!("Dosya yazılamadı: {e}"))?;
        written += chunk.len() as u64;
        set_download(
            &state,
            &download_id,
            DownloadState {
                status: "İndiriliyor…".to_string(),
                current: written,
                total,
            },
        );
    }

    file.flush().ok();
    drop(file);

    set_download(
        &state,
        &download_id,
        DownloadState {
            status: "İndirildi".to_string(),
            current: written,
            total: written.max(total),
        },
    );

    Ok(InstalledMod {
        file_name: safe_name,
        size_bytes: written,
    })
}

/// CurseForge doğrudan API anahtarı gerektirdiği için site bağlantısı açar.
/// Tarayıcı, Tauri'nin açıcı eklentisiyle açılır: `xdg-open` yalnızca Linux'ta
/// bulunur, eklenti ise üç platformda da doğru çalışır.
#[tauri::command]
fn open_curseforge(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(
            "https://www.curseforge.com/minecraft/search?search=mods",
            None::<&str>,
        )
        .map_err(|e| format!("Tarayıcı açılamadı: {e}"))
}

/// Java çalıştırıcısının dosya adı (Windows'ta `.exe`).
fn java_binary_name() -> &'static str {
    if cfg!(windows) {
        "java.exe"
    } else {
        "java"
    }
}

/// PATH üzerinden Java arar (Windows: `where`, diğerleri: `command -v`).
#[cfg(windows)]
fn java_from_path() -> Option<PathBuf> {
    let mut command = Command::new("where");
    command.arg(java_binary_name());
    hide_console(&mut command);
    let output = command.output().ok()?;
    let first = String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()
        .unwrap_or_default()
        .trim()
        .to_string();
    (!first.is_empty()).then(|| PathBuf::from(first))
}

#[cfg(not(windows))]
fn java_from_path() -> Option<PathBuf> {
    let output = Command::new("sh")
        .arg("-c")
        .arg("command -v java || true")
        .output()
        .ok()?;
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!path.is_empty()).then(|| PathBuf::from(path))
}

/// Sistemin Java çalıştırıcısının tam yolunu döndürür (önce JAVA_HOME, sonra PATH).
#[tauri::command]
fn java_path() -> Result<String, String> {
    if let Ok(home) = std::env::var("JAVA_HOME") {
        let candidate = PathBuf::from(home).join("bin").join(java_binary_name());
        if candidate.exists() {
            return Ok(candidate.to_string_lossy().to_string());
        }
    }
    java_from_path()
        .map(|path| path.to_string_lossy().to_string())
        .ok_or_else(|| "Java bulunamadı".to_string())
}

/// Güncelleme kontrolü: sürüm bilgisi burada yayınlanır, ön yüz buradan okur.
/// Yeni sürüm yayınlarken bu URL'deki JSON'ı güncellemek yeterli:
///   { "latest": "0.1.1", "url": "https://..." }
/// Yayın öncesi bu dosya yoksa kontrol sessizce "güncel" der.
#[tauri::command]
async fn check_update(current: Option<String>) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let response = client
        .get("https://modio-launcher.vercel.app/version.json")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Ok(serde_json::json!({ "latest": current.unwrap_or_default(), "upToDate": true }));
    }
    let body: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
    let latest = body["latest"].as_str().unwrap_or_default().to_string();
    let up_to_date = latest.is_empty() || latest == current.unwrap_or_default();
    Ok(serde_json::json!({
        "latest": latest,
        "url": body["url"].as_str().unwrap_or_default(),
        "upToDate": up_to_date
    }))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(Downloads::default())
        .invoke_handler(tauri::generate_handler![
            game_dir,
            launch_minecraft,
            stop_minecraft,
            install_instance,
            instance_progress,
            list_mods,
            delete_mod,
            download_mod,
            download_progress,
            open_curseforge,
            check_update,
            java_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
