import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getCurrentWindow } from "@tauri-apps/api/window";

/* ==========================================================================
   Types
   ========================================================================== */

interface VersionEntry {
  id: string;
  type: string;
  releaseTime?: string;
}

interface VersionManifest {
  latest: { release: string; snapshot: string };
  versions: VersionEntry[];
}

interface OfflineAccount {
  username: string;
  createdAt: string;
}

interface ModrinthHit {
  project_id: string;
  slug: string;
  title: string;
  description: string;
  downloads: number;
  icon_url: string | null;
  author?: string;
  project_type?: string;
}

interface InstalledMod {
  file_name: string;
  size_bytes: number;
}

interface ServerEntry {
  name: string;
  address: string;
  createdAt: string;
}

type LoaderKind = "vanilla" | "fabric" | "quilt" | "forge";

interface InstanceEntry {
  id: string;
  name: string;
  version: string;
  loader: LoaderKind;
  createdAt: string;
  installedAt?: string;
}

interface InstallProgress {
  status: string;
  current: number;
  total: number;
  time: number;
  pid?: number | null;
  /** Oyun süreci ayakta mı? (Rust tarafı /proc üzerinden doğrular) */
  running: boolean;
}

interface FeaturedItem {
  id: string;
  title: string;
  description: string;
  downloads?: number;
  iconUrl?: string | null;
  url?: string;
  tint: number;
}

/* ==========================================================================
   Storage keys
   ========================================================================== */

const STORAGE_KEY = "ymc_offline_accounts";
const SELECTED_ACCOUNT_KEY = "ymc_selected_account";
const MEMORY_KEY = "ymc_memory_mb";
const VERSION_KEY = "ymc_selected_version";
const THEME_KEY = "ymc_theme";
const EXPERIMENTAL_KEY = "ymc_show_experimental";
const FAVORITES_KEY = "ymc_favorites";
const SERVERS_KEY = "ymc_servers";
const INSTANCES_KEY = "ymc_instances";
const INSTANCE_KEY = "ymc_selected_instance";
const INSTALLED_PROJECTS_KEY = "ymc_installed_projects";
const HIDE_LAUNCHER_KEY = "ymc_hide_launcher";
const PERF_MODE_KEY = "ymc_perf_mode";
const SCREEN_MODE_KEY = "ymc_screen_mode";
const JVM_ARGS_KEY = "ymc_jvm_args";
const PROFILE_KEY = "ymc_perf_profile";

/* ==========================================================================
   Small helpers
   ========================================================================== */

const $ = <T extends Element = HTMLElement>(selector: string) =>
  document.querySelector<T>(selector);
const $$ = <T extends Element = HTMLElement>(selector: string) =>
  Array.from(document.querySelectorAll<T>(selector));

const inTauri = () => "__TAURI_INTERNALS__" in window;

/** Oyuncu görselleri: çevrimdışı profiller için varsayılan skine düşer. */
function headshotUrl(name: string): string {
  return `https://mc-heads.net/avatar/${encodeURIComponent(name || "MHF_Steve")}/64`;
}

function hideLauncherWindow() {
  if (!inTauri() || localStorage.getItem(HIDE_LAUNCHER_KEY) === "0") return;
  void getCurrentWindow().hide();
}

function showLauncherWindow() {
  if (!inTauri()) return;
  void getCurrentWindow().show();
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function formatBytes(bytes: number): string {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

function formatDate(iso?: string): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString("tr-TR");
}

function tintFor(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) % 997;
  return (hash % 6) + 1;
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  localStorage.setItem(key, JSON.stringify(value));
}

/* ==========================================================================
   Toast & status
   ========================================================================== */

let toastTimer: number | undefined;

function toast(message: string) {
  const node = $("#toast");
  const text = $("#toast-text");
  if (!node || !text) return;

  text.textContent = message;
  node.classList.add("is-visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => node.classList.remove("is-visible"), 3200);
}

function setStatus(message: string, tone: "ready" | "busy" | "error" = "ready") {
  const status = $("#launch-status");
  const dot = $("#launch-dot");
  if (status) status.textContent = message;
  if (dot) {
    dot.classList.toggle("online", tone === "ready");
    dot.classList.toggle("busy", tone === "busy");
    dot.classList.toggle("error", tone === "error");
  }
}

/* ==========================================================================
   Theme
   ========================================================================== */

type ThemeChoice = "system" | "light" | "dark";

const ACCENT_KEY = "ymc_accent";

function storedTheme(): ThemeChoice {
  return "dark";
}

function applyTheme(_choice: ThemeChoice) {
  const resolved = "dark";
  document.documentElement.dataset.theme = resolved;

  const meta = $('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", resolved === "dark" ? "#000000" : "#ffffff");

}

/** Vurgu renginden türeyen gradyan uçları: daha açık ve daha koyu ton. */
function mix(hex: string, target: [number, number, number], amount: number): string {
  const [r, g, b] = hexToRgb(hex);
  const m = (channel: number, t: number) => clamp(channel + (t - channel) * amount);
  return `#${[m(r, target[0]), m(g, target[1]), m(b, target[2])]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("")}`;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function hexToRgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ];
}

function applyAccent(hex: string): void {
  const rgb = hexToRgb(hex);
  const root = document.documentElement.style;
  root.setProperty("--accent", `#${hex}`);
  root.setProperty("--accent-strong", mix(hex, [255, 255, 255], 0.18));
  root.setProperty("--accent-bright", mix(hex, [255, 255, 255], 0.28));
  root.setProperty("--accent-deep", mix(hex, [0, 0, 0], 0.34));
  root.setProperty("--accent-soft", `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.16)`);
  root.setProperty("--accent-line", `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.42)`);
}

function storedAccent(): string {
  return localStorage.getItem(ACCENT_KEY) ?? "0a84ff";
}

function setupAccentSwatches(): void {
  const container = $("#theme-swatches");
  if (container) {
    const saved = storedAccent();
    $$<HTMLButtonElement>(".swatch").forEach((button) => {
      const active = button.dataset.accent === saved;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-checked", String(active));
    });

    container.addEventListener("click", (event) => {
      const swatch = (event.target as HTMLElement).closest<HTMLButtonElement>(".swatch");
      if (!swatch?.dataset.accent) return;

      const hex = swatch.dataset.accent;
      localStorage.setItem(ACCENT_KEY, hex);
      applyAccent(hex);

      $$<HTMLButtonElement>(".swatch").forEach((item) => {
        const isActive = item === swatch;
        item.classList.toggle("is-active", isActive);
        item.setAttribute("aria-checked", String(isActive));
      });
    });
  }

  applyAccent(storedAccent());
}

function setupTheme() {
  applyTheme(storedTheme());

  const toggle = $("#theme-toggle");
  toggle?.addEventListener("click", () => {
    const next: ThemeChoice = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
  });
}

/* ==========================================================================
   Sliding thumbs (tab bar + segmented controls)
   ========================================================================== */

function placeThumb(
  container: HTMLElement,
  thumb: HTMLElement,
  target: HTMLElement,
  padding: number,
  inset = 8
) {
  const box = container.getBoundingClientRect();
  const item = target.getBoundingClientRect();
  const x = item.left - box.left - padding + inset / 2;
  thumb.style.width = `${item.width - inset}px`;
  thumb.style.transform = `translateX(${x}px)`;
}

function syncIndicators() {
  const nav = $("#sidebar-nav");
  const indicator = $("#nav-indicator");
  const activeItem = $<HTMLElement>(".nav-item.is-active");
  if (nav && indicator) {
    if (activeItem && nav.contains(activeItem)) {
      // Yatay sekme çubuğu: gösterge aktif öğenin altına kayar.
      placeThumb(nav, indicator, activeItem, 3, 0);
    } else {
      indicator.style.width = "0px";
    }
  }

  const options = $("#theme-options");
  const thumb = $("#theme-thumb");
  const active = options?.querySelector<HTMLElement>(".segment.is-active");
  if (options && thumb && active) placeThumb(options, thumb, active, 3, 0);

  const filters = $("#version-filters");
  const filtersThumb = $("#filters-thumb");
  const activeFilter = filters?.querySelector<HTMLElement>(".segment.is-active");
  if (filters && filtersThumb && activeFilter) placeThumb(filters, filtersThumb, activeFilter, 3, 0);

  const categories = $("#mod-categories");
  const categoryThumb = $("#mods-thumb");
  const activeCategory = categories?.querySelector<HTMLElement>(".segment.is-active");
  if (categories && categoryThumb && activeCategory) {
    placeThumb(categories, categoryThumb, activeCategory, 3, 0);
  }
}

/* ========================================================================== 
   Routing
   ========================================================================== */

type PageName = "home" | "mods" | "sponsors" | "settings";

const PAGES: PageName[] = ["home", "mods", "sponsors", "settings"];

const PAGE_META: Record<PageName, { title: string; sub: string }> = {
  home: { title: "Ana Sayfa", sub: "Seçili sürümün ve hızlı erişimlerin" },
  mods: { title: "Modlar", sub: "Mod, shader ve doku paketleri · Modrinth" },
  sponsors: { title: "Sponsorlar", sub: "Projeyi destekleyenler" },
  settings: { title: "Ayarlar", sub: "Hesap, bellek ve görünüm tercihleri" },
};

let activePage: PageName = "home";
const loaded: Record<string, boolean> = {};

function setPage(page: PageName) {
  if (!PAGES.includes(page)) return;
  activePage = page;

  $$<HTMLButtonElement>(".nav-item[data-page]").forEach((item) => {
    item.classList.toggle("is-active", item.dataset.page === page);
  });

  PAGES.forEach((name) => {
    $(`#page-${name}`)?.classList.toggle("is-active", name === page);
  });

  const meta = PAGE_META[page];
  const title = $("#page-title");
  const sub = $("#page-sub");
  if (title) title.textContent = meta.title;
  if (sub) sub.textContent = meta.sub;

  syncIndicators();

  window.scrollTo({ top: 0 });
  const viewport = $("#viewport");
  if (viewport) viewport.scrollTop = 0;

  if (page === "mods" && !loaded.mods) {
    loaded.mods = true;
    void renderInstalledMods();
    void searchMods("");
  }
}

function setupNavigation() {
  $$<HTMLButtonElement>(".nav-item[data-page]").forEach((item) => {
    item.addEventListener("click", () => setPage(item.dataset.page as PageName));
  });

  document.addEventListener("click", (event) => {
    const trigger = (event.target as HTMLElement).closest<HTMLElement>("[data-open-page]");
    if (!trigger) return;
    event.preventDefault();
    setPage(trigger.dataset.openPage as PageName);
  });
}

/* ==========================================================================
   Versions
   ========================================================================== */

const LOCKED_VERSION = "1.21.11";
let manifest: VersionManifest | null = null;
let selectedVersion: string | null = LOCKED_VERSION;
let versionQuery = "";
let versionFilter: "all" | "release" | "snapshot" = "all";
let showExperimental = localStorage.getItem(EXPERIMENTAL_KEY) === "1";
let launching = false;

function isExperimentalVersion(entry: VersionEntry): boolean {
  return entry.type !== "release";
}

function versionKind(entry: VersionEntry): "release" | "snapshot" {
  return entry.type === "release" ? "release" : "snapshot";
}

function versionDescription(entry: VersionEntry): string {
  const kind = versionKind(entry) === "release" ? "Kararlı sürüm" : "Deneysel sürüm";
  const date = formatDate(entry.releaseTime);
  return date === "—" ? kind : `${kind} · ${date}`;
}

function visibleVersions(): VersionEntry[] {
  if (!manifest) return [];
  return manifest.versions.filter((entry) => {
    if (versionFilter !== "all" && versionKind(entry) !== versionFilter) return false;
    // Snapshot'lar yalnızca filtre açıkken ya da anahtar açıldığında görünür.
    if (isExperimentalVersion(entry) && !showExperimental && versionFilter !== "snapshot") {
      return false;
    }
    if (versionQuery && !entry.id.toLowerCase().includes(versionQuery)) return false;
    return true;
  });
}

async function loadVersions() {
  manifest = {
    latest: { release: LOCKED_VERSION, snapshot: LOCKED_VERSION },
    versions: [{ id: LOCKED_VERSION, type: "release" }],
  };
  selectedVersion = LOCKED_VERSION;
  localStorage.setItem(VERSION_KEY, LOCKED_VERSION);
  setStatus("Hazır");

  renderDash();
  renderHomeGrid();
  renderLibraryGrid();
  // Manifest geldikten sonra başlat düğmesi yeniden değerlendirilir.
  syncLaunchButton();
}

function applyTint(element: Element | null, tint: number) {
  if (!element) return;
  for (let index = 1; index <= 6; index += 1) element.classList.remove(`thumb-tint-${index}`);
  element.classList.add(`thumb-tint-${tint}`);
}

function updateVersionLabel() {
  const instance = currentInstance();
  const isDefault = instance.id === DEFAULT_INSTANCE_ID;
  const entry = manifest?.versions.find((item) => item.id === instance.version);
  const title = instance.version
    ? isDefault
      ? `Minecraft ${instance.version}`
      : instance.name
    : "Sürüm yükleniyor…";

  const launchVersion = $("#launch-version");
  if (launchVersion) {
    launchVersion.textContent = instance.version
      ? `${LOADER_LABELS[instance.loader]} ${instance.version}`
      : "Sürüm yükleniyor…";
  }

  const launchThumb = $("#launch-thumb");
  if (launchThumb) launchThumb.textContent = instance.version ? tileLabel(instance.version) : "—";

  const dashVersion = $("#dash-version");
  if (dashVersion) dashVersion.textContent = instance.version ? title : "Sürüm seçilmedi";

  const dashMeta = $("#dash-meta");
  if (dashMeta) {
    const parts: string[] = [];
    if (!isDefault) parts.push(`Minecraft ${instance.version}`);
    if (entry) parts.push(versionDescription(entry));
    parts.push(LOADER_LABELS[instance.loader]);
    if (!isDefault) parts.push(`Örnek: ${instance.name}`);
    if (entry && instance.version === manifest?.latest.release) parts.push("En son sürüm");
    dashMeta.textContent = instance.version ? parts.filter(Boolean).join(" · ") : "Kütüphaneden bir sürüm seç.";
  }
}

function renderDash() {
  const instance = currentInstance();
  const seed = instance.version || "minecraft";
  applyTint($("#dash-thumb"), tintFor(seed));
  applyTint($("#launch-thumb"), tintFor(seed));
  updateVersionLabel();

  const statVersions = $("#stat-versions");
  if (statVersions && manifest) statVersions.textContent = String(manifest.versions.length);
}

function selectVersion() {
  selectedVersion = LOCKED_VERSION;
  localStorage.setItem(VERSION_KEY, LOCKED_VERSION);
  renderDash();
  renderInstances();
  renderHomeGrid();
  renderLibraryGrid();
  toast(`Sürüm sabit: ${LOCKED_VERSION}`);
}

/* ==========================================================================
   Instances (kurulumlar)
   ========================================================================== */

const DEFAULT_INSTANCE_ID = "default";
const LOADERS: LoaderKind[] = ["vanilla", "fabric", "quilt", "forge"];
const LOADER_LABELS: Record<LoaderKind, string> = {
  vanilla: "Vanilla",
  fabric: "Fabric",
  quilt: "Quilt",
  forge: "Forge",
};

function instances(): InstanceEntry[] {
  return readJson<InstanceEntry[]>(INSTANCES_KEY, []);
}

function selectedInstanceId(): string {
  return localStorage.getItem(INSTANCE_KEY) || DEFAULT_INSTANCE_ID;
}

function defaultInstance(): InstanceEntry {
  return {
    id: DEFAULT_INSTANCE_ID,
    name: "Varsayılan",
    version: LOCKED_VERSION,
    loader: "fabric",
    createdAt: "",
  };
}

function instanceById(id: string): InstanceEntry | null {
  if (id === DEFAULT_INSTANCE_ID) return defaultInstance();
  const instance = instances().find((entry) => entry.id === id);
  return instance ? { ...instance, version: LOCKED_VERSION } : null;
}

function currentInstance(): InstanceEntry {
  return instanceById(selectedInstanceId()) ?? defaultInstance();
}

function slugify(value: string): string {
  const map: Record<string, string> = {
    ç: "c",
    ğ: "g",
    ı: "i",
    İ: "i",
    ö: "o",
    ş: "s",
    ü: "u",
  };
  return value
    .toLowerCase()
    .replace(/[çğıİöşü]/g, (char) => map[char] ?? char)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function uniqueInstanceId(name: string): string {
  const taken = new Set(instances().map((entry) => entry.id));
  const base = slugify(name) || "ornek";
  let candidate = base;
  let index = 2;
  while (taken.has(candidate) || candidate === DEFAULT_INSTANCE_ID) {
    candidate = `${base}-${index}`;
    index += 1;
  }
  return candidate;
}

function instanceCard(entry: InstanceEntry): string {
  const isActive = entry.id === selectedInstanceId();
  const isDefault = entry.id === DEFAULT_INSTANCE_ID;
  const installed = isDefault || Boolean(entry.installedAt);

  return `
    <article class="instance-card${isActive ? " is-active" : ""}" data-instance-select="${escapeHtml(
      entry.id
    )}" tabindex="0" role="button" aria-label="${escapeHtml(entry.name)} örneği">
      <div class="instance-card-head">
        <span class="instance-tile thumb-tint-${tintFor(entry.id + entry.version)}">${escapeHtml(
          tileLabel(entry.version)
        )}</span>
        <div class="instance-text">
          <div class="instance-card-title">${escapeHtml(entry.name)}</div>
          <div class="instance-card-sub">Minecraft ${escapeHtml(entry.version)} · ${
            LOADER_LABELS[entry.loader]
          }</div>
        </div>
        ${
          isDefault
            ? ""
            : `<button class="icon-action danger" type="button" data-instance-delete="${escapeHtml(
                entry.id
              )}" aria-label="Örneği sil">
                 <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
               </button>`
        }
      </div>
      <div class="instance-card-badges">
        ${isActive ? '<span class="badge">Etkin</span>' : ""}
        <span class="badge badge-ghost">${LOADER_LABELS[entry.loader]}</span>
        <span class="badge badge-ghost">${installed ? "Kurulu" : "Kurulmadı"}</span>
      </div>
      <div class="progress" data-progress="${escapeHtml(entry.id)}" hidden><span></span></div>
      <div class="instance-card-foot">
        <span class="card-meta" data-mods="${escapeHtml(entry.id)}">—</span>
        ${
          isDefault
            ? ""
            : `<button class="select-btn" type="button" data-instance-install="${escapeHtml(entry.id)}">${
                installed ? "Yeniden kur" : "Kur"
              }</button>`
        }
      </div>
    </article>`;
}

