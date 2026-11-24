/**
 * Copy Monaco's AMD build into public/monaco/vs so the editor loads Monaco from this
 * app instead of a CDN (works offline / in CI, and pins the version to package-lock).
 * Runs automatically before `next dev` and `next build` (predev/prebuild).
 */
const fs = require("fs");
const path = require("path");

// monaco-editor's package "exports" hide package.json, so find the package dir by
// walking up node_modules like Node's resolver does.
function findPkgDir(name) {
  for (let dir = __dirname; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", name);
    if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
    if (path.dirname(dir) === dir) throw new Error(`cannot find ${name} in node_modules`);
  }
}
const pkgDir = findPkgDir("monaco-editor");
const src = path.join(pkgDir, "min", "vs");
const dest = path.resolve(__dirname, "../public/monaco/vs");
const version = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")).version;
const stamp = path.join(dest, ".version");

if (fs.existsSync(stamp) && fs.readFileSync(stamp, "utf8") === version) {
  console.log(`[copy-monaco] public/monaco/vs already at ${version}`);
  process.exit(0);
}
fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });
fs.cpSync(src, dest, { recursive: true });
fs.writeFileSync(stamp, version);
console.log(`[copy-monaco] copied monaco-editor ${version} -> public/monaco/vs`);
