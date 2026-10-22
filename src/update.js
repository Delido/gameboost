// Updater: checks the latest GitHub release and replaces the app files in place.
// Only installations made with the setup (bundled runtime\node.exe, no .git folder) update themselves;
// development checkouts are updated with git.
import { readFileSync, existsSync, mkdirSync, rmSync, cpSync, writeFileSync, readdirSync, renameSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runPS } from "./ps.js";
import { loadState, updateState, logHistory, DATA_DIR } from "./state.js";

export const REPO = "Delido/gameboost";
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const CHECK_INTERVAL = 6 * 60 * 60 * 1000;
// Folders/files that make up the app (runtime\node.exe is only replaced by the setup).
const APP_DIRS = ["bin", "src", "ui"];
const APP_FILES = ["package.json", "README.md", "LICENSE"];

export function currentVersion() {
  return JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
}

/** "installed" (setup), "dev" (git checkout) or "portable". */
export function installKind() {
  if (existsSync(join(ROOT, ".git"))) return "dev";
  if (existsSync(join(ROOT, "runtime", "node.exe"))) return "installed";
  return "portable";
}

export function isNewer(a, b) {
  const pa = String(a).split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

async function fetchLatest() {
  const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { "User-Agent": "GameBoost-Updater", Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(15000),
  });
  if (r.status === 404) return null; // no release yet
  if (!r.ok) throw new Error(`GitHub antwortet mit ${r.status}`);
  const rel = await r.json();
  const zip = rel.assets.find((a) => /^gameboost-[\d.]+\.zip$/i.test(a.name));
  const setup = rel.assets.find((a) => /^GameBoost-Setup-[\d.]+\.exe$/i.test(a.name));
  return {
    version: rel.tag_name.replace(/^v/, ""),
    notes: rel.body || "",
    url: rel.html_url,
    publishedAt: rel.published_at,
    zip: zip && { url: zip.browser_download_url, size: zip.size, sha256: zip.digest?.replace(/^sha256:/, "") || null },
    setup: setup?.browser_download_url || null,
  };
}

/** Latest release info (cached for 6 h unless `force`). */
export async function checkUpdate({ force = false } = {}) {
  const cached = loadState().update;
  let latest = cached?.latest;
  if (force || !cached || Date.now() - new Date(cached.checkedAt).getTime() > CHECK_INTERVAL) {
    latest = await fetchLatest();
    updateState((s) => { s.update = { checkedAt: new Date().toISOString(), latest }; });
  }
  const current = currentVersion();
  const kind = installKind();
  return {
    current,
    latest: latest?.version || null,
    available: !!latest && isNewer(latest.version, current),
    notes: latest?.notes || "",
    url: latest?.url || `https://github.com/${REPO}/releases`,
    setup: latest?.setup || null,
    kind,
    canInstall: kind !== "dev" && !!latest?.zip,
  };
}

async function download(url, file) {
  const r = await fetch(url, { headers: { "User-Agent": "GameBoost-Updater" }, redirect: "follow", signal: AbortSignal.timeout(5 * 60 * 1000) });
  if (!r.ok) throw new Error(`Download fehlgeschlagen (${r.status})`);
  const buf = Buffer.from(await r.arrayBuffer());
  writeFileSync(file, buf);
  return buf;
}

/** Downloads the release zip, verifies it and replaces the app files. */
export async function installUpdate() {
  const info = await checkUpdate({ force: true });
  if (info.kind === "dev") throw new Error("Entwicklungsversion (Git-Checkout) – bitte mit „git pull“ aktualisieren.");
  if (!info.available) return { updated: false, current: info.current, latest: info.latest };
  const latest = loadState().update.latest;
  if (!latest.zip) throw new Error("Das Release enthält kein App-Paket – bitte den Installer verwenden.");

  const work = join(DATA_DIR, "tmp", `update-${randomBytes(4).toString("hex")}`);
  mkdirSync(work, { recursive: true });
  try {
    const zipFile = join(work, "app.zip");
    const buf = await download(latest.zip.url, zipFile);
    if (latest.zip.size && buf.length !== latest.zip.size) throw new Error("Download unvollständig");
    if (latest.zip.sha256) {
      const hash = createHash("sha256").update(buf).digest("hex");
      if (hash !== latest.zip.sha256) throw new Error("Prüfsumme des Downloads stimmt nicht – Update abgebrochen.");
    }
    const staging = join(work, "app");
    await runPS(String.raw`Expand-Archive -LiteralPath $GB_IN.zip -DestinationPath $GB_IN.dest -Force; GB-Out @{ ok = $true }`, { zip: zipFile, dest: staging });
    // The zip may contain the files directly or inside a single folder.
    let src = staging;
    if (!existsSync(join(src, "package.json"))) {
      const sub = readdirSync(staging).find((d) => existsSync(join(staging, d, "package.json")));
      if (!sub) throw new Error("Ungültiges Update-Paket");
      src = join(staging, sub);
    }
    const version = JSON.parse(readFileSync(join(src, "package.json"), "utf8")).version;
    if (version !== latest.version) throw new Error(`Paket hat Version ${version}, erwartet ${latest.version}`);
    for (const d of APP_DIRS) if (!existsSync(join(src, d))) throw new Error(`Update-Paket unvollständig (${d} fehlt)`);

    // Copy everything next to the app first, then swap – a failed copy leaves the old version intact.
    for (const d of APP_DIRS) {
      rmSync(join(ROOT, `${d}.new`), { recursive: true, force: true });
      cpSync(join(src, d), join(ROOT, `${d}.new`), { recursive: true });
    }
    for (const d of APP_DIRS) {
      rmSync(join(ROOT, d), { recursive: true, force: true });
      renameSync(join(ROOT, `${d}.new`), join(ROOT, d));
    }
    for (const f of APP_FILES) if (existsSync(join(src, f))) cpSync(join(src, f), join(ROOT, f));
    updateState((s) => logHistory(s, { action: "update", name: `${info.current} → ${version}` }));
    return { updated: true, from: info.current, to: version };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