function renderInstances() {
  const grid = $("#instance-grid");
  if (!grid) return;

  grid.innerHTML = [defaultInstance(), ...instances()].map(instanceCard).join("");
  void renderInstanceModCounts();
}

async function renderInstanceModCounts() {
  const nodes = $$<HTMLElement>("[data-mods]");
  if (!nodes.length) return;

  if (!inTauri()) {
    nodes.forEach((node) => {
      node.textContent = "—";
    });
    return;
  }

  await Promise.all(
    nodes.map(async (node) => {
      try {
        const list = await invoke<InstalledMod[]>("list_mods", {
          kind: "mod",
          instance: node.dataset.mods,
        });
        node.textContent = list.length ? `${list.length} mod kurulu` : "Mod yok";
      } catch {
        node.textContent = "";
      }
    })
  );
}

function selectInstance(id: string) {
  const entry = instanceById(id);
  if (!entry) return;

  localStorage.setItem(INSTANCE_KEY, id);
  renderInstances();
  renderDash();
  renderLaunchBar();
  void renderInstalledMods();
  void updateSettingsGameDir();
  toast(`Etkin örnek: ${entry.name}`);
}

function markInstalled(id: string) {
  writeJson(
    INSTANCES_KEY,
    instances().map((entry) =>
      entry.id === id ? { ...entry, installedAt: new Date().toISOString() } : entry
    )
  );
  renderInstances();
}

function deleteInstanceRow(id: string) {
  const entry = instanceById(id);
  writeJson(
    INSTANCES_KEY,
    instances().filter((item) => item.id !== id)
  );
  if (selectedInstanceId() === id) localStorage.setItem(INSTANCE_KEY, DEFAULT_INSTANCE_ID);

  renderInstances();
  renderDash();
  renderLaunchBar();
  void renderInstalledMods();
  void updateSettingsGameDir();
  toast(entry ? `${entry.name} listeden kaldırıldı (dosyalar diskte kaldı)` : "Örnek kaldırıldı");
}

/* --- kurulum ve ilerleme --- */

const progressTimers = new Map<string, number>();

function progressBar(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-progress="${id}"]`);
}

function setCardProgress(id: string, ratio: number | null, label = "") {
  const bar = progressBar(id);
  if (!bar) return;

  if (ratio === null) {
    bar.hidden = true;
    return;
  }

  bar.hidden = false;
  if (label) bar.setAttribute("title", label);
  const fill = bar.querySelector("span");
  if (fill) fill.style.width = `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`;
}

function stopWatching(id: string) {
  const timer = progressTimers.get(id);
  if (timer) window.clearInterval(timer);
  progressTimers.delete(id);
}

function isFinalStatus(status: string): boolean {
  return (
    status.startsWith("Hata") ||
    status === "Kurulum tamam" ||
    status === "Başlatıldı" ||
    status === "Kapandı"
  );
}

type WatchMode = "install" | "launch";

function watchInstanceProgress(
  id: string,
  mode: WatchMode = "install",
  onDone?: (status: string) => void
) {
  stopWatching(id);

  const timer = window.setInterval(() => {
    void (async () => {
      let data: InstallProgress | null = null;
      try {
        data = await invoke<InstallProgress | null>("instance_progress", { instance: id });
      } catch {
        /* ilerleme dosyası henüz yok */
      }
      if (!data) return;

      const ratio = data.total > 0 ? data.current / data.total : 0;
      setCardProgress(id, ratio, data.status);
      updateDownload(id, { status: data.status, ratio: data.running ? 1 : ratio });

      if (data.running) {
        if (mode === "launch") {
          setLaunchState("running");
          setStatus("Oyun çalışıyor");
        }
        // Oyun açıldı; indirme satırı işini bitirdi.
        finishDownload(id);
      } else if (!isFinalStatus(data.status)) {
        if (mode === "launch") setStatus(data.status, "busy");
      }

      if (!isFinalStatus(data.status)) return;

      stopWatching(id);
      setCardProgress(id, null);

      const failed = data.status.startsWith("Hata");
      finishDownload(id, failed ? "error" : "done");

      if (mode === "launch") {
        setLaunchState("idle");
        if (failed) {
          setStatus("Başlatılamadı", "error");
          toast(data.status);
        } else {
          setStatus("Hazır");
        }
      }

      if (onDone) onDone(data.status);
    })();
  }, 800);

  progressTimers.set(id, timer);
}

async function installInstance(entry: InstanceEntry, button?: HTMLButtonElement) {
  if (!inTauri()) {
    toast("Kurulum masaüstü uygulamasında yapılır");
    return;
  }

  const label = button?.querySelector("span");
  const original = label?.textContent ?? "";
  if (button) {
    button.disabled = true;
    if (label) label.textContent = "Kuruluyor…";
  }

  setCardProgress(entry.id, 0, "Kuruluyor…");
  addDownload(entry.id, entry.name, "Kuruluyor…");
  setStatus(`${entry.name} kuruluyor…`, "busy");

  const restore = () => {
    if (button) {
      button.disabled = false;
      if (label) label.textContent = original;
    }
  };

  watchInstanceProgress(entry.id, "install", (status) => {
    restore();
    if (status.startsWith("Hata")) {
      setStatus("Kurulum başarısız", "error");
      toast(status);
      return;
    }
    markInstalled(entry.id);
    setStatus("Hazır");
    toast(`${entry.name} kuruldu`);
  });

  try {
    await invoke<string>("install_instance", {
      version: entry.version,
      loader: entry.loader,
      instance: entry.id,
    });
  } catch (error) {
    stopWatching(entry.id);
    setCardProgress(entry.id, null);
    restore();
    setStatus("Kurulum başarısız", "error");
    toast(`Kurulum başarısız: ${String(error)}`);
  }
}

/* --- yeni örnek formu --- */

function instanceSheet(): string {
  const releases = (manifest?.versions ?? [])
    .filter((entry) => versionKind(entry) === "release")
    .slice(0, 80);
  const active = currentInstance();

  return `
    <div class="sheet-header">
      <span class="sheet-icon thumb-tint-${tintFor("instance")}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.6 20.4 7v10L12 21.4 3.6 17V7L12 2.6Z" />${CUBE_INNER}</svg>
      </span>
      <div>
        <h2 class="sheet-title" id="sheet-title">Yeni örnek</h2>
        <p class="sheet-sub">Sürüm ve mod yükleyicisi ayrı bir klasörde çalışır</p>
      </div>
    </div>
    <div class="sheet-form">
      <label class="field">
        <span class="field-label">ÖRNEK ADI</span>
        <input id="instance-name" maxlength="40" placeholder="örn. Fabric Macera" autocomplete="off" />
      </label>
      <label class="field">
        <span class="field-label">MINECRAFT SÜRÜMÜ</span>
        <select id="instance-version">
          ${releases
            .map(
              (entry) =>
                `<option value="${escapeHtml(entry.id)}"${
                  entry.id === active.version ? " selected" : ""
                }>${escapeHtml(entry.id)}</option>`
            )
            .join("")}
        </select>
      </label>
      <div class="field">
        <span class="field-label">MOD YÜKLEYİCİ</span>
        <div class="segmented segmented-wide" id="instance-loader" role="tablist" aria-label="Mod yükleyici">
          <span class="segmented-thumb" id="loader-thumb" aria-hidden="true"></span>
          ${LOADERS.map(
            (loader, index) =>
              `<button class="segment${index === 0 ? " is-active" : ""}" type="button" data-loader="${loader}" role="tab">${
                LOADER_LABELS[loader]
              }</button>`
          ).join("")}
        </div>
      </div>
    </div>
    <p class="panel-note">
      Kurulum; sürüm dosyalarını, kütüphaneleri ve seçilen yükleyiciyi indirir. Modlar, shaderlar ve
      dünyalar örneğin kendi klasöründe tutulur.
    </p>
    <div class="sheet-actions">
      <button class="btn btn-secondary" type="button" data-close-sheet="true">Vazgeç</button>
      <button class="btn btn-primary" type="button" id="instance-create">Oluştur ve kur</button>
    </div>`;
}

function openInstanceSheet() {
  openSheet(instanceSheet());

  // Sheet animasyonu bitince göstergeyi yerleştir (ölçüler transform'suz olmalı).
  window.setTimeout(() => {
    const container = $("#instance-loader");
    const thumb = $("#loader-thumb");
    const active = container?.querySelector<HTMLElement>(".segment.is-active");
    if (container && thumb && active) placeThumb(container, thumb, active, 3, 0);

    $$<HTMLButtonElement>(".segment[data-loader]").forEach((button) => {
      button.addEventListener("click", () => {
        $$(".segment[data-loader]").forEach((item) => item.classList.remove("is-active"));
        button.classList.add("is-active");
        if (container && thumb) placeThumb(container, thumb, button, 3, 0);
      });
    });

    $("#instance-create")?.addEventListener("click", createInstanceFromSheet);
  }, 380);
}

function createInstanceFromSheet() {
  const nameInput = $<HTMLInputElement>("#instance-name");
  const versionSelect = $<HTMLSelectElement>("#instance-version");
  const loaderButton = $<HTMLElement>(".segment[data-loader].is-active");

  const version = versionSelect?.value ?? "";
  const loader = (loaderButton?.dataset.loader as LoaderKind) ?? "vanilla";
  const rawName = nameInput?.value.trim() ?? "";

  if (!version) {
    toast("Önce bir Minecraft sürümü seç");
    return;
  }

  const name = rawName || `${LOADER_LABELS[loader]} ${version}`;
  const id = uniqueInstanceId(name);
  const entry: InstanceEntry = {
    id,
    name,
    version,
    loader,
    createdAt: new Date().toISOString(),
  };

  writeJson(INSTANCES_KEY, [...instances(), entry]);
  localStorage.setItem(INSTANCE_KEY, id);

  closeSheet();
  renderInstances();
  renderDash();
  renderLaunchBar();
  void renderInstalledMods();
  void updateSettingsGameDir();
  toast(`Örnek oluşturuldu: ${name}`);

  window.setTimeout(() => {
    const button = document.querySelector<HTMLButtonElement>(`[data-instance-install="${id}"]`);
    void installInstance(entry, button ?? undefined);
  }, 260);
}

/* ------------------------------- cards ---------------------------------- */

function favoriteButton(key: string): string {
  const isFav = favorites().includes(key);
  return `
    <button class="fav${isFav ? " is-active" : ""}" type="button" data-fav="${escapeHtml(key)}"
      aria-label="Favorilere ekle" aria-pressed="${isFav}">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 20s-7.5-4.6-7.5-9.4A4.1 4.1 0 0 1 12 8.2a4.1 4.1 0 0 1 7.5 2.4C19.5 15.4 12 20 12 20Z" />
      </svg>
    </button>`;
}

const PLAY_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5-11-6.5Z" /></svg>`;
const CUBE_INNER = `<path d="M3.6 7 12 11.7 20.4 7M12 11.7v9.7" />`;

