import * as path from "path";
import * as fs from "fs";

/**
 * Portable data-directory layout.
 *
 * All user-mutable state MUST live next to the .exe so copying the
 * folder to another PC preserves everything and replacing the exe on
 * upgrade leaves user data intact.
 *
 * Resolution order:
 *   1. `BONUS_BOT_DATA_DIR`   — explicit override (e.g. network share).
 *   2. `PORTABLE_EXECUTABLE_DIR` — set by electron-builder's portable
 *      target at launch; points to the folder containing the .exe.
 *   3. `execDir`  — falls back to the directory of `process.execPath`
 *      for non-portable packaged builds.
 *   4. `cwd`      — dev fallback.
 *
 * The returned object contains every well-known path the app needs.
 */
export interface PortablePaths {
  root: string;
  db: string;
  browserProfile: string;
  logs: string;
  exports: string;
  electronUserData: string;
  cache: string;
  temp: string;
  writableConfig: string;
  bundledConfig: string;
}

export interface PortablePathOpts {
  /** `process.env` — overridable for tests. */
  env?: NodeJS.ProcessEnv;
  /** `process.cwd()` result — overridable for tests. */
  cwd?: string;
  /** Directory of `process.execPath` — overridable for tests. */
  execDir?: string;
  /** `process.resourcesPath` when packaged — overridable for tests. */
  resourcesPath?: string;
  /** `app.isPackaged` — overridable for tests. */
  isPackaged?: boolean;
}

export function resolvePortablePaths(opts: PortablePathOpts = {}): PortablePaths {
  const env         = opts.env         ?? process.env;
  const cwd         = opts.cwd         ?? process.cwd();
  const execDir     = opts.execDir     ?? path.dirname(process.execPath);
  const resources   = opts.resourcesPath ?? (process as unknown as { resourcesPath?: string }).resourcesPath;
  const isPackaged  = opts.isPackaged  ?? false;

  const override = env.BONUS_BOT_DATA_DIR;
  let root: string;
  if (override && override.trim() !== "") {
    root = path.resolve(override);
  } else if (env.PORTABLE_EXECUTABLE_DIR) {
    root = path.resolve(env.PORTABLE_EXECUTABLE_DIR, "data");
  } else if (isPackaged) {
    root = path.resolve(execDir, "data");
  } else {
    root = path.resolve(cwd, "data");
  }

  const bundledConfig = resources
    ? path.join(resources, "config", "config.json")
    : path.resolve(cwd, "config", "config.json");

  return {
    root,
    db:                path.join(root, "bonusbot.db"),
    browserProfile:    path.join(root, "browser-profile"),
    logs:              path.join(root, "logs"),
    exports:           path.join(root, "exports"),
    electronUserData:  path.join(root, "electron"),
    cache:             path.join(root, "cache"),
    temp:              path.join(root, "temp"),
    writableConfig:    path.join(root, "config.json"),
    bundledConfig
  };
}

/**
 * Materialise every writable directory below `root`. Copies the bundled
 * config into the writable location on first run if the writable one
 * does not exist yet.
 */
export function ensurePortableLayout(p: PortablePaths): void {
  fs.mkdirSync(p.root, { recursive: true });
  fs.mkdirSync(p.browserProfile, { recursive: true });
  fs.mkdirSync(p.logs, { recursive: true });
  fs.mkdirSync(p.exports, { recursive: true });
  fs.mkdirSync(p.electronUserData, { recursive: true });
  fs.mkdirSync(p.cache, { recursive: true });
  fs.mkdirSync(p.temp, { recursive: true });
  if (!fs.existsSync(p.writableConfig) && fs.existsSync(p.bundledConfig)) {
    fs.copyFileSync(p.bundledConfig, p.writableConfig);
  }
}
