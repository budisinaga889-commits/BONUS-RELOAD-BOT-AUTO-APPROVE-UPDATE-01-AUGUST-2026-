import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { resolvePortablePaths, ensurePortableLayout } from "../src/main/portable-paths";

function mktemp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "brb-portable-"));
}

describe("portable-paths — data lives next to the executable", () => {
  test("PORTABLE_EXECUTABLE_DIR wins over cwd / execDir when set", () => {
    const exeDir = mktemp();
    const p = resolvePortablePaths({
      env: { PORTABLE_EXECUTABLE_DIR: exeDir },
      cwd: "/tmp/whatever",
      execDir: "/opt/electron",
      isPackaged: true
    });
    expect(p.root).toBe(path.resolve(exeDir, "data"));
    expect(p.db).toBe(path.join(p.root, "bonusbot.db"));
    expect(p.browserProfile).toBe(path.join(p.root, "browser-profile"));
    expect(p.logs).toBe(path.join(p.root, "logs"));
    expect(p.exports).toBe(path.join(p.root, "exports"));
    expect(p.electronUserData).toBe(path.join(p.root, "electron"));
    expect(p.writableConfig).toBe(path.join(p.root, "config.json"));
    fs.rmSync(exeDir, { recursive: true, force: true });
  });

  test("BONUS_BOT_DATA_DIR overrides even PORTABLE_EXECUTABLE_DIR", () => {
    const override = mktemp();
    const p = resolvePortablePaths({
      env: {
        BONUS_BOT_DATA_DIR: override,
        PORTABLE_EXECUTABLE_DIR: "/tmp/somewhere-else"
      },
      cwd: "/tmp/whatever",
      execDir: "/opt/electron",
      isPackaged: true
    });
    expect(p.root).toBe(path.resolve(override));
    fs.rmSync(override, { recursive: true, force: true });
  });

  test("packaged non-portable build falls back to execDir/data", () => {
    const exeDir = mktemp();
    const p = resolvePortablePaths({
      env: {},
      cwd: "/tmp/whatever",
      execDir: exeDir,
      isPackaged: true
    });
    expect(p.root).toBe(path.resolve(exeDir, "data"));
    fs.rmSync(exeDir, { recursive: true, force: true });
  });

  test("dev run (not packaged, no env) falls back to cwd/data", () => {
    const cwd = mktemp();
    const p = resolvePortablePaths({
      env: {},
      cwd,
      execDir: "/opt/electron",
      isPackaged: false
    });
    expect(p.root).toBe(path.resolve(cwd, "data"));
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  test("resolved paths NEVER point inside %APPDATA%, %LOCALAPPDATA%, ~/.config, or /Users/.../Library", () => {
    const exeDir = mktemp();
    const p = resolvePortablePaths({
      env: { PORTABLE_EXECUTABLE_DIR: exeDir },
      cwd: "/tmp/whatever",
      execDir: "/opt/electron",
      isPackaged: true
    });
    const forbidden = [
      "AppData", "Roaming", "Local",
      ".config", "Library", "Application Support"
    ];
    for (const p2 of [p.root, p.db, p.browserProfile, p.logs, p.exports, p.electronUserData, p.writableConfig]) {
      for (const bad of forbidden) {
        expect(p2.includes(bad)).toBe(false);
      }
    }
    fs.rmSync(exeDir, { recursive: true, force: true });
  });

  test("ensurePortableLayout creates every subdirectory and seeds the writable config on first run", () => {
    const exeDir = mktemp();
    // Fake a bundled config file so seeding has something to copy from.
    const bundledRoot = mktemp();
    const bundledCfgDir = path.join(bundledRoot, "config");
    fs.mkdirSync(bundledCfgDir, { recursive: true });
    fs.writeFileSync(path.join(bundledCfgDir, "config.json"), '{ "seeded": true }');

    const p = resolvePortablePaths({
      env: { PORTABLE_EXECUTABLE_DIR: exeDir },
      cwd: "/tmp/whatever",
      execDir: "/opt/electron",
      resourcesPath: bundledRoot,
      isPackaged: true
    });
    ensurePortableLayout(p);

    for (const dir of [p.root, p.browserProfile, p.logs, p.exports, p.electronUserData, p.cache, p.temp]) {
      expect(fs.existsSync(dir)).toBe(true);
      expect(fs.statSync(dir).isDirectory()).toBe(true);
    }
    expect(fs.existsSync(p.writableConfig)).toBe(true);
    const seeded = JSON.parse(fs.readFileSync(p.writableConfig, "utf8"));
    expect(seeded).toEqual({ seeded: true });

    // Idempotency + upgrade-safe: mutate writable config, re-run seed —
    // the on-disk file must be preserved (simulates .exe upgrade).
    fs.writeFileSync(p.writableConfig, '{ "userModified": true }');
    ensurePortableLayout(p);
    const still = JSON.parse(fs.readFileSync(p.writableConfig, "utf8"));
    expect(still).toEqual({ userModified: true });

    fs.rmSync(exeDir, { recursive: true, force: true });
    fs.rmSync(bundledRoot, { recursive: true, force: true });
  });

  test("Simulated PC-copy — moving the whole data root to another folder keeps every path relative to it", () => {
    const originalExe = mktemp();
    const p1 = resolvePortablePaths({
      env: { PORTABLE_EXECUTABLE_DIR: originalExe },
      cwd: "/tmp/whatever",
      execDir: "/opt/electron",
      isPackaged: true
    });
    ensurePortableLayout(p1);
    fs.writeFileSync(path.join(p1.root, "user-file.txt"), "hello");

    // Copy the whole thing to another location — simulates moving the
    // portable folder to another PC.
    const newExe = mktemp();
    fs.cpSync(originalExe, newExe, { recursive: true });

    const p2 = resolvePortablePaths({
      env: { PORTABLE_EXECUTABLE_DIR: newExe },
      cwd: "/tmp/whatever",
      execDir: "/opt/electron",
      isPackaged: true
    });
    expect(p2.root).toBe(path.resolve(newExe, "data"));
    expect(fs.existsSync(path.join(p2.root, "user-file.txt"))).toBe(true);
    expect(fs.readFileSync(path.join(p2.root, "user-file.txt"), "utf8")).toBe("hello");

    fs.rmSync(originalExe, { recursive: true, force: true });
    fs.rmSync(newExe, { recursive: true, force: true });
  });
});