const GLYPHS = {
  search:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6" /><path d="m15 15 4.5 4.5" /></svg>',
  box: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.6 20.4 7v10L12 21.4 3.6 17V7L12 2.6Z" />${CUBE_INNER}</svg>`,
  user: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8.4" r="3.6" /><path d="M5 20c.7-3.3 3.3-5 7-5s6.3 1.7 7 5" /></svg>',
  globe:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17M12 3.5c2.4 2.3 3.6 5.3 3.6 8.5s-1.2 6.2-3.6 8.5c-2.4-2.3-3.6-5.3-3.6-8.5S9.6 5.8 12 3.5Z" /></svg>',
  warn: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4.5 21 19.6H3L12 4.5Z" /><path d="M12 10.4v3.6M12 16.6v.4" /></svg>',
};

type GlyphName = keyof typeof GLYPHS;

function emptyState(glyph: GlyphName, title: string, text = ""): string {
  return `
    <div class="empty-state">
      <span class="empty-glyph">${GLYPHS[glyph]}</span>
      <strong>${escapeHtml(title)}</strong>
      ${text ? `<p>${escapeHtml(text)}</p>` : ""}
    </div>`;
}

const STAR_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 4.4 2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4L4.2 10.1l5.4-.8L12 4.4Z" /></svg>`;

function tileLabel(id: string): string {
  const base = id.split("-")[0] ?? id;
  const parts = base.split(".");
  const label = parts.length >= 2 ? parts.slice(0, 2).join(".") : base;
  return label.length > 6 ? `${label.slice(0, 6)}…` : label;
}

function instanceRow(entry: VersionEntry): string {
  const kind = versionKind(entry);
  const isSelected = entry.id === selectedVersion;
  const isFav = favorites().includes(`version:${entry.id}`);
  const badge = kind === "release" ? "Release" : "Snapshot";

  return `
    <article class="instance${isSelected ? " is-selected" : ""}" data-open="version:${escapeHtml(
      entry.id
    )}" tabindex="0" role="button" aria-label="${escapeHtml(entry.id)} sürümü">
      <span class="instance-tile thumb-tint-${tintFor(entry.id)}">${escapeHtml(tileLabel(entry.id))}</span>
      <div class="instance-text">
        <div class="instance-title">
          <span>Minecraft ${escapeHtml(entry.id)}</span>
          <span class="badge badge-ghost">${badge}</span>
        </div>
        <div class="instance-sub">${versionDescription(entry)}</div>
      </div>
      <div class="instance-actions">
        <button class="icon-action${isFav ? " is-active" : ""}" type="button"
          data-fav="version:${escapeHtml(entry.id)}" aria-label="Favorilere ekle" aria-pressed="${isFav}">
          ${STAR_ICON}
        </button>
        ${
          isSelected
            ? '<span class="row-check">✓</span>'
            : `<button class="select-btn" type="button" data-select="${escapeHtml(entry.id)}">Seç</button>`
        }
      </div>
    </article>`;
}

function homeVersions(): VersionEntry[] {
  if (!manifest) return [];
  const releases = manifest.versions.filter((entry) => versionKind(entry) === "release");
  const matches = versionQuery
    ? releases.filter((entry) => entry.id.toLowerCase().includes(versionQuery))
    : releases;
  return matches.slice(0, 6);
}

function renderHomeGrid() {
  const grid = $("#home-grid");
  if (!grid || !manifest) return;

  const releases = homeVersions();
  grid.innerHTML = releases.length
    ? releases.map(instanceRow).join("")
    : `<div class="panel grid-span">${emptyState(
        "search",
        "Eşleşen sürüm yok",
        "Kütüphane'deki filtrelere göz at."
      )}</div>`;
}

function renderLibraryGrid() {
  const grid = $("#library-grid");
  const empty = $("#library-empty");
  if (!grid) return;

  const entries = visibleVersions().slice(0, 60);
  grid.innerHTML = entries.map(instanceRow).join("");
  if (empty) empty.hidden = entries.length > 0;
}

/* ==========================================================================
   Favorites
   ========================================================================== */

function favorites(): string[] {
  return readJson<string[]>(FAVORITES_KEY, []);
}

function toggleFavorite(button: HTMLElement) {
  const key = button.dataset.fav;
  if (!key) return;

  const current = favorites();
  const next = current.includes(key) ? current.filter((item) => item !== key) : [...current, key];
  writeJson(FAVORITES_KEY, next);

  const active = next.includes(key);
  button.classList.toggle("is-active", active);
  button.setAttribute("aria-pressed", String(active));
  if (active) {
    button.style.animation = "none";
    void button.offsetWidth;
    button.style.animation = "";
  }
}

/* ==========================================================================
   Detail sheet
   ========================================================================== */

let lastFocused: HTMLElement | null = null;

function openSheet(html: string) {
  const sheet = $("#sheet");
  const scrim = $("#scrim");
  const content = $("#sheet-content");
  if (!sheet || !scrim || !content) return;

  lastFocused = document.activeElement as HTMLElement;
  content.innerHTML = html;
  sheet.hidden = false;
  scrim.hidden = false;

  requestAnimationFrame(() => {
    sheet.classList.add("is-open");
    scrim.classList.add("is-open");
  });

  content.querySelector<HTMLElement>("button")?.focus();

  const move = (event: MouseEvent) => {
    if (!sheet.contains(event.target as Node)) closeSheet();
  };
  scrim.addEventListener("click", move);
}

function closeSheet() {
  const sheet = $("#sheet");
  const scrim = $("#scrim");
  if (!sheet || !scrim || sheet.hidden) return;

  sheet.classList.remove("is-open");
  scrim.classList.remove("is-open");
  sheet.style.transform = "";

  window.setTimeout(() => {
    sheet.hidden = true;
    scrim.hidden = true;
    const content = $("#sheet-content");
    if (content) content.innerHTML = "";
    lastFocused?.focus();
  }, 320);
}

function setupSheetGestures() {
  const sheet = $("#sheet");
  const grabber = $("#sheet-grabber");
  if (!sheet || !grabber) return;

  let startY = 0;
  let deltaY = 0;
  let dragging = false;

  grabber.addEventListener("pointerdown", (event) => {
    if (!window.matchMedia("(max-width: 640px)").matches) return;
    dragging = true;
    startY = event.clientY;
    deltaY = 0;
    sheet.classList.add("is-dragging");
    try {
      grabber.setPointerCapture(event.pointerId);
    } catch {
      /* pointer yakalanamazsa sürükleme yine de çalışır */
    }
  });

  grabber.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    deltaY = Math.max(0, event.clientY - startY);
    sheet.style.transform = `translateY(${deltaY}px)`;
  });

  const release = () => {
    if (!dragging) return;
    dragging = false;
    sheet.classList.remove("is-dragging");
    if (deltaY > 110) {
      closeSheet();
    } else {
      sheet.style.transform = "";
    }
  };

  grabber.addEventListener("pointerup", release);
  grabber.addEventListener("pointercancel", release);
}

function versionSheet(id: string) {
  const entry = manifest?.versions.find((item) => item.id === id);
  const kind = entry ? versionKind(entry) : "release";

  return `
    <div class="sheet-header">
      <span class="sheet-icon thumb-tint-${tintFor(id)}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.6 20.4 7v10L12 21.4 3.6 17V7L12 2.6Z" />${CUBE_INNER}</svg>
      </span>
      <div>
        <h2 class="sheet-title" id="sheet-title">Minecraft ${escapeHtml(id)}</h2>
        <p class="sheet-sub">${entry ? versionDescription(entry) : "Sürüm bilgisi"}</p>
      </div>
    </div>
    <div class="sheet-badges">
      <span class="badge">${kind === "release" ? "Kararlı" : "Deneysel"}</span>
      ${id === manifest?.latest.release ? '<span class="badge badge-ghost">En son sürüm</span>' : ""}
      ${kind === "release" ? '<span class="badge badge-ghost">Java Edition</span>' : ""}
    </div>
    <p class="sheet-copy">
      Bu sürümü seçtiğinde başlatıcı oyun dosyalarını resmî Mojang sunucularından indirir
      ve profilini bu sürümle açar.
    </p>
    <div class="sheet-facts">
      <div><span>Sürüm</span><strong>${escapeHtml(id)}</strong></div>
      <div><span>Kanal</span><strong>${kind === "release" ? "Release" : "Snapshot"}</strong></div>
      <div><span>Yayınlanma</span><strong>${formatDate(entry?.releaseTime)}</strong></div>
      <div><span>Hesap</span><strong>${escapeHtml(selectedAccount() ?? "Player")}</strong></div>
    </div>
    <div class="sheet-actions">
      <button class="btn btn-secondary" type="button" data-select="${escapeHtml(id)}">Bu sürümü seç</button>
      <button class="btn btn-primary" type="button" data-play="${escapeHtml(id)}">${PLAY_ICON}Başlat</button>
    </div>`;
}

/* ==========================================================================
   External links
   ========================================================================== */

async function openExternal(url: string) {
  try {
    if (inTauri()) {
      await openUrl(url);
      return;
    }
  } catch (error) {
    console.error("openUrl:", error);
  }
  window.open(url, "_blank", "noopener");
}

/* ==========================================================================
   Featured rail
   ========================================================================== */

const FALLBACK_FEATURED: FeaturedItem[] = [
  {
    id: "fabulously-optimized",
    title: "Fabulously Optimized",
    description: "FPS'i artıran, vanilla hissini koruyan hafif performans paketi.",
    downloads: 12_400_000,
    url: "https://modrinth.com/modpack/fabulously-optimized",
    tint: 1,
  },
  {
    id: "adrenaline",
    title: "Adrenaline",
    description: "Düşük donanımda akıcı oyun için sade optimizasyon koleksiyonu.",
    downloads: 3_100_000,
    url: "https://modrinth.com/modpack/adrenaline",
    tint: 2,
  },
  {
    id: "better-mc-forge-bmc4",
    title: "Better MC",
    description: "Yeni biyomlar, yapılar ve mob'lar ile zenginleştirilmiş macera paketi.",
    downloads: 9_800_000,
    url: "https://modrinth.com/modpack/better-mc-forge-bmc4",
    tint: 4,
  },
  {
    id: "cobblemon",
    title: "Cobblemon",
    description: "Minecraft dünyasında yaratık toplama ve dövüş deneyimi.",
    downloads: 6_700_000,
    url: "https://modrinth.com/modpack/cobblemon",
    tint: 3,
  },
  {
    id: "prominence",
    title: "Prominence II",
    description: "RPG ilerleme sistemi, zindanlar ve detaylı dünya üretimi.",
    downloads: 4_200_000,
    url: "https://modrinth.com/modpack/prominence-2-rpg",
    tint: 5,
  },
  {
    id: "simply-optimized",
    title: "Simply Optimized",
    description: "Saf performans odaklı, görsel değişiklik içermeyen paket.",
    downloads: 2_450_000,
    url: "https://modrinth.com/modpack/sop",
    tint: 6,
  },
];

const featuredIndex = new Map<string, FeaturedItem>();

function featuredCard(item: FeaturedItem): string {
  featuredIndex.set(item.id, item);
  return `
    <article class="card" data-open="featured:${escapeHtml(item.id)}" tabindex="0" role="button"
      aria-label="${escapeHtml(item.title)}">
      ${favoriteButton(`featured:${item.id}`)}
      <div class="thumb thumb-tint-${item.tint}">
        ${
          item.iconUrl
            ? `<span class="thumb-app"><img src="${escapeHtml(
                item.iconUrl
              )}" alt="" loading="lazy" /></span>`
            : `<svg class="thumb-glyph" viewBox="0 0 24 24" aria-hidden="true">
                 <path d="M12 2.6 20.4 7v10L12 21.4 3.6 17V7L12 2.6Z" />${CUBE_INNER}
               </svg>`
        }
        <span class="badge badge-neutral thumb-badge">Mod Paketi</span>
      </div>
      <div class="card-body">
        <div class="card-title">${escapeHtml(item.title)}</div>
        <p class="card-desc">${escapeHtml(item.description)}</p>
      </div>
      <div class="card-footer">
        <span class="card-meta">${
          item.downloads ? `${formatCount(item.downloads)} indirme` : "Topluluk seçkisi"
        }</span>
        <svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9.5 6l6 6-6 6" /></svg>
      </div>
    </article>`;
}

async function loadFeatured() {
  const rail = $("#featured-rail");
  if (!rail) return;

  let items: FeaturedItem[] = FALLBACK_FEATURED;

  try {
    const response = await fetch(
      `https://api.modrinth.com/v2/search?limit=8&index=downloads&facets=${encodeURIComponent(
        '[["project_type:modpack"]]'
      )}`
    );
    if (response.ok) {
      const data = (await response.json()) as { hits: ModrinthHit[] };
      if (data.hits?.length) {
        items = data.hits.slice(0, 8).map((hit, index) => ({
          id: hit.project_id,
          title: hit.title,
          description: hit.description,
          downloads: hit.downloads,
          iconUrl: hit.icon_url,
          url: `https://modrinth.com/modpack/${hit.slug}`,
          tint: tintFor(hit.project_id + index),
        }));
      }
    }
  } catch {
    /* çevrimdışı: yerel seçkiyi kullan */
  }

  rail.innerHTML = items.map(featuredCard).join("");
}

