import fs from "fs-extra";
import path from "node:path";

const args = process.argv.slice(2);
// Usage:
//   node scripts/extract-hyp.mjs                -> process all .hyp in ./hyp
//   node scripts/extract-hyp.mjs hyp/dir        -> process all .hyp in given dir
//   node scripts/extract-hyp.mjs file.hyp       -> process a single file
//   node scripts/extract-hyp.mjs <path> --project <projectDir>

let inputPath = args[0] || "hyp";
let projectRoot = ".";
for (let i = 1; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--project") {
    projectRoot = args[i + 1] || projectRoot;
    i += 1;
  }
}

const mimeToExt = {
  "application/javascript": ".js",
  "text/javascript": ".js",
  "application/json": ".json",
  "application/octet-stream": "",
  "model/gltf-binary": ".glb",
  "model/gltf+json": ".gltf",
  "model/vrm": ".vrm",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/webp": ".webp",
  "image/avif": ".avif",
  "image/gif": ".gif",
  "image/svg+xml": ".svg",
  "image/ktx2": ".ktx2",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "audio/mpeg": ".mp3",
  "audio/ogg": ".ogg",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/aac": ".aac",
  "audio/mp4": ".m4a",
  "font/ttf": ".ttf",
  "font/otf": ".otf",
  "font/woff": ".woff",
  "font/woff2": ".woff2",
};

function extFromString(value) {
  if (!value) return "";
  const base = path.basename(value);
  return path.extname(base);
}

function resolveExtension({ url, mime, name }) {
  const urlExt = extFromString(url);
  if (urlExt) return urlExt;
  const nameExt = extFromString(name);
  if (nameExt) return nameExt;
  return mimeToExt[mime] || "";
}

function sanitizeName(value) {
  if (!value) return "app";
  return value.replace(/[\\/]/g, "-");
}

function isHashedScriptEntryPath(relPath) {
  if (!relPath || typeof relPath !== "string") return false;
  const normalized = relPath.replace(/\\/g, "/").trim();
  if (!normalized) return false;
  const filename = path.basename(normalized);
  const ext = path.extname(filename).toLowerCase();
  if (ext !== ".js") return false;
  const stem = filename.slice(0, -ext.length);
  return /^[a-f0-9]{64}$/i.test(stem);
}

function normalizeSingleHashedScriptEntry(scriptFiles, scriptEntry) {
  if (!scriptFiles || typeof scriptFiles !== "object" || Array.isArray(scriptFiles)) {
    return { scriptFiles: null, scriptEntry };
  }
  const entries = Object.entries(scriptFiles);
  if (entries.length !== 1) {
    return { scriptFiles, scriptEntry };
  }
  const [onlyPath, onlyUrl] = entries[0];
  if (typeof onlyUrl !== "string" || !onlyUrl) {
    return { scriptFiles, scriptEntry };
  }
  const configuredEntry =
    typeof scriptEntry === "string" && Object.prototype.hasOwnProperty.call(scriptFiles, scriptEntry)
      ? scriptEntry
      : onlyPath;
  if (!isHashedScriptEntryPath(configuredEntry)) {
    return { scriptFiles, scriptEntry };
  }
  return {
    scriptFiles: { "index.js": onlyUrl },
    scriptEntry: "index.js",
  };
}

