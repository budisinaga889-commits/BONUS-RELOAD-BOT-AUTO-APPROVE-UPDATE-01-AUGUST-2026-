import { app, BrowserWindow, dialog, ipcMain } from "electron";
import * as path from "path";
import * as fs from "fs";
import { BrowserManager } from "../bot/BrowserManager";
import { Database } from "../bot/Database";
import { Logger } from "../bot/Logger";
import { RuleEngine } from "../bot/RuleEngine";
import { BotEngine } from "../bot/BotEngine";
import { AppConfig } from "../bot/types";
import { resolvePortablePaths, ensurePortableLayout } from "./portable-paths";

// ---- Portable-first data-directory resolution -----------------------------
//
// This app ships as a Windows PORTABLE executable (electron-builder
// `target: portable`). All user-mutable data (SQLite DB, config, browser
// profile, logs, exports) MUST live next to the .exe so that copying the
// folder to another machine takes the state with it, and replacing the
// .exe during an upgrade preserves the state.
//
// The heavy lifting lives in `./portable-paths` so it can be unit-tested
// with mocked environment / cwd / execPath. This module only glues the
// resolved paths into Electron's own `app.setPath` machinery.
// ---------------------------------------------------------------------------

const PORTABLE = resolvePortablePaths({
  env: process.env,
  cwd: process.cwd(),
  execDir: path.dirname(process.execPath),
  resourcesPath: (process as unknown as { resourcesPath?: string }).resourcesPath,
  isPackaged: app.isPackaged
});
ensurePortableLayout(PORTABLE);

function resolveUserDataDir(): string { return PORTABLE.browserProfile; }
function resolveLogDir():      string { return PORTABLE.logs; }
function resolveDbPath():      string { return PORTABLE.db; }
function resolveConfigPath():  string { return PORTABLE.writableConfig; }

// Point every Chromium-managed folder (session storage, cache, GPU
// cache, etc) at our portable data root. This MUST run before
// `app.whenReady()` so the very first paint uses our folders.
try {
  app.setPath("userData",    PORTABLE.electronUserData);
  app.setPath("sessionData", PORTABLE.electronUserData);
  app.setPath("cache",       PORTABLE.cache);
  app.setPath("temp",        PORTABLE.temp);
  app.setPath("logs",        PORTABLE.logs);
} catch (e) {
  // Non-fatal — the app still runs, it just falls back to %APPDATA%.
  console.warn("[main] Could not redirect Electron user paths:", e);
}



// ---- Config ----------------------------------------------------------------

const DEFAULT_CONFIG: AppConfig = {
  startURL: "",
  refreshInterval: 3000,
  minDelay: 800,
  maxDelay: 2000,
  dailyLimitAction: "skip",
  bonus5000CooldownMinutes: 10,
  cleanupRetentionDays: 90,
  historyExportPath: "",
  debugLogLevel: "info",
  logRetentionDays: 30
};

/** Clamp business-critical numeric config values regardless of source. */
function normalizeConfig(cfg: AppConfig): AppConfig {
  const refreshInterval = Math.min(
    10_000,
    Math.max(1_000, Math.round(cfg.refreshInterval || 3_000))
  );
  const bonus5000CooldownMinutes = Math.max(
    0,
    Math.round(cfg.bonus5000CooldownMinutes ?? 10)
  );
  const cleanupRetentionDays = Math.max(1, Math.round(cfg.cleanupRetentionDays ?? 90));
  const logRetentionDays = Math.max(0, Math.round(cfg.logRetentionDays ?? 30));
  return {
    ...cfg,
    refreshInterval,
    bonus5000CooldownMinutes,
    cleanupRetentionDays,
    logRetentionDays
  };
}

function loadConfig(): AppConfig {
  const p = resolveConfigPath();
  try {
    const raw = fs.readFileSync(p, "utf8");
    return normalizeConfig({ ...DEFAULT_CONFIG, ...JSON.parse(raw) });
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}
function saveConfig(cfg: AppConfig): void {
  const p = resolveConfigPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2), "utf8");
}

// ---- Wiring ----------------------------------------------------------------

let mainWindow: BrowserWindow | null = null;
let engine: BotEngine | null = null;
let browser: BrowserManager | null = null;
let db: Database | null = null;
let logger: Logger | null = null;
let rules: RuleEngine | null = null;
let config: AppConfig = loadConfig();

function createWindow(): void {
  const preloadPath  = path.join(__dirname, "preload.js");
  const rendererPath = path.join(__dirname, "..", "renderer", "index.html");

  // Diagnostic — makes it trivial to confirm the "which file is Electron
  // actually loading?" question raised by past bug reports. These lines
  // land in the terminal that launched `npm start`.
  console.log("[main] cwd:            ", process.cwd());
  console.log("[main] __dirname:      ", __dirname);
  console.log("[main] portable dir:   ", process.env.PORTABLE_EXECUTABLE_DIR || "(not portable)");
  console.log("[main] DATA_ROOT:      ", PORTABLE.root);
  console.log("[main] db:             ", resolveDbPath());
  console.log("[main] config:         ", resolveConfigPath());
  console.log("[main] preload path:   ", preloadPath, fs.existsSync(preloadPath) ? "(exists)" : "(MISSING)");
  console.log("[main] renderer path:  ", rendererPath, fs.existsSync(rendererPath) ? "(exists)" : "(MISSING)");

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: "#0a0d12",
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  // Aggressively drop any renderer disk cache so we never end up serving
  // a stale copy of app.js if the operator upgraded in place.
  mainWindow.webContents.session.clearCache().catch(() => {});

  mainWindow.loadFile(rendererPath);
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => (mainWindow = null));

  // Bubble any preload/renderer load errors to the terminal — makes
  // "why is my window blank?" trivially debuggable.
  mainWindow.webContents.on("preload-error", (_e, prel, err) => {
    console.error("[main] preload-error", prel, err);
  });
  mainWindow.webContents.on("did-fail-load", (_e, code, desc, url) => {
    console.error(`[main] did-fail-load ${code} ${desc} — ${url}`);
  });
  mainWindow.webContents.on("render-process-gone", (_e, details) => {
    console.error("[main] render-process-gone", details);
  });
}