function featuredSheet(id: string) {
  const item = featuredIndex.get(id);
  if (!item) return "";

  return `
    <div class="sheet-header">
      <span class="sheet-icon thumb-tint-${item.tint}">
        ${
          item.iconUrl
            ? `<img src="${escapeHtml(item.iconUrl)}" alt="" />`
            : `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.6 20.4 7v10L12 21.4 3.6 17V7L12 2.6Z" /></svg>`
        }
      </span>
      <div>
        <h2 class="sheet-title" id="sheet-title">${escapeHtml(item.title)}</h2>
        <p class="sheet-sub">Mod paketi</p>
      </div>
    </div>
    <div class="sheet-badges">
      <span class="badge">Mod Paketi</span>
      <span class="badge badge-ghost">Modrinth</span>
    </div>
    <p class="sheet-copy">${escapeHtml(item.description)}</p>
    <div class="sheet-facts">
      <div><span>İndirme</span><strong>${item.downloads ? formatCount(item.downloads) : "—"}</strong></div>
      <div><span>Kaynak</span><strong>Modrinth</strong></div>
    </div>
    <div class="sheet-actions">
      <button class="btn btn-secondary" type="button" data-close-sheet="true">Kapat</button>
      <button class="btn btn-primary" type="button" data-open-url="${escapeHtml(item.url ?? "")}">
        Modrinth'te aç
      </button>
    </div>`;
}

/* ==========================================================================
   Downloads (indirme çubuğu)
   ========================================================================== */

type DownloadPhase = "active" | "done" | "error";

interface DownloadRow {
  id: string;
  label: string;
  status: string;
  ratio: number;
  phase: DownloadPhase;
}

const downloadRows = new Map<string, DownloadRow>();
const downloadTimers = new Map<string, number>();

function renderDownloads() {
  const strip = $("#downloads");
  const list = $("#downloads-list");
  if (!strip || !list) return;

  if (!downloadRows.size) {
    strip.hidden = true;
    list.innerHTML = "";
    return;
  }

  strip.hidden = false;
  list.innerHTML = Array.from(downloadRows.values())
    .map((row) => {
      const percent = Math.round(row.ratio * 100);
      const modifier =
        row.phase === "done" ? " is-done" : row.phase === "error" ? " is-error" : "";
      return `
      <div class="download-row${modifier}">
        <div class="download-text">
          <span class="download-name">${escapeHtml(row.label)}</span>
          <span class="download-status">${escapeHtml(row.status)}</span>
        </div>
        <span class="download-pct">${percent}%</span>
        <div class="progress"><span style="width:${percent}%"></span></div>
      </div>`;
    })
    .join("");
}

function addDownload(id: string, label: string, status = "Başlıyor…") {
  downloadRows.set(id, { id, label, status, ratio: 0, phase: "active" });
  renderDownloads();
}

function updateDownload(
  id: string,
  patch: Partial<Pick<DownloadRow, "status" | "ratio" | "phase">>
) {
  const row = downloadRows.get(id);
  if (!row) return;
  Object.assign(row, patch);
  renderDownloads();
}

function finishDownload(id: string, phase: DownloadPhase = "done") {
  const row = downloadRows.get(id);
  if (!row) return;

  row.phase = phase;
  row.ratio = phase === "error" ? row.ratio : 1;
  row.status = phase === "error" ? row.status : "Tamamlandı";
  renderDownloads();

  window.clearTimeout(downloadTimers.get(id));
  downloadTimers.set(
    id,
    window.setTimeout(() => {
      downloadRows.delete(id);
      downloadTimers.delete(id);
      renderDownloads();
    }, 3800)
  );
}

/* ==========================================================================
   Launch state (başlat / durdur)
   ========================================================================== */

type LaunchState = "idle" | "starting" | "running";

let launchState: LaunchState = "idle";

const LAUNCH_ICONS: Record<LaunchState, string> = {
  idle: '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5-11-6.5Z" /></svg>',
  starting: '<svg viewBox="0 0 24 24"><path d="M12 4.2a7.8 7.8 0 1 0 7.8 7.8" /></svg>',
  running: '<svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="2.4" /></svg>',
};

function setLaunchState(state: LaunchState) {
  launchState = state;
  launching = state === "starting";
  syncLaunchButton();
}

/* ==========================================================================
   Mods
   ========================================================================== */

const modIndex = new Map<string, ModrinthHit>();

type ModCategory = "mod" | "shader" | "resourcepack";

const MOD_CATEGORIES: Record<
  ModCategory,
  {
    singular: string;
    plural: string;
    popular: string;
    installed: string;
    emptyInstalled: string;
    emptyResults: string;
  }
> = {
  mod: {
    singular: "Mod",
    plural: "mod",
    popular: "En çok indirilen modlar",
    installed: "İndirilen modlar",
    emptyInstalled: "Henüz mod yok",
    emptyResults: "Mod bulunamadı",
  },
  shader: {
    singular: "Shader",
    plural: "shader",
    popular: "En çok indirilen shaderlar",
    installed: "İndirilen shaderlar",
    emptyInstalled: "Henüz shader yok",
    emptyResults: "Shader bulunamadı",
  },
  resourcepack: {
    singular: "Doku paketi",
    plural: "doku paketi",
    popular: "En çok indirilen doku paketleri",
    installed: "İndirilen doku paketleri",
    emptyInstalled: "Henüz doku paketi yok",
    emptyResults: "Doku paketi bulunamadı",
  },
};

let modCategory: ModCategory = "mod";
let modsSearchQuery = "";
let modsPage = 1;

/** Bir bölümde (sayfada) gösterilen eklenti sayısı. */
const MODS_PAGE_SIZE = 20;
/** Modrinth offset sayfalamasının üst sınırı. */
const MODS_MAX_PAGES = 25;

/** Seçili örnek için Modrinth yükleyici adı. */
const MODRINTH_LOADERS: Record<LoaderKind, string> = {
  vanilla: "fabric",
  fabric: "fabric",
  quilt: "quilt",
  forge: "forge",
};

function targetLoader(): string {
  return MODRINTH_LOADERS[currentInstance().loader] ?? "fabric";
}

/** Listelenen eklentilerin hangi sürüm/yükleyici için olduğunu anlatan etiket. */
function compatibilityLabel(): string {
  const loader = LOADER_LABELS[currentInstance().loader] ?? "Fabric";
  return `${LOCKED_VERSION} · ${loader}`;
}

interface ModrinthProject {
  id: string;
  slug: string;
  title: string;
  description: string;
  downloads: number;
  icon_url: string | null;
  project_type?: string;
}

/**
 * Kurulu projeler: proje kimliği -> (dosya adı + kategori).
 * Dosya adı saklandığı için mod silindiğinde kayıt da düşürülebilir.
 */
interface InstalledProjectRecord {
  file: string;
  kind: ModCategory;
}

type InstalledProjectMap = Record<string, InstalledProjectRecord>;

function installedProjectMap(): InstalledProjectMap {
  const stored = readJson<InstalledProjectMap | string[]>(INSTALLED_PROJECTS_KEY, {});
  // Eski sürüm yalnızca kimlik dizisi saklıyordu; dosya adı bilinmediği için korunur.
  if (Array.isArray(stored)) {
    return Object.fromEntries(stored.map((id) => [id, { file: "", kind: "mod" as ModCategory }]));
  }
  return stored ?? {};
}

function writeInstalledProjectMap(map: InstalledProjectMap): void {
  writeJson(INSTALLED_PROJECTS_KEY, map);
}

function installedProjects(): Set<string> {
  return new Set(Object.keys(installedProjectMap()));
}

function markProjectInstalled(id: string, file: string, kind: ModCategory = modCategory): void {
  const map = installedProjectMap();
  map[id] = { file, kind };
  writeInstalledProjectMap(map);
}

/** Silinen dosyanın kaydını düşürür; böylece kart tekrar "Kur" olur. */
function unmarkProjectByFile(fileName: string): void {
  const map = installedProjectMap();
  let changed = false;
  Object.keys(map).forEach((id) => {
    if (map[id].kind === modCategory && map[id].file === fileName) {
      delete map[id];
      changed = true;
    }
  });
  if (changed) writeInstalledProjectMap(map);
}

/** Proje kimliğine göre kaydı düşürür (dosya adı bilinmese de çalışır). */
function unmarkProjectById(id: string): void {
  const map = installedProjectMap();
  if (!(id in map)) return;
  delete map[id];
  writeInstalledProjectMap(map);
}

/**
 * Kayıtları gerçek dosya listesiyle eşitler: silinmiş dosyalar "kurulu" sayılmaz.
 * Yalnızca liste gerçekten okunabildiğinde çağrılmalıdır, aksi hâlde tüm kayıt düşer.
 */
function reconcileInstalledProjects(files: InstalledMod[]): void {
  const names = new Set(files.map((mod) => mod.file_name));
  const map = installedProjectMap();
  const next: InstalledProjectMap = {};
  let changed = false;

  Object.entries(map).forEach(([id, record]) => {
    if (record.kind !== modCategory) {
      next[id] = record;
      return;
    }
    // Dosya adı bilinmeyen eski kayıtlar doğrulanamaz; yeni biçime geçilirken düşürülür.
    if (!record.file || !names.has(record.file)) {
      changed = true;
      return;
    }
    next[id] = record;
  });

  if (changed) writeInstalledProjectMap(next);
}

/** Kurulu bir eklentinin yanında görünen "Kaldır" düğmesinin işaretlemesi. */
function modRemoveButton(projectId: string, title: string): string {
  return `<button class="btn-remove" type="button" data-mod-remove="${escapeHtml(
    projectId
  )}" aria-label="${escapeHtml(title)} kaldır">Kaldır</button>`;
}

/** "Kur/Kurulu" düğmesinin bulunduğu eylem satırı (kart ya da detay paneli). */
function modActionHost(button: HTMLButtonElement): HTMLElement | null {
  return button.closest<HTMLElement>(".mod-actions, .sheet-actions");
}

/**
 * Düğme etiketini bozmadan (span varsa onu koruyarak) durumunu günceller ve
 * kurulum varsa yanında "Kaldır" düğmesini gösterir, yoksa kaldırır.
 */
function setModButtonState(button: HTMLButtonElement, isInstalled: boolean): void {
  const text = isInstalled ? "Kurulu" : "Kur";
  const label = button.querySelector("span");
  if (label) label.textContent = text;
  else button.textContent = text;
  button.disabled = isInstalled;
  button.classList.toggle("is-installed", isInstalled);

  const projectId = button.dataset.modDownload;
  const host = modActionHost(button);
  if (!projectId || !host) return;

  const existing = host.querySelector<HTMLButtonElement>(
    `[data-mod-remove="${projectId}"]`
  );
  if (!isInstalled) {
    existing?.remove();
    return;
  }
  if (existing) return;

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "btn-remove";
  remove.dataset.modRemove = projectId;
  remove.textContent = "Kaldır";
  const hit = modIndex.get(projectId);
  remove.setAttribute("aria-label", hit ? `${hit.title} kaldır` : "Eklentiyi kaldır");
  button.insertAdjacentElement("afterend", remove);
}

/** Görünürdeki tüm "Kur/Kurulu" düğmelerini kayıtlarla eşitler. */
function syncModButtons(): void {
  const installed = installedProjects();
  $$<HTMLButtonElement>("[data-mod-download]").forEach((button) => {
    const id = button.dataset.modDownload;
    setModButtonState(button, Boolean(id && installed.has(id)));
  });
}

function markModInstalled(button: HTMLButtonElement, projectId: string, file = ""): void {
  markProjectInstalled(projectId, file);
  setModButtonState(button, true);
}

function modLink(slug: string): string {
  const kind =
    modCategory === "shader" ? "shader" : modCategory === "resourcepack" ? "resourcepack" : "mod";
  return `https://modrinth.com/${kind}/${slug}`;
}

function modIcon(hit: { icon_url: string | null; title: string }): string {
  if (hit.icon_url) {
    return `<span class="mod-icon"><img src="${escapeHtml(hit.icon_url)}" alt="" loading="lazy" /></span>`;
  }
  return `<span class="mod-icon">${escapeHtml(hit.title.charAt(0).toUpperCase())}</span>`;
}

function modCard(hit: ModrinthHit, installed: boolean): string {
  modIndex.set(hit.project_id, hit);
  const id = escapeHtml(hit.project_id);
  const title = escapeHtml(hit.title);
  return `
    <article class="mod-card" data-open="mod:${id}" tabindex="0" role="button"
      aria-label="${title}">
      ${modIcon(hit)}
      <div class="mod-body">
        <div class="mod-top">
          <span class="mod-title">${title}</span>
          <span class="mod-dl">${formatCount(hit.downloads)}</span>
        </div>
        <p class="mod-desc">${escapeHtml(hit.description)}</p>
        <div class="mod-foot">
          <div class="mod-actions">
            <button class="btn-mod${installed ? " is-installed" : ""}" type="button"
              data-mod-download="${id}"${installed ? " disabled" : ""}>${
                installed ? "Kurulu" : "Kur"
              }</button>
            ${installed ? modRemoveButton(hit.project_id, hit.title) : ""}
          </div>
          <button class="mod-link" type="button" data-open-url="${escapeHtml(modLink(hit.slug))}">
            Modrinth
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 5h5v5M19 5l-8 8M11 5H5.5A1.5 1.5 0 0 0 4 6.5v12A1.5 1.5 0 0 0 5.5 20h12a1.5 1.5 0 0 0 1.5-1.5V13" /></svg>
          </button>
        </div>
      </div>
    </article>`;
}

function modSection(title: string, sub: string, hits: ModrinthHit[]): string {
  if (!hits.length) return "";
  const installed = installedProjects();
  return `
    <section class="mod-section">
      <div class="mod-section-head">
        <div>
          <h2>${escapeHtml(title)}</h2>
          ${sub ? `<p>${escapeHtml(sub)}</p>` : ""}
        </div>
      </div>
      <div class="mod-cards">${hits
        .map((hit) => modCard(hit, installed.has(hit.project_id)))
        .join("")}</div>
    </section>`;
}

interface ModrinthSearchResult {
  hits: ModrinthHit[];
  total: number;
}

