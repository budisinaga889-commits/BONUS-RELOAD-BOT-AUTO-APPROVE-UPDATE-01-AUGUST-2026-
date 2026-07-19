import { contextBridge, ipcRenderer } from "electron";

/**
 * Preload — the ONLY bridge between renderer and main.
 * The renderer must never touch Node / Electron APIs directly.
 */

export type ConfigPayload = {
  startURL: string;
  refreshInterval: number;
  minDelay: number;
  maxDelay: number;
  dailyLimitAction: "skip" | "reject";
  bonus5000CooldownMinutes: number;
  cleanupRetentionDays: number;
  historyExportPath: string;
  debugLogLevel: "error" | "warn" | "info" | "debug";
  logRetentionDays: number;
};

const api = {
  start: (): Promise<boolean> => ipcRenderer.invoke("bot:start"),
  stop: (): Promise<boolean> => ipcRenderer.invoke("bot:stop"),
  openPanel: (): Promise<boolean> => ipcRenderer.invoke("bot:openPanel"),
  runCycleOnce: (): Promise<unknown> => ipcRenderer.invoke("bot:runCycleOnce"),

  getConfig: (): Promise<ConfigPayload> => ipcRenderer.invoke("bot:getConfig"),
  setConfig: (cfg: ConfigPayload): Promise<ConfigPayload> =>
    ipcRenderer.invoke("bot:setConfig", cfg),

  getStats: (): Promise<unknown> => ipcRenderer.invoke("bot:getStats"),
  getStatus: (): Promise<unknown> => ipcRenderer.invoke("bot:getStatus"),
  getMetrics: (): Promise<unknown> => ipcRenderer.invoke("bot:getMetrics"),
  pruneLogs: (): Promise<{ ok: boolean; removed: number }> =>
    ipcRenderer.invoke("bot:pruneLogs"),

  getHistory: (limit = 500, offset = 0): Promise<unknown[]> =>
    ipcRenderer.invoke("bot:getHistory", limit, offset),
  getSkipped: (): Promise<unknown[]> => ipcRenderer.invoke("bot:getSkipped"),
  rejectSkipped: (key: string): Promise<boolean> =>
    ipcRenderer.invoke("bot:rejectSkipped", key),

  exportHistory: (): Promise<{ ok: boolean; message: string; path: string }> =>
    ipcRenderer.invoke("bot:exportHistory"),
  cleanup: (): Promise<{ ok: boolean; removed: number }> => ipcRenderer.invoke("bot:cleanup"),
  integrityCheck: (): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke("bot:integrityCheck"),

  onLog: (cb: (entry: unknown) => void) => {
    const l = (_e: unknown, entry: unknown) => cb(entry);
    ipcRenderer.on("bot:log", l);
    return () => ipcRenderer.removeListener("bot:log", l);
  },
  onStats: (cb: (stats: unknown) => void) => {
    const l = (_e: unknown, stats: unknown) => cb(stats);
    ipcRenderer.on("bot:stats", l);
    return () => ipcRenderer.removeListener("bot:stats", l);
  },
  onStatus: (cb: (status: unknown) => void) => {
    const l = (_e: unknown, status: unknown) => cb(status);
    ipcRenderer.on("bot:status", l);
    return () => ipcRenderer.removeListener("bot:status", l);
  },
  onSkipped: (cb: (rows: unknown[]) => void) => {
    const l = (_e: unknown, rows: unknown[]) => cb(rows);
    ipcRenderer.on("bot:skipped", l);
    return () => ipcRenderer.removeListener("bot:skipped", l);
  },
  onCycle: (cb: (report: unknown) => void) => {
    const l = (_e: unknown, report: unknown) => cb(report);
    ipcRenderer.on("bot:cycle", l);
    return () => ipcRenderer.removeListener("bot:cycle", l);
  },
  onMetrics: (cb: (metrics: unknown) => void) => {
    const l = (_e: unknown, metrics: unknown) => cb(metrics);
    ipcRenderer.on("bot:metrics", l);
    return () => ipcRenderer.removeListener("bot:metrics", l);
  }
};

contextBridge.exposeInMainWorld("bot", api);
export type BotApi = typeof api;