function bootBot(): void {
  logger = new Logger();
  logger.configureFileSinks(resolveLogDir(), config.debugLogLevel, config.logRetentionDays);
  db = new Database(resolveDbPath());
  rules = new RuleEngine();
  browser = new BrowserManager(resolveUserDataDir());
  engine = new BotEngine(browser, db, rules, logger, config);

  engine.on("log", (entry) => mainWindow?.webContents.send("bot:log", entry));
  engine.on("stats", (s) => mainWindow?.webContents.send("bot:stats", s));
  engine.on("status", (s) => mainWindow?.webContents.send("bot:status", s));
  engine.on("skipped", (rows) => mainWindow?.webContents.send("bot:skipped", rows));
  engine.on("cycle", (r) => mainWindow?.webContents.send("bot:cycle", r));
  engine.on("metrics", (m) => mainWindow?.webContents.send("bot:metrics", m));

  // Startup Integrity Check.
  const chk = db.integrityCheck();
  if (!chk.ok) {
    engine.setIntegrityIssue(chk.message);
    logger.emitLog("FAILED", "INTEGRITY", 0, chk.message);
  }
}

function registerIpc(): void {
  ipcMain.handle("bot:start", async () => { await engine?.start(); return true; });
  ipcMain.handle("bot:stop", async () => { await engine?.stop(); return true; });
  ipcMain.handle("bot:openPanel", async () => {
    await browser?.openPanel(config.startURL);
    return true;
  });

  ipcMain.handle("bot:getConfig", () => config);
  ipcMain.handle("bot:setConfig", (_e, next: AppConfig) => {
    config = normalizeConfig({ ...config, ...next });
    saveConfig(config);
    logger?.configureFileSinks(resolveLogDir(), config.debugLogLevel, config.logRetentionDays);
    engine?.updateConfig(config);
    return config;
  });

  ipcMain.handle("bot:getStats", () =>
    engine?.getStats() ?? {
      approved: 0, rejected: 0, skipped: 0, failed: 0, verified: 0, skippedQueueSize: 0
    }
  );
  ipcMain.handle("bot:getMetrics", () => engine?.getMetrics() ?? null);
  ipcMain.handle("bot:getStatus", async () => ({
    running: engine?.isRunning() ?? false,
    browserOpen: browser?.isOpen() ?? false,
    loggedIn: (await browser?.isLoggedIn()) ?? false,
    integrityIssue: null
  }));

  ipcMain.handle("bot:getHistory", (_e, limit = 500, offset = 0) =>
    db?.listHistory(limit, offset) ?? []
  );
  ipcMain.handle("bot:getSkipped", () => engine?.skippedQueue.list() ?? []);
  ipcMain.handle("bot:rejectSkipped", async (_e, key: string) => {
    return (await engine?.rejectSkipped(key)) ?? false;
  });

  ipcMain.handle("bot:exportHistory", async () => {
    if (!db || !mainWindow) return { ok: false, message: "not ready", path: "" };
    let target = config.historyExportPath;
    if (target) {
      // Fixed export path from config — if it's a directory (or missing
      // ext) drop a timestamped file inside; otherwise use as-is.
      const stat = fs.existsSync(target) ? fs.statSync(target) : null;
      if (stat?.isDirectory() || !/\.csv$/i.test(target)) {
        target = path.join(
          target,
          `bonusbot-history-${new Date().toISOString().slice(0, 10)}.csv`
        );
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
    } else {
      // Portable default: `<PORTABLE.exports>` next to the .exe.
      const exportsDir = PORTABLE.exports;
      fs.mkdirSync(exportsDir, { recursive: true });
      const res = await dialog.showSaveDialog(mainWindow, {
        title: "Export Approval History",
        defaultPath: path.join(
          exportsDir,
          `bonusbot-history-${new Date().toISOString().slice(0, 10)}.csv`
        ),
        filters: [{ name: "CSV", extensions: ["csv"] }]
      });
      if (res.canceled || !res.filePath) return { ok: false, message: "cancelled", path: "" };
      target = res.filePath;
    }
    const count = db.exportHistoryCsv(target);
    return { ok: true, message: `Exported ${count} rows`, path: target };
  });

  ipcMain.handle("bot:cleanup", () => {
    if (!db) return { ok: false, removed: 0 };
    const removed = db.cleanup(config.cleanupRetentionDays);
    logger?.info(`Database cleanup — removed ${removed} rows older than ${config.cleanupRetentionDays}d.`);
    return { ok: true, removed };
  });

  ipcMain.handle("bot:integrityCheck", () => db?.integrityCheck() ?? { ok: false, message: "no db" });
  ipcMain.handle("bot:runCycleOnce", async () => (await engine?.runOnce()) ?? null);

  // Bug #7 — expose the log-prune action to the renderer.
  ipcMain.handle("bot:pruneLogs", () => ({
    ok: true,
    removed: logger?.pruneOldLogs() ?? 0
  }));
}

app.whenReady().then(() => {
  bootBot();
  registerIpc();
  createWindow();
});

app.on("window-all-closed", async () => {
  try {
    await engine?.stop();
    await browser?.close();
    db?.close();
  } finally {
    if (process.platform !== "darwin") app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