async function modrinthSearch(
  query: string,
  withVersion: boolean,
  page = 1
): Promise<ModrinthSearchResult> {
  const facets: string[][] = [[`project_type:${modCategory}`]];
  // Modlarda yalnızca seçili yükleyiciyle çalışan projeleri listele.
  if (modCategory === "mod") facets.push([`categories:${targetLoader()}`]);

  const params = new URLSearchParams({
    limit: String(MODS_PAGE_SIZE),
    offset: String((Math.max(1, page) - 1) * MODS_PAGE_SIZE),
    index: "downloads",
    facets: JSON.stringify(facets),
  });
  if (withVersion) params.set("versions", JSON.stringify([LOCKED_VERSION]));
  if (query) params.set("query", query);

  const response = await fetch(`https://api.modrinth.com/v2/search?${params.toString()}`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = (await response.json()) as { hits?: ModrinthHit[]; total_hits?: number };
  const hits = data.hits ?? [];
  return { hits, total: data.total_hits ?? hits.length };
}

async function trendingMods(page: number): Promise<ModrinthSearchResult> {
  try {
    const result = await modrinthSearch("", true, page);
    if (result.hits.length) return result;
  } catch {
    /* sürüm filtresi sonuç vermediyse filtresiz dene */
  }
  return modrinthSearch("", false, page);
}

/* ---------------------------- bölüm (sayfa) çubuğu ----------------------- */

function modPageCount(total: number): number {
  return Math.max(1, Math.min(Math.ceil(total / MODS_PAGE_SIZE), MODS_MAX_PAGES));
}

function pagerNumbers(page: number, pages: number): Array<number | "gap"> {
  if (pages <= 7) return Array.from({ length: pages }, (_, index) => index + 1);

  const items: Array<number | "gap"> = [1];
  const from = Math.max(2, page - 1);
  const to = Math.min(pages - 1, page + 1);
  if (from > 2) items.push("gap");
  for (let number = from; number <= to; number += 1) items.push(number);
  if (to < pages - 1) items.push("gap");
  items.push(pages);
  return items;
}

function modPager(page: number, total: number): string {
  const pages = modPageCount(total);
  if (pages <= 1) return "";

  const numbers = pagerNumbers(page, pages)
    .map((item) =>
      item === "gap"
        ? '<span class="pager-gap">…</span>'
        : `<button type="button" data-mods-page="${item}"${
            item === page ? ' class="is-active" aria-current="page"' : ""
          }>${item}. Bölüm</button>`
    )
    .join("");

  return `
    <nav class="mod-pager" aria-label="Mod listesi bölümleri">
      <button type="button" data-mods-page="${page - 1}"${page <= 1 ? " disabled" : ""}>
        ‹ Önceki
      </button>
      ${numbers}
      <button type="button" data-mods-page="${page + 1}"${page >= pages ? " disabled" : ""}>
        Sonraki ›
      </button>
    </nav>`;
}

/** Launcher ile test edilmiş seçki (Modrinth slug'ları). */
const RECOMMENDED_SLUGS = ["iris", "sodium", "tooltip-scroll"];

async function recommendedMods(): Promise<ModrinthHit[]> {
  const ids = encodeURIComponent(JSON.stringify(RECOMMENDED_SLUGS));
  const response = await fetch(`https://api.modrinth.com/v2/projects?ids=${ids}`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const projects = (await response.json()) as ModrinthProject[];
  return projects.map((project) => ({
    project_id: project.id,
    slug: project.slug,
    title: project.title,
    description: project.description,
    downloads: project.downloads,
    icon_url: project.icon_url,
    project_type: project.project_type,
  }));
}

async function searchMods(query: string, page = 1) {
  const container = $("#mods-results");
  if (!container) return;

  modsSearchQuery = query.trim();
  modsPage = Math.max(1, page);
  const label = MOD_CATEGORIES[modCategory];

  container.innerHTML = `
    <section class="mod-section">
      <div class="mod-section-head"><div><h2>${
        modsSearchQuery ? "Aranıyor…" : "Yükleniyor…"
      }</h2></div></div>
      <div class="mod-cards">
        <div class="mod-skeleton"></div><div class="mod-skeleton"></div>
        <div class="mod-skeleton"></div><div class="mod-skeleton"></div>
      </div>
    </section>`;

  try {
    modIndex.clear();

    if (modsSearchQuery) {
      let result = await modrinthSearch(modsSearchQuery, true, modsPage);
      let unfiltered = false;
      // Yalnız ilk bölümde: sürüm filtresi hiç sonuç vermezse filtresiz göster.
      if (!result.hits.length && modsPage === 1) {
        result = await modrinthSearch(modsSearchQuery, false, 1);
        unfiltered = true;
      }

      container.innerHTML = result.hits.length
        ? modSection(
            `“${modsSearchQuery}” için sonuçlar`,
            unfiltered
              ? `${compatibilityLabel()} için sonuç yok; tüm sürümler gösteriliyor.`
              : `Uyumlu sürüm: ${compatibilityLabel()}`,
            result.hits
          ) + modPager(modsPage, result.total)
        : emptyState("search", label.emptyResults, "Başka bir anahtar kelime dene.");
      return;
    }

    // Bölüm gezintisi: sadece ilk bölümde "Önerilen" vitrini gösterilir.
    const [recommended, popular] = await Promise.all([
      modsPage === 1 ? recommendedMods().catch(() => [] as ModrinthHit[]) : Promise.resolve([] as ModrinthHit[]),
      trendingMods(modsPage),
    ]);

    const html =
      modSection("Önerilen", "Launcher ile test edilmiş, isteğe bağlı eklentiler.", recommended) +
      modSection(`${label.popular} · ${modsPage}. bölüm`, `Uyumlu sürüm: ${compatibilityLabel()}`, popular.hits) +
      modPager(modsPage, popular.total);

    container.innerHTML = html || emptyState("search", label.emptyResults, "Modrinth'e ulaşılamadı.");
  } catch (error) {
    console.error(error);
    container.innerHTML = emptyState("warn", "Arama başarısız", String(error));
  }
}

interface ModrinthVersion {
  version_number: string;
  version_type: string;
  date_published: string;
  loaders: string[];
  game_versions: string[];
  files: Array<{ url: string; filename: string; primary: boolean }>;
}

/**
 * 1.21.11 + seçili yükleyici için **en yeni release** sürümü seçer.
 * Release yoksa en yeni beta, o da yoksa en yeni alpha kullanılır; böylece
 * alpha/beta sürümleri normal durumda hiç indirilmez.
 */
async function pickModVersion(projectId: string): Promise<ModrinthVersion> {
  const params = new URLSearchParams({ game_versions: JSON.stringify([LOCKED_VERSION]) });
  if (modCategory === "mod") params.set("loaders", JSON.stringify([targetLoader()]));

  const response = await fetch(
    `https://api.modrinth.com/v2/project/${projectId}/version?${params.toString()}`
  );
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const versions = (await response.json()) as ModrinthVersion[];
  if (!versions.length) {
    throw new Error(`${LOCKED_VERSION} · ${targetLoader()} için uyumlu sürüm yok`);
  }

  const ranked = [...versions].sort(
    (a, b) => Date.parse(b.date_published) - Date.parse(a.date_published)
  );
  return (
    ranked.find((entry) => entry.version_type === "release") ??
    ranked.find((entry) => entry.version_type === "beta") ??
    ranked[0]
  );
}

async function downloadMod(projectId: string, button: HTMLButtonElement) {
  const hit = modIndex.get(projectId);
  if (!hit) return;

  const label = button.querySelector("span") ?? button;
  const original = label.textContent;
  const downloadId = `mod-${projectId}-${Date.now()}`;

  button.disabled = true;
  label.textContent = "İndiriliyor…";
  addDownload(downloadId, hit.title);

  // Tarayıcı önizlemesinde gerçek indirme yok; çubuğu yine de göster.
  if (!inTauri()) {
    let step = 0;
    const simulate = window.setInterval(() => {
      step += 1;
      updateDownload(downloadId, {
        status: step < 6 ? "İndiriliyor…" : "Doğrulanıyor…",
        ratio: Math.min(1, step / 7),
      });
      if (step < 7) return;

      window.clearInterval(simulate);
      finishDownload(downloadId);
      toast(`${hit.title} indirildi (önizleme)`);
      markModInstalled(button, projectId);
    }, 380);
    return;
  }

  let progressPoll = 0;

  try {
    const version = await pickModVersion(projectId);
    const file = version.files.find((item) => item.primary) ?? version.files[0];
    if (!file) throw new Error(`${LOCKED_VERSION} için indirilebilir dosya yok`);
    const stable = version.version_type === "release";

    // Rust tarafı indirmeyi parça parça yapar ve ilerlemeyi bildirir.
    progressPoll = window.setInterval(() => {
      void (async () => {
        try {
          const data = await invoke<{
            status: string;
            current: number;
            total: number;
          } | null>("download_progress", { id: downloadId });
          if (!data) return;
          updateDownload(downloadId, {
            status: data.status,
            ratio: data.total > 0 ? data.current / data.total : 0,
          });
        } catch {
          /* indirme kaydı yoksa yok say */
        }
      })();
    }, 400);

    await invoke<InstalledMod>("download_mod", {
      id: downloadId,
      url: file.url,
      fileName: file.filename,
      kind: modCategory,
      instance: currentInstance().id,
    });

    finishDownload(downloadId);
    toast(
      stable
        ? `${hit.title} indirildi (${version.version_number})`
        : `${hit.title} indirildi · dikkat: ${version.version_type} sürümü`
    );
    markModInstalled(button, projectId, file.filename);
    await renderInstalledMods();
  } catch (error) {
    console.error(error);
    label.textContent = "Tekrar dene";
    finishDownload(downloadId, "error");
    toast(`İndirme başarısız: ${String(error)}`);
    window.setTimeout(() => {
      label.textContent = original ?? "İndir";
      button.disabled = false;
    }, 2200);
  } finally {
    window.clearInterval(progressPoll);
  }
}

async function renderInstalledMods() {
  const list = $("#mods-installed");
  const count = $("#mods-count");
  const title = $("#mods-installed-title");
  if (!list) return;

  const label = MOD_CATEGORIES[modCategory];
  if (title) title.textContent = label.installed;

  const instance = currentInstance();
  const eyebrow = $("#mods-installed-eyebrow");
  if (eyebrow) eyebrow.textContent = `YEREL · ${instance.name}`;

  let mods: InstalledMod[] = [];
  let listed = false;
  try {
    if (inTauri()) {
      mods = await invoke<InstalledMod[]>("list_mods", {
        kind: modCategory,
        instance: instance.id,
      });
      listed = true;
    }
  } catch (error) {
    console.error("list_mods:", error);
  }

  // Liste gerçekten okunabildiyse kayıtları diskle eşitle; "Kurulu" takılı kalmasın.
  if (listed) {
    reconcileInstalledProjects(mods);
    syncModButtons();
  }

  if (count) count.textContent = String(mods.length);
  if (modCategory === "mod") {
    const statMods = $("#stat-mods");
    if (statMods) statMods.textContent = String(mods.length);
  }

  if (!mods.length) {
    list.innerHTML = emptyState(
      "box",
      label.emptyInstalled,
      `Soldan ${label.plural} indirerek başla.`
    );
    return;
  }

  list.innerHTML = mods
    .map(
      (mod) => `
      <article class="mod-card">
        <span class="mod-icon">${escapeHtml(mod.file_name.charAt(0).toUpperCase())}</span>
        <div class="mod-body">
          <div class="mod-top">
            <span class="mod-title">${escapeHtml(mod.file_name)}</span>
            <span class="mod-dl">${formatBytes(mod.size_bytes)}</span>
          </div>
          <div class="mod-foot">
            <span class="badge badge-ghost">Kurulu</span>
            <button class="icon-action danger" type="button" data-mod-delete="${escapeHtml(
              mod.file_name
            )}" aria-label="Eklentiyi sil">
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
            </button>
          </div>
        </div>
      </article>`
    )
    .join("");
}

async function deleteMod(fileName: string) {
  try {
    await invoke("delete_mod", {
      fileName,
      kind: modCategory,
      instance: currentInstance().id,
    });
    // Kaydı düşür ki aynı eklenti yeniden kurulabilsin.
    unmarkProjectByFile(fileName);
    syncModButtons();
    await renderInstalledMods();
    toast(`${MOD_CATEGORIES[modCategory].singular} silindi: ${fileName}`);
  } catch (error) {
    toast(`Silme başarısız: ${String(error)}`);
  }
}

/**
 * Keşfet listesindeki "Kaldır" düğmesi: kurulu kaydın dosyasını diskten siler,
 * kaydı düşürür ve kartı yeniden "Kur" durumuna getirir.
 */
async function removeInstalledProject(
  projectId: string,
  button?: HTMLButtonElement
): Promise<void> {
  const name = modIndex.get(projectId)?.title ?? projectId;
  const label = button?.querySelector("span") ?? button;
  const original = label?.textContent ?? "Kaldır";

  if (button) button.disabled = true;
  if (label) label.textContent = "Kaldırılıyor…";

  const fileName = installedProjectMap()[projectId]?.file ?? "";

  try {
    // Dosya adı biliniyorsa dosya gerçekten silinir; bilinmiyorsa (önizleme)
    // yalnızca kayıt düşürülür, kart yine "Kur" durumuna döner.
    if (fileName && inTauri()) {
      await invoke("delete_mod", {
        fileName,
        kind: modCategory,
        instance: currentInstance().id,
      });
      unmarkProjectByFile(fileName);
    }
    unmarkProjectById(projectId);
    syncModButtons();
    await renderInstalledMods();
    toast(`${name} kaldırıldı`);
  } catch (error) {
    if (button) button.disabled = false;
    if (label) label.textContent = original;
    toast(`Kaldırma başarısız: ${String(error)}`);
  }
}

function setupModCategories() {
  const container = $("#mod-categories");
  const thumb = $("#mods-thumb");

  $$<HTMLButtonElement>(".segment[data-category]").forEach((button) => {
    button.addEventListener("click", () => {
      modCategory = (button.dataset.category as ModCategory) ?? "mod";
      $$(".segment[data-category]").forEach((item) => item.classList.remove("is-active"));
      button.classList.add("is-active");
      if (container && thumb) placeThumb(container, thumb, button, 3, 0);

      const search = $<HTMLInputElement>("#mods-search");
      if (search) search.value = "";
      modsSearchQuery = "";

      void renderInstalledMods();
      void searchMods("");
    });
  });
}

/* ==========================================================================
   Servers
   ========================================================================== */

const FEATURED_SERVERS: Array<{ name: string; address: string; note: string }> = [
  { name: "Hypixel", address: "mc.hypixel.net", note: "Mini oyun ağı" },
  { name: "CubeCraft", address: "play.cubecraft.net", note: "Mini oyunlar ve parkur" },
  { name: "Wynncraft", address: "play.wynncraft.com", note: "MMORPG deneyimi" },
  { name: "The Hive", address: "play.hivebedrock.network", note: "Bedrock uyumlu ağ" },
  { name: "Purple Prison", address: "purpleprison.net", note: "OP Prison sunucusu" },
  { name: "DonutSMP", address: "play.donutsmp.net", note: "Ekonomi ve PvP" },
];

function savedServers(): ServerEntry[] {
  return readJson<ServerEntry[]>(SERVERS_KEY, []);
}

function serverCard(entry: ServerEntry, index: number, online: boolean): string {
  return `
    <article class="card" data-open="server:${index}" tabindex="0" role="button"
      aria-label="${escapeHtml(entry.name)}">
      ${favoriteButton(`server:${escapeHtml(entry.address)}`)}
      <div class="thumb thumb-tint-${tintFor(entry.address)}">
        <svg class="thumb-glyph" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="8.5" />
          <path d="M3.5 12h17M12 3.5c2.4 2.3 3.6 5.3 3.6 8.5s-1.2 6.2-3.6 8.5c-2.4-2.3-3.6-5.3-3.6-8.5S9.6 5.8 12 3.5Z" />
        </svg>
        <span class="badge badge-neutral thumb-badge">${online ? "Çevrimiçi" : "Kayıtlı"}</span>
      </div>
      <div class="card-body">
        <div class="card-title">${escapeHtml(entry.name)}</div>
        <p class="card-desc">${escapeHtml(entry.address)}</p>
      </div>
      <div class="card-footer">
        <span class="badge badge-ghost">${online ? "Popüler" : "Yerel"}</span>
        <button class="play-btn" type="button" data-server-join="${escapeHtml(entry.name)}">
          ${PLAY_ICON}Katıl
        </button>
      </div>
    </article>`;
}

let serverView: ServerEntry[] = [];
let serverQuery = "";

function matchesServer(entry: { name: string; address: string }): boolean {
  if (!serverQuery) return true;
  return `${entry.name} ${entry.address}`.toLowerCase().includes(serverQuery);
}

function renderServers() {
  const grid = $("#servers-grid");
  const popular = $("#featured-servers");
  const count = $("#servers-count");

  const servers = savedServers();
  serverView = [...servers, ...FEATURED_SERVERS.map((item) => ({ ...item, createdAt: "" }))];

  const visible = servers.filter(matchesServer);
  const popularVisible = FEATURED_SERVERS.filter(matchesServer);

  if (count) count.textContent = String(servers.length);
  const statServers = $("#stat-servers");
  if (statServers) statServers.textContent = String(servers.length);

  if (grid) {
    grid.innerHTML = visible.length
      ? visible.map((entry, index) => serverCard(entry, index, false)).join("")
      : `<div class="panel grid-span">${emptyState(
          "globe",
          servers.length ? "Eşleşen sunucu yok" : "Kayıtlı sunucu yok",
          servers.length ? "Aramayı temizlemeyi dene." : "Yukarıdan bir sunucu ekle."
        )}</div>`;
  }

  if (popular) {
    popular.innerHTML = popularVisible.length
      ? popularVisible
          .map((entry, index) => serverCard({ ...entry, createdAt: "" }, servers.length + index, true))
          .join("")
      : `<div class="panel grid-span">${emptyState("search", "Eşleşen sunucu yok")}</div>`;
  }
}

function addServer() {
  const nameInput = $<HTMLInputElement>("#server-name");
  const addressInput = $<HTMLInputElement>("#server-address");
  if (!nameInput || !addressInput) return;

  const name = nameInput.value.trim();
  const address = addressInput.value.trim();

  if (!name || !address) {
    toast("Sunucu adı ve adresi gerekli");
    (name ? addressInput : nameInput).focus();
    return;
  }

  if (/\s/.test(address) || !/[.:]/.test(address)) {
    toast("Geçerli bir adres gir (örn. mc.hypixel.net)");
    addressInput.focus();
    return;
  }

  const servers = savedServers();
  if (servers.some((entry) => entry.address.toLowerCase() === address.toLowerCase())) {
    toast("Bu sunucu zaten kayıtlı");
    return;
  }

  servers.push({ name, address, createdAt: new Date().toISOString() });
  writeJson(SERVERS_KEY, servers);
  nameInput.value = "";
  addressInput.value = "";
  renderServers();
  toast(`Sunucu eklendi: ${name}`);
}

function serverSheet(index: number) {
  const entry = serverView[index];
  if (!entry) return "";

  return `
    <div class="sheet-header">
      <span class="sheet-icon thumb-tint-${tintFor(entry.address)}">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="8.5" />
          <path d="M3.5 12h17M12 3.5c2.4 2.3 3.6 5.3 3.6 8.5s-1.2 6.2-3.6 8.5c-2.4-2.3-3.6-5.3-3.6-8.5S9.6 5.8 12 3.5Z" />
        </svg>
      </span>
      <div>
        <h2 class="sheet-title" id="sheet-title">${escapeHtml(entry.name)}</h2>
        <p class="sheet-sub">Sunucu</p>
      </div>
    </div>
    <div class="sheet-badges"><span class="badge">${escapeHtml(entry.address)}</span></div>
    <p class="sheet-copy">Oyunu başlatıp sunucuya bağlanmak için adresi multiplayer ekranına ekleyebilir ya da doğrudan katılabilirsin.</p>
    <div class="sheet-facts">
      <div><span>Adres</span><strong>${escapeHtml(entry.address)}</strong></div>
      <div><span>Hesap</span><strong>${escapeHtml(selectedAccount() ?? "Player")}</strong></div>
    </div>
    <div class="sheet-actions">
      <button class="btn btn-secondary" type="button" data-copy="${escapeHtml(entry.address)}">Adresi kopyala</button>
      <button class="btn btn-primary" type="button" data-server-join="${escapeHtml(entry.name)}">Katıl</button>
    </div>`;
}

/* ==========================================================================
   Sponsors
   ========================================================================== */

/**
 * Sponsor sunucular. Yeni sponsor eklemek için listeye bir sunucu satırı ekle:
 * { name: "Sunucu Adı", address: "play.sunucu.net", note: "Kısa tanıtım" }
 */
interface SponsorEntry {
  name: string;
  address: string;
  note: string;
  iconUrl?: string;
  url?: string;
}

const SPONSORS: SponsorEntry[] = [];

/** Doldurulunca "Sponsor ol" düğmesi doğrudan bu bağlantıyı açar. */
const SPONSOR_CONTACT_URL = "";

function sponsorCard(entry: SponsorEntry, index: number): string {
  return `
    <article class="sponsor-card">
      <span class="sponsor-logo thumb-tint-${tintFor(entry.address || entry.name)}">
        ${
          entry.iconUrl
            ? `<img src="${escapeHtml(entry.iconUrl)}" alt="" loading="lazy" />`
            : escapeHtml(entry.name.charAt(0).toUpperCase())
        }
      </span>
      <div class="sponsor-body">
        <div class="sponsor-head">
          <span class="sponsor-name">${escapeHtml(entry.name)}</span>
          <span class="badge">Sponsor</span>
        </div>
        <div class="sponsor-address">${escapeHtml(entry.address)}</div>
        <p class="sponsor-note">${escapeHtml(entry.note)}</p>
      </div>
      <div class="sponsor-actions">
        <button class="select-btn" type="button" data-copy="${escapeHtml(entry.address)}">Kopyala</button>
        <button class="play-btn" type="button" data-sponsor-join="${index}">${PLAY_ICON}Katıl</button>
      </div>
    </article>`;
}

function renderSponsors() {
  const grid = $("#sponsor-grid");
  const count = $("#sponsor-count");
  if (count) count.textContent = String(SPONSORS.length);
  if (!grid) return;

  if (!SPONSORS.length) {
    grid.innerHTML = `
      <div class="sponsor-empty">
        <strong>Henüz sponsor sunucu yok</strong>
        <p>Bu alan launcher'ı destekleyen sunuculara ayrıldı. Sponsor olmak için "Sponsor ol" düğmesine bas.</p>
      </div>`;
    return;
  }

  grid.innerHTML = SPONSORS.map(sponsorCard).join("");
}

function sponsorSheet(): string {
  const contact = SPONSOR_CONTACT_URL
    ? `<button class="btn btn-primary" type="button" data-open-url="${escapeHtml(
        SPONSOR_CONTACT_URL
      )}">Bağlantıyı aç</button>`
    : "";

  return `
    <div class="sheet-header">
      <span class="sheet-icon thumb-tint-2">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="8.5" />
          <path d="M3.5 12h17M12 3.5c2.4 2.3 3.6 5.3 3.6 8.5s-1.2 6.2-3.6 8.5c-2.4-2.3-3.6-5.3-3.6-8.5S9.6 5.8 12 3.5Z" />
        </svg>
      </span>
      <div>
        <h2 class="sheet-title" id="sheet-title">Sponsor ol</h2>
        <p class="sheet-sub">Sunucunu launcher'a taşı</p>
      </div>
    </div>
    <p class="sheet-copy">
      Sponsor sunucular bu sayfada logosu, adresi ve kısa tanıtımıyla listelenir. Oyuncular
      launcher üzerinden tek dokunuşla katılır.
    </p>
    <div class="sheet-facts">
      <div><span>Listeleme</span><strong>Sunucu adı + adres</strong></div>
      <div><span>Tanıtım</span><strong>Kısa açıklama</strong></div>
      <div><span>Katılım</span><strong>Tek dokunuş</strong></div>
    </div>
    <p class="panel-note">
      Başvuru için sunucu adını, adresini ve kısa tanıtımını gönder; kartın bu sayfada yayınlansın.
    </p>
    <div class="sheet-actions">
      <button class="btn btn-secondary" type="button" data-close-sheet="true">Kapat</button>
      ${contact}
    </div>`;
}

/* --- oyun dizini bilgisi --- */

async function updateSettingsGameDir() {
  const node = $("#settings-game-dir");
  if (!node) return;

  const instance = currentInstance();
  if (!inTauri()) {
    node.textContent =
      instance.id === DEFAULT_INSTANCE_ID ? "launcher-service/minecraft" : `instances/${instance.id}`;
    return;
  }

  try {
    const dir = await invoke<string>("game_dir", { instance: instance.id });
    node.textContent = dir.replace(/^\/home\/[^/]+/, "~");
  } catch {
    node.textContent = "Bilinmiyor";
  }

  // Java çalıştırıcısının gerçek yolu: Tauri tarafında `which java` ile çözülür.
  const java = $("#settings-java-path");
  if (java) {
    if (!inTauri()) {
      java.textContent = "/usr/bin/java (önizleme)";
    } else {
      try {
        java.textContent = await invoke<string>("java_path");
      } catch {
        java.textContent = 'Java bulunamadı — "Java\'yı onar" dene';
      }
    }
  }
}

/* ==========================================================================
   Accounts
   ========================================================================== */

function accounts(): OfflineAccount[] {
  return readJson<OfflineAccount[]>(STORAGE_KEY, []);
}

function selectedAccount(): string | null {
  return localStorage.getItem(SELECTED_ACCOUNT_KEY);
}

function renderAccounts() {
  const list = $("#account-list");
  if (!list) return;

  const all = accounts();
  const selected = selectedAccount();

  const count = $("#account-count");
  if (count) count.textContent = String(all.length);

  if (!all.length) {
    list.innerHTML = emptyState("user", "Henüz hesap yok", "Aşağıdan bir profil ekle.");
    renderLaunchBar();
    return;
  }

  list.innerHTML = all
    .map(
      (account) => `
      <div class="row-item${account.username === selected ? " is-selected" : ""}">
        <span class="row-avatar">${escapeHtml(account.username.charAt(0).toUpperCase())}</span>
        <div class="row-text">
          <div class="row-title">${escapeHtml(account.username)}</div>
          <div class="row-meta">Çevrimdışı profil</div>
        </div>
        <div class="row-actions">
          ${
            account.username === selected
              ? '<span class="row-check">✓</span>'
              : `<button class="icon-action" type="button" data-account-select="${escapeHtml(
                  account.username
                )}" aria-label="Hesabı seç">
                   <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8.5 3.2 3.2L13 4.8" /></svg>
                 </button>`
          }
          <button class="icon-action danger" type="button" data-account-delete="${escapeHtml(
            account.username
          )}" aria-label="Hesabı sil">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
          </button>
        </div>
      </div>`
    )
    .join("");

  renderLaunchBar();
}