function clonePropValue(value) {
  if (value === null || typeof value !== "object") return value;
  return Array.isArray(value) ? value.slice() : { ...value };
}
async function extractHyp({ hypPath, projectAbs }) {
  const appsDir = path.join(projectAbs, "apps");
  const assetsDir = path.join(projectAbs, "assets");
  await fs.ensureDir(appsDir);
  await fs.ensureDir(assetsDir);

  const hypAbs = path.resolve(hypPath);
  const buffer = await fs.readFile(hypAbs);
  const headerSize = buffer.readUInt32LE(0);
  const headerText = buffer.slice(4, 4 + headerSize).toString("utf8");
  const header = JSON.parse(headerText);
  const blueprint = header.blueprint || {};
  const assets = header.assets || [];

  const assetsByUrl = new Map();
  let position = 4 + headerSize;
  for (const asset of assets) {
    const data = buffer.slice(position, position + asset.size);
    assetsByUrl.set(asset.url, { info: asset, data });
    position += asset.size;
  }

  const defaultName = path.parse(hypAbs).name;
  const appName = blueprint.scene
    ? "$scene"
    : sanitizeName(blueprint.name || defaultName);
  const appDir = path.join(appsDir, appName);
  await fs.ensureDir(appDir);

  const written = [];
  function recordWrite(filePath) {
    written.push(path.relative(projectAbs, filePath));
  }

  async function writeAsset(url, outputName, nameHint) {
    if (!url) return null;
    const asset = assetsByUrl.get(url);
    if (!asset) {
      console.warn(`[extract-hyp] missing asset for url: ${url}`);
      return null;
    }
    const ext = resolveExtension({ url, mime: asset.info?.mime, name: nameHint });
    const filename = `${outputName}${ext}`;
    const filePath = path.join(assetsDir, filename);
    await fs.writeFile(filePath, asset.data);
    recordWrite(filePath);
    return `assets/${filename}`;
  }

  // Write module scripts if present
  const rawScriptFiles = blueprint.scriptFiles && typeof blueprint.scriptFiles === "object" ? blueprint.scriptFiles : null;
  const rawScriptEntry =
    typeof blueprint.scriptEntry === "string" && blueprint.scriptEntry.trim() ? blueprint.scriptEntry.trim() : "index.js";
  const normalizedScripts = normalizeSingleHashedScriptEntry(rawScriptFiles, rawScriptEntry);
  const scriptFiles = normalizedScripts.scriptFiles;
  const scriptEntry = normalizedScripts.scriptEntry;
  let wroteAnyScript = false;
  if (scriptFiles && Object.keys(scriptFiles).length) {
    for (const [relPath, url] of Object.entries(scriptFiles)) {
      const fileAsset = assetsByUrl.get(url);
      if (!fileAsset) {
        console.warn(`[extract-hyp] missing script asset for url: ${url}`);
        continue;
      }
      const outPath = path.join(appDir, relPath);
      await fs.ensureDir(path.dirname(outPath));
      await fs.writeFile(outPath, fileAsset.data);
      recordWrite(outPath);
      wroteAnyScript = true;
    }
  } else if (blueprint.script) {
    // Legacy single-file script; write to index.js
    const scriptAsset = assetsByUrl.get(blueprint.script);
    if (!scriptAsset) {
      console.warn(`[extract-hyp] missing script asset for url: ${blueprint.script}`);
    } else {
      const scriptPath = path.join(appDir, "index.js");
      await fs.writeFile(scriptPath, scriptAsset.data);
      recordWrite(scriptPath);
      wroteAnyScript = true;
    }
  }

  // If no code bundled, create a minimal entry wrapper so the app is runnable
  if (!wroteAnyScript) {
    const scriptPath = path.join(appDir, "index.js");
    const wrapper = "export default function main(world, app, fetch, props, setTimeout) { }\n";
    await fs.writeFile(scriptPath, wrapper);
    recordWrite(scriptPath);
    wroteAnyScript = true;
  }

  // Ensure entry has the required wrapper signature at top-level
  const entryPath = path.join(appDir, scriptFiles ? scriptEntry : "index.js");
  try {
    let entrySrc = await fs.readFile(entryPath, "utf8");
    const hasWrapper = /export\s+default\s+function\s+main\s*\(\s*world\s*,\s*app\s*,\s*fetch\s*,\s*props\s*,\s*setTimeout\s*\)\s*\{/.test(
      entrySrc,
    );
    if (!hasWrapper) {
      entrySrc = `export default function main(world, app, fetch, props, setTimeout) {\n${entrySrc}\n}\n`;
      await fs.writeFile(entryPath, entrySrc);
      recordWrite(entryPath);
    }
  } catch (err) {
    console.warn(`[extract-hyp] failed to ensure wrapper for entry: ${entryPath}`, err?.message || err);
  }

  const modelBase = blueprint.scene ? "-scene" : appName;
  const modelPath = blueprint.model
    ? await writeAsset(blueprint.model, modelBase)
    : null;

  const imagePath = blueprint.image?.url
    ? await writeAsset(
        blueprint.image.url,
        `${appName}\_\_image`,
        blueprint.image.name,
      )
    : null;

  const props = {};
  for (const [key, value] of Object.entries(blueprint.props || {})) {
    if (value && typeof value === "object" && value.url) {
      const nextValue = clonePropValue(value);
      const assetPath = await writeAsset(value.url, key, value.name);
      if (assetPath) {
        nextValue.url = assetPath;
      }
      if ("name" in nextValue) {
        delete nextValue.name;
      }
      props[key] = nextValue;
    } else {
      props[key] = value;
    }
  }

  const appJson = {
    author: blueprint.author ?? null,
    url: blueprint.url ?? null,
    desc: blueprint.desc ?? null,
    preload: blueprint.preload ?? false,
    public: blueprint.public ?? false,
    locked: blueprint.locked ?? false,
    frozen: blueprint.frozen ?? false,
    unique: blueprint.unique ?? false,
    disabled: blueprint.disabled ?? false,
    scene: blueprint.scene ?? false,
    model: modelPath,
    image: imagePath ? { url: imagePath } : null,
    props,
  };

  // Script metadata: prefer module scripts when scriptFiles exist
  const scriptFormat = blueprint.scriptFormat || "module"; // always module; we ensure an index.js exists
  if (scriptFormat) appJson.scriptFormat = scriptFormat;
  if (scriptFiles && scriptEntry && scriptEntry !== "index.js") appJson.scriptEntry = scriptEntry;

  const jsonName = `${appName}.json`;
  const jsonPath = path.join(appDir, jsonName);
  await fs.writeFile(jsonPath, `${JSON.stringify(appJson, null, 2)}\n`);
  recordWrite(jsonPath);

  console.log(`[extract-hyp] extracted ${hypPath}`);
  for (const file of written) {
    console.log(`- ${file}`);
  }
}

async function main() {
  const projectAbs = path.resolve(projectRoot);
  const inputAbs = path.resolve(inputPath);
  const stat = await fs.stat(inputAbs).catch(() => null);
  if (!stat) {
    console.error(`[extract-hyp] not found: ${inputPath}`);
    process.exit(1);
  }
  if (stat.isDirectory()) {
    const entries = await fs.readdir(inputAbs);
    const files = entries.filter((name) => name.toLowerCase().endsWith(".hyp"));
    if (files.length === 0) {
      console.log(`[extract-hyp] no .hyp files found in ${inputPath}`);
      return;
    }
    for (const name of files) {
      const filePath = path.join(inputAbs, name);
      await extractHyp({ hypPath: filePath, projectAbs });
    }
  } else {
    if (!inputAbs.toLowerCase().endsWith(".hyp")) {
      console.error("[extract-hyp] input file must be a .hyp");
      process.exit(1);
    }
    await extractHyp({ hypPath: inputAbs, projectAbs });
  }
}

await main();
