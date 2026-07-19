// -------------------------------------------------------------------
// rebuild-for-node.js
//
// Runs *before* the Jest test suite. Jest executes on plain Node.js
// (not Electron), so it needs the Node ABI build of `better-sqlite3`.
// Since our `postinstall` compiles native modules against Electron by
// default (so `npm start` works out of the box on a fresh clone), we
// swap them back to Node here.
//
// This script is idempotent — if better-sqlite3 already instantiates
// under Node, no rebuild is attempted.
//
// IMPORTANT — no `shell: true` and no bare CLI names
// --------------------------------------------------
// We invoke `npm rebuild` via the current Node executable + the JS
// entrypoint of the running npm (from `process.env.npm_execpath`).
// This bypasses cmd.exe entirely, so paths that contain spaces (e.g.
// `C:\Users\User\Documents\ACC BOT RELOAD\...`) are handled correctly.
// -------------------------------------------------------------------
"use strict";

const path = require("path");
const fs = require("fs");
const { spawnSync } = require("child_process");

const projectRoot = path.resolve(__dirname, "..");

function loadsUnderNode() {
  try {
    const Database = require(path.join(projectRoot, "node_modules", "better-sqlite3"));
    const db = new Database(":memory:");
    db.close();
    return true;
  } catch {
    return false;
  }
}

if (loadsUnderNode()) {
  console.log("[pretest] better-sqlite3 already loads under Node — no rebuild needed.");
  process.exit(0);
}

console.log("[pretest] Rebuilding better-sqlite3 for Node.js ABI…");

// Prefer the npm that actually invoked us; fall back to a common location.
const npmCli =
  process.env.npm_execpath && fs.existsSync(process.env.npm_execpath)
    ? process.env.npm_execpath
    : null;

let res;
if (npmCli) {
  res = spawnSync(
    process.execPath,
    [npmCli, "rebuild", "better-sqlite3", "--build-from-source"],
    { stdio: "inherit", cwd: projectRoot, shell: false }
  );
} else {
  // Fallback: use node-gyp directly (installed transitively by better-sqlite3).
  const bsqDir = path.join(projectRoot, "node_modules", "better-sqlite3");
  const nodeGyp = path.join(projectRoot, "node_modules", ".bin",
    process.platform === "win32" ? "node-gyp.cmd" : "node-gyp");
  if (!fs.existsSync(nodeGyp)) {
    console.error("[pretest] Cannot locate npm or node-gyp — aborting.");
    process.exit(1);
  }
  // spawn without shell; on Windows `.cmd` files are launched via
  // Node's own logic (Node 16+ handles this correctly without a shell).
  res = spawnSync(nodeGyp, ["rebuild"], {
    stdio: "inherit",
    cwd: bsqDir,
    shell: false
  });
}

if ((res.status ?? 0) !== 0) {
  console.error("[pretest] Rebuild failed.");
  process.exit(res.status ?? 1);
}

// NOTE: we do NOT re-check `loadsUnderNode()` here — Node's require
// cache (and V8's dlopen cache) can hold on to the previous binding in
// the same process, which produces a false negative. Jest runs in a
// brand new Node process where the freshly-built `.node` file is
// picked up correctly.
console.log("[pretest] better-sqlite3 rebuilt for Node ABI ✓");