function renderLaunchBar() {
  const username = selectedAccount();
  const avatar = $<HTMLImageElement>("#account-avatar");
  const name = $("#account-name");
  const sub = $("#account-sub");
  const launchAccount = $("#launch-account");

  if (avatar) avatar.src = headshotUrl(username ?? "MHF_Steve");
  if (name) name.textContent = username ?? "Hesap ekle";
  if (sub) sub.textContent = username ? "Çevrimdışı profil" : "Profil oluştur";

  if (launchAccount) launchAccount.textContent = username ?? "Hesap ekle";

  updateVersionLabel();
  syncLaunchButton();
}

function syncLaunchButton() {
  const button = $<HTMLButtonElement>("#launch-btn");
  const label = $("#launch-label");
  const icon = $("#launch-icon");
  if (!button || !label || !icon) return;

  button.classList.toggle("is-starting", launchState === "starting");
  button.classList.toggle("is-stop", launchState === "running");
  icon.innerHTML = LAUNCH_ICONS[launchState];

  if (launchState === "starting") {
    button.disabled = true;
    label.textContent = "Başlatılıyor…";
    return;
  }

  if (launchState === "running") {
    button.disabled = false;
    label.textContent = "Durdur";
    return;
  }

  button.disabled = !manifest;
  label.textContent = "OYNA";
}

function addAccount() {
  const input = $<HTMLInputElement>("#account-username");
  if (!input) return;

  const username = input.value.trim();
  if (!username) {
    input.focus();
    return;
  }

  const all = accounts();
  if (all.some((account) => account.username.toLowerCase() === username.toLowerCase())) {
    toast("Bu hesap zaten var");
    return;
  }

  all.push({ username, createdAt: new Date().toISOString() });
  writeJson(STORAGE_KEY, all);
  localStorage.setItem(SELECTED_ACCOUNT_KEY, username);
  input.value = "";
  renderAccounts();
  renderLaunchBar();
  toast(`Hesap eklendi: ${username}`);
}

