// -------------------------------------------------------------------
// postinstall.js
//
// Ensures every `npm install` leaves better-sqlite3 (a native Node
// addon) compiled against the *Electron* NODE_MODULE_VERSION, not the
// system Node.js one. Without this, the app crashes on startup with:
//   "better-sqlite3 was compiled against NODE_MODULE_VERSION 115,
//    this version of Electron requires NODE_MODULE_VERSION 128".
//
// IMPORTANT — Windows paths with spaces
// -------------------------------------
// Earlier versions of this script called the `electron-rebuild` CLI via
// `spawnSync(..., { shell: true })`. On Windows, `shell: true` routes
// the invocation through `cmd.exe`, which then splits the resolved CLI
// path on spaces. When the project sits at e.g.
//     C:\Users\User\Documents\ACC BOT RELOAD\bonus-reload-bot
// the shell interprets everything after `ACC` as separate tokens and
// fails with:
//     'C:\Users\User\Documents\ACC' is not recognized as ...
//
// The fix is to *never* spawn a shell — call @electron/rebuild's
// programmatic API directly from Node. No CLI path resolution, no
// quoting, no shell involved at all.
// -------------------------------------------------------------------
"use strict";

const path = require("path");
const fs = require("fs");

if (process.env.SKIP_ELECTRON_REBUILD === "1") {
  console.log("[postinstall] SKIP_ELECTRON_REBUILD=1 — skipping electron rebuild.");
  process.exit(0);
}
if (process.env.ELECTRON_BUILDER_IS_RUNNING === "true") {
  console.log("[postinstall] electron-builder is running — it handles its own rebuild.");
  process.exit(0);
}

const projectRoot = path.resolve(__dirname, "..");

// Both @electron/rebuild and electron must be present. On the very first
// yarn/npm resolution pass they may not exist yet — bail gracefully so
// the install itself never fails.
let rebuild, electronPkgPath;
try {
  ({ rebuild } = require("@electron/rebuild"));
  electronPkgPath = require.resolve("electron/package.json", { paths: [projectRoot] });
} catch (e) {
  console.log(
    "[postinstall] @electron/rebuild or electron not yet installed — skipping.\n" +
      "             Run `npm install` again if you see NODE_MODULE_VERSION errors."
  );
  process.exit(0);
}

// Also make sure better-sqlite3 actually got installed before we try to
// rebuild it. (`npm install <one-package>` scenarios shouldn't crash.)
const bsqPkg = path.join(projectRoot, "node_modules", "better-sqlite3", "package.json");
if (!fs.existsSync(bsqPkg)) {
  console.log("[postinstall] better-sqlite3 is not installed — skipping.");
  process.exit(0);
}

const electronVersion = require(electronPkgPath).version;

console.log(
  `[postinstall] Rebuilding better-sqlite3 for Electron ${electronVersion} ` +
    `(cwd: ${projectRoot})…`
);

rebuild({
  buildPath: projectRoot,
  electronVersion,
  onlyModules: ["better-sqlite3"],
  force: true,
  // `disablePreGypCopy` isn't set — @electron/rebuild handles both
  // prebuild-install and node-gyp variants automatically.
})
  .then(() => {
    console.log("[postinstall] Native modules rebuilt for Electron ✓");
  })
  .catch((err) => {
    console.error(
      "[postinstall] electron-rebuild failed:\n" +
        (err && err.stack ? err.stack : String(err))
    );
    console.error(
      "\nYou can retry manually with:\n" +
        "    npm run rebuild:native\n"
    );
    // Don't fail the whole install — developers who only run Jest tests
    // don't need Electron ABI. `npm start` will surface the mismatch
    // clearly if the rebuild is genuinely required.
    process.exit(0);
  });
