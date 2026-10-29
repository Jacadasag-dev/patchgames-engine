import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
const digest = (text) => createHash("sha256").update(text).digest("hex");
const starterOwned = (file) => /^src\/gameModes\/(?:duel|battle-royale|rpg|just-chatting|blank|fps|voxel-survival)\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.(?:ts|json)$/.test(file);
const owned = (file) => starterOwned(file) || /^src\/(?:sandbox\/[A-Za-z0-9/]+\.(?:ts|js)|client\/game\/[A-Za-z0-9/]+\.(?:ts|js)|client\/ui\/gameUi(?:Style)?\.ts|shared\/[A-Za-z0-9]+\.(?:ts|d\.ts|json))$/.test(file);
function receipt(root) {
  const file = resolve(root, ".engine/manifest.json");
  if (!existsSync(file)) return;
  const data = JSON.parse(readFileSync(file, "utf8"));
  if (data.version !== 1 || !data.files || Object.keys(data.files).some((file2) => !owned(file2))) throw Error("Invalid generated engine manifest.");
  return data;
}
function engineSourceFiles(root) {
  const data = receipt(root);
  if (!data) return [];
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  if (pkg.dependencies?.["@patchgames/engine"] !== data.pin) throw Error("Generated engine pin is stale; run npm install.");
  for (const [file, hash] of Object.entries(data.files)) if (!existsSync(resolve(root, file)) || digest(readFileSync(resolve(root, file))) !== hash)
    throw Error(`Generated engine file changed: ${file}. Edit patchgames-engine and update the pinned dependency instead.`);
  return Object.keys(data.files).sort();
}
function materializeEngine(options = {}) {
  const root = resolve(options.root ?? process.cwd());
  let packageRoot = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(resolve(packageRoot, "package.json")) || JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8")).name !== "@patchgames/engine") {
    const parent = dirname(packageRoot);
    if (parent === packageRoot) throw Error("Cannot find the installed engine package.");
    packageRoot = parent;
  }
  const engineRoot = options.engineRoot ? resolve(options.engineRoot) : packageRoot;
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const pin = pkg.dependencies?.["@patchgames/engine"];
  if (typeof pin !== "string") throw Error("Pin @patchgames/engine in package.json first.");
  const engine = JSON.parse(readFileSync(resolve(engineRoot, "package.json"), "utf8"));
  if (engine.name !== "@patchgames/engine") throw Error("Unexpected engine package.");
  const files = {};
  function visit(directory) {
    for (const item of readdirSync(resolve(engineRoot, directory), { withFileTypes: true })) {
      const file = `${directory}/${item.name}`;
      if (item.isSymbolicLink()) throw Error(`Engine source must be a regular file: ${file}`);
      if (item.isDirectory()) visit(file);
      else if (owned(file)) files[file] = readFileSync(resolve(engineRoot, file));
      else throw Error(`Unexpected engine source: ${file}`);
    }
  }
  visit("src");
  const catalogPath = resolve(engineRoot, "starters/catalog.json");
  if (existsSync(catalogPath)) {
    const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
    for (const starter of catalog.starters) {
      const sourceRoot = resolve(engineRoot, "starters", starter.id, "src/game");
      const copy = (directory, relative = "") => {
        for (const item of readdirSync(directory, { withFileTypes: true })) {
          if (item.isSymbolicLink()) throw Error("Starter symlinks are not allowed");
          const part = relative + item.name;
          if (item.isDirectory()) copy(resolve(directory, item.name), part + "/");
          else if (/\.(ts|json)$/.test(item.name)) {
            const target = starter.hostDirectory + "/" + part;
            if (!starterOwned(target)) throw Error("Invalid starter destination");
            let source = readFileSync(resolve(directory, item.name), "utf8");
            source = source.replace(/(['"])((?:\.\.\/)+(?:sandbox|shared|client)\/[^'"\n]+)\1/g, (_all, quote, importPath) => quote + "../" + importPath + quote);
            files[target] = Buffer.from(source);
          }
        }
      };
      copy(sourceRoot);
    }
  }
  const hostAsset = resolve(root, "src/engineAssets/humanoidLocomotion.ts");
  if (existsSync(hostAsset)) {
    const contents = readFileSync(hostAsset);
    if (!/\bexport\s+const\s+HOST_LOCOMOTION_DATA\b/.test(contents.toString("utf8")))
      throw Error("Host humanoid animation data must export HOST_LOCOMOTION_DATA.");
    files["src/sandbox/hostAssets.ts"] = contents;
    files["src/sandbox/defaultLocomotionData.ts"] = Buffer.from("export {HOST_LOCOMOTION_DATA as DEFAULT_LOCOMOTION_DATA} from './hostAssets.ts';\n");
  }
  const prior = receipt(root);
  const originals = /* @__PURE__ */ new Map();
  if (options.adopt) {
    const manifest = JSON.parse(readFileSync(resolve(engineRoot, "extraction-manifest.json"), "utf8"));
    for (const file of manifest.files ?? []) if (file.originalSha256) originals.set(file.path, file.originalSha256);
  }
  for (const [file, contents] of Object.entries(files)) {
    const target = resolve(root, file);
    if (!target.startsWith(root + sep)) throw Error("Engine target escaped workspace.");
    if (!existsSync(target)) continue;
    const current = digest(readFileSync(target));
    if (current === digest(contents) || current === prior?.files[file] || options.adopt && current === originals.get(file)) continue;
    throw Error(`Refusing to overwrite modified engine file: ${file}`);
  }
  if (options.check) {
    if (!prior || prior.pin !== pin || Object.keys(prior.files).length !== Object.keys(files).length) throw Error("Engine materialization is stale; run npm install.");
    for (const [file, contents] of Object.entries(files)) if (!existsSync(resolve(root, file)) || digest(readFileSync(resolve(root, file))) !== digest(contents)) throw Error(`Stale engine file: ${file}`);
    return prior;
  }
  for (const file of Object.keys(prior?.files ?? {})) if (!(file in files) && existsSync(resolve(root, file)) && digest(readFileSync(resolve(root, file))) !== prior.files[file])
    throw Error(`Refusing to remove modified engine file: ${file}`);
  for (const file of Object.keys(prior?.files ?? {})) if (!(file in files)) {
    const target = resolve(root, file);
    if (existsSync(target)) {
      if (digest(readFileSync(target)) !== prior.files[file]) throw Error(`Refusing to remove modified engine file: ${file}`);
      unlinkSync(target);
    }
  }
  for (const [file, contents] of Object.entries(files)) {
    const target = resolve(root, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
  const result = { version: 1, pin, engineVersion: engine.version, files: Object.fromEntries(Object.entries(files).map(([file, data]) => [file, digest(data)])) };
  mkdirSync(resolve(root, ".engine"), { recursive: true });
  writeFileSync(resolve(root, ".engine/manifest.json"), JSON.stringify(result, null, 2) + "\n");
  return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf("--engine-root");
  const result = materializeEngine({ engineRoot: index < 0 ? void 0 : process.argv[index + 1], check: process.argv.includes("--check"), adopt: process.argv.includes("--adopt") });
  console.log(`Engine ${result.engineVersion}: ${Object.keys(result.files).length} verified generated source files.`);
}
export {
  engineSourceFiles,
  materializeEngine
};