/* ==========================================================================
   Onboarding (ilk açılış hesap kurulumu)
   ========================================================================== */

const ONBOARDED_KEY = "ymc_onboarded";
const ONBOARD_STEPS = ["welcome", "account", "done"] as const;
type OnboardStep = (typeof ONBOARD_STEPS)[number];

function showOnboardStep(step: OnboardStep) {
  $$<HTMLElement>(".onboard-step").forEach((section) => {
    section.classList.toggle("is-active", section.dataset.step === step);
  });

  const index = ONBOARD_STEPS.indexOf(step);
  $$<HTMLElement>("#onboard-dots span").forEach((dot, dotIndex) => {
    dot.classList.toggle("is-active", dotIndex === index);
  });

  if (step === "account") {
    const input = $<HTMLInputElement>("#onboard-username");
    window.setTimeout(() => input?.focus(), 240);
  }
}

function updateOnboardPreview() {
  const input = $<HTMLInputElement>("#onboard-username");
  const username = input?.value.trim() ?? "";

  const avatar = $("#preview-avatar");
  const name = $("#preview-name");
  const create = $<HTMLButtonElement>("#onboard-create");

  if (avatar) avatar.textContent = username ? username.charAt(0).toUpperCase() : "?";
  if (name) name.textContent = username || "Kullanıcı adı";
  if (create) create.disabled = username.length === 0;
}

function openOnboarding(step: OnboardStep = "welcome") {
  const overlay = $("#onboarding");
  if (!overlay) return;

  overlay.hidden = false;
  updateOnboardPreview();
  showOnboardStep(step);
}

function closeOnboarding(launchAfter = false) {
  const overlay = $("#onboarding");
  if (!overlay || overlay.hidden) return;

  overlay.hidden = true;
  localStorage.setItem(ONBOARDED_KEY, "1");
  renderAccounts();
  renderLaunchBar();

  if (launchAfter) void launchGame();
}

function createOnboardAccount() {
  const input = $<HTMLInputElement>("#onboard-username");
  const username = input?.value.trim() ?? "";

  if (!username) {
    input?.focus();
    return;
  }

  const all = accounts();
  if (!all.some((account) => account.username.toLowerCase() === username.toLowerCase())) {
    all.push({ username, createdAt: new Date().toISOString() });
    writeJson(STORAGE_KEY, all);
  }

  localStorage.setItem(SELECTED_ACCOUNT_KEY, username);
  renderAccounts();

  const doneName = $("#onboard-done-name");
  if (doneName) doneName.textContent = username;

  showOnboardStep("done");
}

function setupOnboarding() {
  const username = $<HTMLInputElement>("#onboard-username");

  $("#onboard-start")?.addEventListener("click", () => showOnboardStep("account"));
  $("#onboard-back")?.addEventListener("click", () => showOnboardStep("welcome"));
  $("#onboard-skip")?.addEventListener("click", () => closeOnboarding());
  $("#onboard-create")?.addEventListener("click", createOnboardAccount);
  $("#onboard-finish")?.addEventListener("click", () => closeOnboarding());
  $("#onboard-launch")?.addEventListener("click", () => closeOnboarding(true));

  username?.addEventListener("input", updateOnboardPreview);
  username?.addEventListener("keydown", (event) => {
    if ((event as KeyboardEvent).key === "Enter") createOnboardAccount();
  });

  $$<HTMLElement>(".method").forEach((method) => {
    method.addEventListener("click", () => {
      if (method.classList.contains("is-disabled")) {
        toast("Microsoft girişi henüz hazır değil");
        return;
      }
      $$(".method").forEach((item) => item.classList.remove("is-active"));
      method.classList.add("is-active");
    });
  });

  // İlk açılış: hiç profil yoksa kurulum ekranı önce gelir.
  if (!accounts().length && localStorage.getItem(ONBOARDED_KEY) !== "1") {
    openOnboarding("welcome");
  }
}

/* ==========================================================================
   Launch
   ========================================================================== */

async function launchGame(version?: string) {
  if (launching) return;

  if (!selectedAccount()) {
    toast("Başlatmak için bir profil oluştur");
    openOnboarding("account");
    return;
  }

  const username = selectedAccount() ?? "Player";
  const base = currentInstance();
  const instance: InstanceEntry = version ? { ...base, version } : base;
  const memory = Number(localStorage.getItem(MEMORY_KEY) ?? 4096);

  setLaunchState("starting");
  setStatus("Hazırlanıyor…", "busy");
  addDownload(instance.id, instance.name, "Hazırlanıyor…");
  toast(`${instance.name} başlatılıyor…`);

  try {
    if (inTauri()) {
      await invoke("launch_minecraft", {
        username,
        version: instance.version,
        loader: instance.loader,
        instance: instance.id,
        memory,
        jvmArgs: localStorage.getItem(JVM_ARGS_KEY) ?? "",
      });
      hideLauncherWindow();
      watchInstanceProgress(instance.id, "launch", () => showLauncherWindow());
    } else {
      // Önizleme: indirme/başlatma adımlarını taklit et.
      let step = 0;
      await new Promise<void>((resolve) => {
        const timer = window.setInterval(() => {
          step += 1;
          updateDownload(instance.id, {
            status: step < 5 ? "Sürüm dosyaları indiriliyor…" : "Oyun başlatılıyor…",
            ratio: Math.min(1, step / 6),
          });
          if (step >= 6) {
            window.clearInterval(timer);
            resolve();
          }
        }, 350);
      });
      finishDownload(instance.id);
      setLaunchState("running");
      setStatus("Oyun çalışıyor");
      toast(`${username} olarak Minecraft başlatıldı (önizleme)`);
    }
  } catch (error) {
    console.error(error);
    showLauncherWindow();
    setLaunchState("idle");
    finishDownload(instance.id, "error");
    setStatus("Başlatılamadı", "error");
    toast(`Başlatılamadı: ${String(error)}`);
  }
}

async function stopGame() {
  const instance = currentInstance();
  showLauncherWindow();

  if (!inTauri()) {
    setLaunchState("idle");
    setStatus("Hazır");
    toast("Oyun durduruldu (önizleme)");
    return;
  }

  setStatus("Kapatılıyor…", "busy");
  try {
    await invoke<string>("stop_minecraft", { instance: instance.id });
    toast("Oyun kapatılıyor…");
    watchInstanceProgress(instance.id, "launch");
  } catch (error) {
    console.error(error);
    setStatus("Oyun çalışıyor");
    toast(`Durdurulamadı: ${String(error)}`);
  }
}

/// Uygulama açıldığında oyun zaten çalışıyorsa kırmızı "Durdur" durumuna geç.
async function restoreLaunchState() {
  if (!inTauri()) return;

  try {
    const data = await invoke<InstallProgress | null>("instance_progress", {
      instance: currentInstance().id,
    });
    if (data?.running) setLaunchState("running");
  } catch {
    /* yok say */
  }
}

/* ==========================================================================
   Settings: bellek, profiller, anahtarlar
   ========================================================================== */

const PROFILES: Record<string, number> = {
  "cok-dusuk": 1024,
  dusuk: 2048,
  orta: 4096,
  yuksek: 6144,
  ultra: 8192,
};

function totalRamMb(): number {
  const deviceMemory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const gb = deviceMemory && deviceMemory > 0 ? Math.max(8, Math.round(deviceMemory)) : 16;
  return gb * 1024;
}

function recommendedProfile(totalMb: number): string {
  const gb = totalMb / 1024;
  if (gb <= 4) return "Düşük";
  if (gb <= 8) return "Orta";
  if (gb <= 16) return "Yüksek";
  return "Ultra";
}

