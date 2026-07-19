// Copies the renderer folder (HTML/CSS/JS) into dist/renderer during build.
// The renderer is pure vanilla HTML/CSS/JS + a tiny TS file compiled inline;
// we ship it as-is (no bundler) to keep the build lightweight.
const fs = require("fs");
const path = require("path");

const src = path.resolve(__dirname, "..", "src", "renderer");
const dest = path.resolve(__dirname, "..", "dist", "renderer");

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, entry.name);
    const d = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

copyDir(src, dest);
console.log(`[renderer] copied ${src} -> ${dest}`);