function formatMemory(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)} GB` : `${mb} MB`;
}

function paintMemory(mb: number) {
  const slider = $<HTMLInputElement>("#settings-memory");
  const value = $("#settings-memory-value");
  const ramMax = $<HTMLInputElement>("#ram-max");
  const total = totalRamMb();

  if (slider) {
    slider.max = String(total);
    slider.value = String(mb);
    const ratio = (mb - Number(slider.min)) / (Number(slider.max) - Number(slider.min));
    slider.style.setProperty("--fill", `${Math.max(0, Math.min(1, ratio)) * 100}%`);
  }
  if (value) value.textContent = `${formatMemory(mb)} seçili`;
  if (ramMax) ramMax.value = String(Math.max(1, Math.round(mb / 1024)));

  const totalLabel = $("#ram-total");
  if (totalLabel) totalLabel.textContent = formatMemory(total);

  const note = $("#perf-note");
  if (note) {
    note.textContent = `Sisteminizde ${formatMemory(total)} RAM var. Önerilen profil ${recommendedProfile(
      total
    )}.`;
  }
}

function setMemory(mb: number) {
  localStorage.setItem(MEMORY_KEY, String(mb));
  paintMemory(mb);
}

function setActiveProfile(name: string) {
  $$<HTMLElement>("#perf-profiles .choice").forEach((choice) => {
    choice.classList.toggle("is-active", choice.dataset.profile === name);
  });
  localStorage.setItem(PROFILE_KEY, name);
}

function setupMemory() {
  const slider = $<HTMLInputElement>("#settings-memory");
  const stored = Number(localStorage.getItem(MEMORY_KEY) ?? 4096);
  paintMemory(stored);

  slider?.addEventListener("input", () => {
    setActiveProfile("ozel");
    setMemory(Number(slider.value));
  });

  const ramMax = $<HTMLInputElement>("#ram-max");
  ramMax?.addEventListener("change", () => {
    const gb = Math.max(1, Number(ramMax.value) || 1);
    setActiveProfile("ozel");
    setMemory(gb * 1024);
  });

  $$<HTMLButtonElement>("#perf-profiles .choice").forEach((choice) => {
    choice.addEventListener("click", () => {
      const name = choice.dataset.profile ?? "orta";
      setActiveProfile(name);
      const mb = PROFILES[name];
      if (mb) setMemory(mb);
    });
  });

  const storedProfile = localStorage.getItem(PROFILE_KEY);
  if (storedProfile) setActiveProfile(storedProfile);
}

/** Uygulama sürümü; tauri.conf.json ve package.json ile eşit tutulmalı. */
const LAUNCHER_VERSION = "0.1.0";

/** Derleme zamanı yedeği; gerçek sürüm Tauri'den (tauri.conf.json) okunur. */
const LAUNCHER_VERSION_FALLBACK = "0.1.0";

/** Uygulamanın bildirdiği sürüm — güncelleme kontrolünün tek kaynağı. */
let launcherVersion = LAUNCHER_VERSION_FALLBACK;

/** Sürüm etiketlerini tek noktadan yazar. */
function renderAppVersion(): void {
  for (const id of ["#app-version", "#app-version-2"]) {
    const node = $(id);
    if (node) node.textContent = launcherVersion;
  }
}

/**
 * Sürüm numarasını paket sürümünden (tauri.conf.json) alır; böylece iki yerde
 * elle güncellenen bir sürüm kalmaz ve güncelleme kontrolü yanlış karar vermez.
 */
async function syncAppVersion(): Promise<void> {
  if (inTauri()) {
    try {
      const version = await getVersion();
      if (typeof version === "string" && version.length > 0) launcherVersion = version;
    } catch {
      // Önizlemede veya sürüm okunamazsa derleme zamanı yedeği kullanılır.
    }
  }
  renderAppVersion();
}

/** Sunucudaki version.json ile karşılaştırır; yeni sürüm varsa bağlantı verir. */
async function checkForUpdate(): Promise<void> {
  const button = $<HTMLButtonElement>("#check-update");
  if (button) button.disabled = true;

  try {
    if (!inTauri()) {        toast(`Modio Launcher ${launcherVersion} · güncel (önizleme)`);
      return;
    }
    const result = await invoke<{ latest: string; url: string; upToDate: boolean }>(
      "check_update",
      { current: launcherVersion }
    );
    if (result.upToDate || !result.latest) {
      toast(`Modio Launcher ${launcherVersion} güncel`);
    } else {
      toast(`Yeni sürüm var: ${result.latest}`);
      if (result.url) void openExternal(result.url);
    }
  } catch (error) {
    // Sunucuya ulaşılamadıysa sessizce güncel varsay; kullanıcıyı bloklamayalım.
    toast(`Modio Launcher ${LAUNCHER_VERSION} güncel`);
  } finally {
    if (button) button.disabled = false;
  }
}

function setupSettings() {
  $$<HTMLElement>(".settings-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const name = tab.dataset.settingsTab;
      $$<HTMLElement>(".settings-tab").forEach((item) =>
        item.classList.toggle("is-active", item === tab)
      );
      $$<HTMLElement>(".settings-pane").forEach((pane) =>
        pane.classList.toggle("is-active", pane.dataset.settingsPane === name)
      );
    });
  });

  // Launcher'ı oyun açılınca gizle
  const hideToggle = $<HTMLButtonElement>("#set-hide-launcher");
  hideToggle?.setAttribute("aria-checked", String(localStorage.getItem(HIDE_LAUNCHER_KEY) !== "0"));
  hideToggle?.addEventListener("click", () => {
    const next = hideToggle.getAttribute("aria-checked") !== "true";
    hideToggle.setAttribute("aria-checked", String(next));
    localStorage.setItem(HIDE_LAUNCHER_KEY, next ? "1" : "0");
  });

  // Performans modu
  const perfToggle = $<HTMLButtonElement>("#set-perf-mode");
  const applyPerfMode = (on: boolean) => {
    document.documentElement.classList.toggle("perf", on);
    perfToggle?.setAttribute("aria-checked", String(on));
  };
  applyPerfMode(localStorage.getItem(PERF_MODE_KEY) === "1");
  perfToggle?.addEventListener("click", () => {
    const next = perfToggle.getAttribute("aria-checked") !== "true";
    localStorage.setItem(PERF_MODE_KEY, next ? "1" : "0");
    applyPerfMode(next);
  });

  // Ekran modu
  const screenStored = localStorage.getItem(SCREEN_MODE_KEY) ?? "window";
  $$<HTMLElement>("#screen-modes .choice").forEach((choice) => {
    choice.classList.toggle("is-active", choice.dataset.screen === screenStored);
    choice.addEventListener("click", () => {
      localStorage.setItem(SCREEN_MODE_KEY, choice.dataset.screen ?? "window");
      $$<HTMLElement>("#screen-modes .choice").forEach((item) =>
        item.classList.toggle("is-active", item === choice)
      );
    });
  });

  // JVM argümanları
  const jvm = $<HTMLInputElement>("#jvm-args");
  if (jvm) {
    jvm.value = localStorage.getItem(JVM_ARGS_KEY) ?? "-XX:+UseG1GC";
    jvm.addEventListener("input", () => localStorage.setItem(JVM_ARGS_KEY, jvm.value));
  }

  // Sorun giderme ve güncelleme
  $("#repair-files")?.addEventListener("click", () => {
    void installInstance(currentInstance());
  });
  $("#repair-java")?.addEventListener("click", () => {
    toast("Java otomatik algılanıyor ve oyun başlatmada kullanılıyor");
  });
  $("#check-update")?.addEventListener("click", () => {
    void checkForUpdate();
  });

  renderAppVersion();
}

function setupModsView() {
  const tabs: Record<string, HTMLElement | null> = {
    discover: $("#mods-tab-discover"),
    installed: $("#mods-tab-installed"),
  };
  const panes: Record<string, HTMLElement | null> = {
    discover: $("#mods-pane-discover"),
    installed: $("#mods-pane-installed"),
  };

  const show = (view: "discover" | "installed") => {
    Object.entries(tabs).forEach(([key, node]) => node?.classList.toggle("is-active", key === view));
    Object.entries(panes).forEach(([key, node]) => node?.classList.toggle("is-active", key === view));
    if (view === "installed") void renderInstalledMods();
  };

  tabs.discover?.addEventListener("click", () => show("discover"));
  tabs.installed?.addEventListener("click", () => show("installed"));

  // Bölüm düğmeleri her liste yenilemesinde yeniden oluştuğu için delege edilir.
  $("#mods-results")?.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-mods-page]");
    if (!button || button.disabled) return;

    const page = Number(button.dataset.modsPage);
    if (!Number.isFinite(page) || page < 1 || page === modsPage) return;

    void searchMods(modsSearchQuery, page);
    const viewport = $("#viewport");
    if (viewport) viewport.scrollTo({ top: 0, behavior: "smooth" });
  });
}

function setupWindowControls() {
  document.documentElement.classList.toggle("is-tauri", inTauri());
}

/* ==========================================================================
   Global interactions
   ========================================================================== */

let globalQuery = "";
let modsTimer: number | undefined;

function setupGlobalSearch() {
  const input = $<HTMLInputElement>("#global-search");
  const modsSearch = $<HTMLInputElement>("#mods-search");

  input?.addEventListener("input", () => {
    globalQuery = input.value.trim().toLowerCase();

    if (activePage === "home") {
      return;
    }

    if (activePage === "mods") {
      if (modsSearch) modsSearch.value = input.value;
      window.clearTimeout(modsTimer);
      // Arama temizlenince en çok indirilenler listesine dön.
      const typing = globalQuery.length >= 2;
      modsTimer = window.setTimeout(
        () => void searchMods(typing ? input.value.trim() : ""),
        typing ? 550 : 400
      );
      return;
    }

  });

  const runModsSearch = () => {
    const query = modsSearch?.value.trim() ?? "";
    if (query) {
      if (input) input.value = query;
      void searchMods(query);
    }
  };

  $("#mods-search-btn")?.addEventListener("click", runModsSearch);
  modsSearch?.addEventListener("keydown", (event) => {
    if ((event as KeyboardEvent).key === "Enter") runModsSearch();
  });

  // Kutuyu temizleyince en çok indirilenler listesine dön.
  modsSearch?.addEventListener("input", () => {
    const value = modsSearch.value.trim();
    window.clearTimeout(modsTimer);
    modsTimer = window.setTimeout(
      () => void searchMods(value.length >= 2 ? value : ""),
      value.length >= 2 ? 550 : 400
    );
  });

  document.addEventListener("keydown", (event) => {
    const target = event.target as HTMLElement;
    const typing = target.tagName === "INPUT" || target.tagName === "TEXTAREA";

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      input?.focus();
      input?.select();
      return;
    }

    if (event.key === "/" && !typing) {
      event.preventDefault();
      input?.focus();
      return;
    }

    if (event.key === "Escape") {
      if (!$("#onboarding")?.hidden) {
        closeOnboarding();
        return;
      }
      if (typing) (target as HTMLInputElement).blur();
      closeSheet();
    }
  });
}

function setupFilters() {
  const thumb = $("#filters-thumb");
  const container = $("#version-filters");

  $$<HTMLButtonElement>(".segment[data-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      versionFilter = (button.dataset.filter as typeof versionFilter) ?? "all";
      $$(".segment[data-filter]").forEach((item) => item.classList.remove("is-active"));
      button.classList.add("is-active");
      if (container && thumb) placeThumb(container, thumb, button, 3, 0);
      renderLibraryGrid();
    });
  });

  const toggle = $("#experimental-toggle");
  toggle?.setAttribute("aria-checked", String(showExperimental));
  toggle?.addEventListener("click", () => {
    showExperimental = !showExperimental;
    localStorage.setItem(EXPERIMENTAL_KEY, showExperimental ? "1" : "0");
    toggle.setAttribute("aria-checked", String(showExperimental));
    renderLibraryGrid();
  });
}

function setupRail() {
  const rail = $("#featured-rail");
  if (!rail) return;

  $$<HTMLButtonElement>(".rail-btn").forEach((button) => {
    button.addEventListener("click", () => {
      const direction = button.dataset.rail === "prev" ? -1 : 1;
      rail.scrollBy({ left: direction * 640, behavior: "smooth" });
    });
  });
}

function setupDelegation() {
  document.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;

    const fav = target.closest<HTMLElement>(".fav[data-fav]");
    if (fav) {
      event.stopPropagation();
      toggleFavorite(fav);
      return;
    }

    const play = target.closest<HTMLElement>("[data-play]");
    if (play) {
      event.stopPropagation();
      closeSheet();
      void launchGame(play.dataset.play);
      return;
    }

    const select = target.closest<HTMLElement>("[data-select]");
    if (select) {
      event.stopPropagation();
      selectVersion();
      closeSheet();
      return;
    }

    const instanceInstall = target.closest<HTMLButtonElement>("[data-instance-install]");
    if (instanceInstall) {
      event.stopPropagation();
      const entry = instanceById(instanceInstall.dataset.instanceInstall as string);
      if (entry) void installInstance(entry, instanceInstall);
      return;
    }

    const instanceDelete = target.closest<HTMLElement>("[data-instance-delete]");
    if (instanceDelete) {
      event.stopPropagation();
      deleteInstanceRow(instanceDelete.dataset.instanceDelete as string);
      return;
    }

    const instanceSelect = target.closest<HTMLElement>("[data-instance-select]");
    if (instanceSelect) {
      event.stopPropagation();
      selectInstance(instanceSelect.dataset.instanceSelect as string);
      return;
    }

    const download = target.closest<HTMLButtonElement>("[data-mod-download]");
    if (download) {
      event.stopPropagation();
      void downloadMod(download.dataset.modDownload as string, download);
      return;
    }

    const removeMod = target.closest<HTMLButtonElement>("[data-mod-delete]");
    if (removeMod) {
      event.stopPropagation();
      void deleteMod(removeMod.dataset.modDelete as string);
      return;
    }

    const uninstallMod = target.closest<HTMLButtonElement>("[data-mod-remove]");
    if (uninstallMod) {
      event.stopPropagation();
      void removeInstalledProject(uninstallMod.dataset.modRemove as string, uninstallMod);
      return;
    }

    const accountSelect = target.closest<HTMLElement>("[data-account-select]");
    if (accountSelect) {
      event.stopPropagation();
      localStorage.setItem(SELECTED_ACCOUNT_KEY, accountSelect.dataset.accountSelect as string);
      renderAccounts();
      toast(`Hesap seçildi: ${accountSelect.dataset.accountSelect}`);
      return;
    }

    const accountDelete = target.closest<HTMLElement>("[data-account-delete]");
    if (accountDelete) {
      event.stopPropagation();
      const username = accountDelete.dataset.accountDelete as string;
      writeJson(
        STORAGE_KEY,
        accounts().filter((account) => account.username !== username)
      );
      if (selectedAccount() === username) localStorage.removeItem(SELECTED_ACCOUNT_KEY);
      renderAccounts();
      toast(`Hesap silindi: ${username}`);
      return;
    }

    const join = target.closest<HTMLElement>("[data-server-join]");
    if (join) {
      event.stopPropagation();
      closeSheet();
      void launchGame();
      return;
    }

    const sponsorJoin = target.closest<HTMLElement>("[data-sponsor-join]");
    if (sponsorJoin) {
      event.stopPropagation();
      const entry = SPONSORS[Number(sponsorJoin.dataset.sponsorJoin)];
      if (entry) {
        void navigator.clipboard?.writeText(entry.address);
        toast(`${entry.name} adresi kopyalandı · oyun başlatılıyor…`);
      }
      void launchGame();
      return;
    }

    const copy = target.closest<HTMLElement>("[data-copy]");
    if (copy) {
      event.stopPropagation();
      void navigator.clipboard?.writeText(copy.dataset.copy as string);
      toast("Adres kopyalandı");
      return;
    }

    const external = target.closest<HTMLElement>("[data-open-url]");
    if (external) {
      event.stopPropagation();
      const url = external.dataset.openUrl;
      if (url) void openExternal(url);
      return;
    }

    if (target.closest("[data-close-sheet]")) {
      closeSheet();
      return;
    }

    const opener = target.closest<HTMLElement>("[data-open]");
    if (opener?.dataset.open) {
      const [kind, value] = opener.dataset.open.split(":");
      if (kind === "version") openSheet(versionSheet(value));
      if (kind === "featured") openSheet(featuredSheet(value));
      if (kind === "server") openSheet(serverSheet(Number(value)));
      if (kind === "mod") openSheet(modSheet(value));
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const target = event.target as HTMLElement;

    const instanceTarget = target.closest<HTMLElement>("[data-instance-select]");
    if (instanceTarget && target === instanceTarget) {
      event.preventDefault();
      selectInstance(instanceTarget.dataset.instanceSelect as string);
      return;
    }

    const card = target.closest<HTMLElement>("[data-open]");
    if (!card || target !== card) return;
    event.preventDefault();
    const [kind, value] = (card.dataset.open as string).split(":");
    if (kind === "version") openSheet(versionSheet(value));
    if (kind === "featured") openSheet(featuredSheet(value));
    if (kind === "server") openSheet(serverSheet(Number(value)));
    if (kind === "mod") openSheet(modSheet(value));
  });
}

function modSheet(projectId: string) {
  const hit = modIndex.get(projectId);
  if (!hit) return "";
  const installed = installedProjects().has(projectId);

  return `
    <div class="sheet-header">
      <span class="sheet-icon">
        ${
          hit.icon_url
            ? `<img src="${escapeHtml(hit.icon_url)}" alt="" />`
            : `<span style="font-size:20px;color:var(--accent);font-weight:700">${escapeHtml(
                hit.title.charAt(0).toUpperCase()
              )}</span>`
        }
      </span>
      <div>
        <h2 class="sheet-title" id="sheet-title">${escapeHtml(hit.title)}</h2>
        <p class="sheet-sub">${hit.author ? escapeHtml(hit.author) : "Modrinth projesi"}</p>
      </div>
    </div>
    <div class="sheet-badges">
      <span class="badge">${MOD_CATEGORIES[modCategory].singular}</span>
      <span class="badge badge-ghost">${formatCount(hit.downloads)} indirme</span>
    </div>
    <p class="sheet-copy">${escapeHtml(hit.description)}</p>
    <div class="sheet-actions">
      <button class="btn btn-secondary" type="button" data-open-url="https://modrinth.com/mod/${escapeHtml(
        hit.slug
      )}">Modrinth'te aç</button>
      ${
        installed
          ? `<button class="btn btn-primary" type="button" data-mod-download="${escapeHtml(
              hit.project_id
            )}" disabled><span>Kurulu</span></button>
             ${modRemoveButton(hit.project_id, hit.title)}`
          : `<button class="btn btn-primary" type="button" data-mod-download="${escapeHtml(
              hit.project_id
            )}"><span>İndir</span></button>`
      }
    </div>`;
}

function setupButtons() {
  $("#launch-btn")?.addEventListener("click", () => {
    if (launchState === "running") {
      void stopGame();
      return;
    }
    void launchGame();
  });

  $("#launch-memory")?.addEventListener("click", () => {
    setPage("settings");
    window.setTimeout(
      () => $("#settings-memory")?.scrollIntoView({ behavior: "smooth", block: "center" }),
      140
    );
  });

  $("#instance-new")?.addEventListener("click", openInstanceSheet);
  $("#sponsor-become")?.addEventListener("click", () => openSheet(sponsorSheet()));

  $("#account-card")?.addEventListener("click", () => {
    if (selectedAccount()) {
      setPage("settings");
      $("#account-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    openOnboarding("account");
  });

  $("#account-add")?.addEventListener("click", addAccount);
  $("#account-username")?.addEventListener("keydown", (event) => {
    if ((event as KeyboardEvent).key === "Enter") addAccount();
  });

  $("#server-add")?.addEventListener("click", addServer);
  for (const id of ["#server-name", "#server-address"]) {
    $(id)?.addEventListener("keydown", (event) => {
      if ((event as KeyboardEvent).key === "Enter") addServer();
    });
  }

}

/* ==========================================================================
   Init
   ========================================================================== */

document.addEventListener("DOMContentLoaded", () => {
  setupTheme();
  setupAccentSwatches();
  setupNavigation();
  setupFilters();
  setupModCategories();
  setupModsView();
  setupGlobalSearch();
  setupRail();
  setupMemory();
  setupSettings();
  setupWindowControls();
  setupButtons();

  setupDelegation();
  setupSheetGestures();
  renderAccounts();
  renderServers();
  renderInstances();
  renderSponsors();
  renderDash();
  syncLaunchButton();
  setupOnboarding();
  void syncAppVersion();
  void renderInstalledMods();
  void updateSettingsGameDir();
  void restoreLaunchState();

  syncIndicators();
  void loadVersions();
  void loadFeatured();

  window.addEventListener("resize", () => syncIndicators());
  window.addEventListener("load", () => syncIndicators());

  // Fontlar yüklendikten sonra göstergeleri yeniden hesapla.
  document.fonts?.ready.then(() => syncIndicators());
});
