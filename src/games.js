// Game library: per-game CPU priority (IFEO), GPU preference, launch with boost and
// import of installed Steam / Epic games.
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { randomBytes } from "node:crypto";
import { runPS } from "./ps.js";
import { loadState, updateState, logHistory } from "./state.js";
import { isAdmin } from "./system.js";

const IFEO = String.raw`SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options`;
const GPU_PREF = String.raw`Software\Microsoft\DirectX\UserGpuPreferences`;

export const PROFILE_PS = String.raw`
$g = $GB_IN.game
$res = @{}
if ($GB_IN.mode -eq 'apply') {
  if ($g.highPriority -and $g.processName) {
    $p = "${IFEO}\$($g.processName)\PerfOptions"
    $res.priority = GB-RegGet 'HKLM' $p 'CpuPriorityClass'
    GB-RegSet 'HKLM' $p 'CpuPriorityClass' 'DWord' 3
  }
  if ($g.gpuHighPerf -and $g.exePath) {
    $res.gpu = GB-RegGet 'HKCU' '${GPU_PREF}' $g.exePath
    GB-RegSet 'HKCU' '${GPU_PREF}' $g.exePath 'String' 'GpuPreference=2;'
  }
} else {
  $b = $g.backup
  if ($g.processName -and $b.priority) {
    $p = "${IFEO}\$($g.processName)\PerfOptions"
    if ($b.priority.exists) { GB-RegSet 'HKLM' $p 'CpuPriorityClass' $b.priority.kind $b.priority.value }
    else {
      GB-RegDel 'HKLM' $p 'CpuPriorityClass'
      $k = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey($p)
      if ($k) { $empty = $k.ValueCount -eq 0 -and $k.SubKeyCount -eq 0; $k.Close(); if ($empty) { [Microsoft.Win32.Registry]::LocalMachine.DeleteSubKey($p, $false) } }
    }
  }
  if ($g.exePath -and $b.gpu) {
    if ($b.gpu.exists) { GB-RegSet 'HKCU' '${GPU_PREF}' $g.exePath $b.gpu.kind $b.gpu.value } else { GB-RegDel 'HKCU' '${GPU_PREF}' $g.exePath }
  }
}
GB-Out $res
`;

export function listGames() {
  return loadState().games;
}

export function getGame(id) {
  const g = loadState().games.find((x) => x.id === id || x.name.toLowerCase() === String(id).toLowerCase());
  if (!g) throw new Error(`Spiel nicht gefunden: ${id}`);
  return g;
}

/**
 * Add a game. `target` is an .exe path or a launcher URL (steam://, com.epicgames.launcher://).
 * `processName` is the exe that runs while playing (used for priority + auto-stop of the boost).
 */
export async function addGame({ name, target, processName, exePath, args = "", highPriority = true, gpuHighPerf = true, boost = true, source = "manual" }) {
  if (!target) throw new Error("Pfad zur .exe oder Launcher-URL fehlt");
  const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(target) && !/^[a-z]:\\/i.test(target);
  if (!isUrl && !existsSync(target)) throw new Error(`Datei nicht gefunden: ${target}`);
  exePath = exePath || (isUrl ? null : target);
  processName = processName || (exePath ? basename(exePath) : null);
  const game = {
    id: randomBytes(4).toString("hex"),
    name: name || (processName ? processName.replace(/\.exe$/i, "") : target),
    target, exePath, processName, args, highPriority, gpuHighPerf, boost, source,
    addedAt: new Date().toISOString(),
  };
  game.backup = await runPS(PROFILE_PS, { mode: "apply", game });
  updateState((s) => {
    s.games.push(game);
    logHistory(s, { action: "game-add", game: game.name });
  });
  return game;
}

export async function removeGame(id) {
  const game = getGame(id);
  await runPS(PROFILE_PS, { mode: "revert", game });
  updateState((s) => {
    s.games = s.games.filter((g) => g.id !== game.id);
    logHistory(s, { action: "game-remove", game: game.name });
  });
  return game;
}

/** Launch the game with the rights of the calling process (call this from the non-elevated side). */
export async function launchProcess(game) {
  const elevated = await isAdmin();
  const ps = String.raw`
    $g = $GB_IN.game
    $isUrl = $g.target -match '^[a-zA-Z][a-zA-Z0-9+.-]*://'
    if ($isUrl) { Start-Process $g.target }
    elseif ($GB_IN.elevated -and -not $g.args) { Start-Process explorer.exe -ArgumentList ('"' + $g.target + '"') }
    else {
      $wd = Split-Path -Parent $g.target
      if ($g.args) { Start-Process -FilePath $g.target -ArgumentList $g.args -WorkingDirectory $wd } else { Start-Process -FilePath $g.target -WorkingDirectory $wd }
    }
    GB-Out @{ ok = $true }`;
  await runPS(ps, { game, elevated });
}

// ───────────── Library scan (Steam / Epic) ─────────────

const SKIP_EXE = /(unins|crash|report|redist|setup|install|launcher|helper|update|vc_|dxsetup|ue4prereq|easyanticheat|battleye|prereq|cefprocess|webhelper|dotnet|vcredist|vconsole|hammer|editor|server|benchmark|config|tool)/i;
const SKIP_DIR = /^(_commonredist|redist|directx|support|__installer|tools|sdk)$/i;
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Most plausible game exe within 3 directory levels (name match > "-Shipping" > size). */
function guessExe(dir, gameName) {
  const words = gameName.split(/[^A-Za-z0-9]+/).filter((w) => w.length >= 3).map(norm);
  let best = null;
  const walk = (d, depth) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory() && depth < 3 && !SKIP_DIR.test(e.name)) walk(p, depth + 1);
      else if (e.isFile() && /\.exe$/i.test(e.name) && !SKIP_EXE.test(e.name)) {
        let size = 0; try { size = statSync(p).size; } catch {}
        const base = norm(e.name.replace(/\.exe$/i, ""));
        let score = size / 1e9;
        if (words.some((w) => base.includes(w) || w.includes(base))) score += 10;
        if (/shipping/i.test(e.name)) score += 20;
        if (!best || score > best.score) best = { path: p, score };
      }
    }
  };
  walk(dir, 0);
  return best?.path || null;
}

function parseVdfValues(text, key) {
  const re = new RegExp(`"${key}"\\s+"([^"]*)"`, "gi");
  return [...text.matchAll(re)].map((m) => m[1].replace(/\\\\/g, "\\"));
}

function steamRoot() {
  const candidates = [
    join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Steam"),
    join(process.env.ProgramFiles || "C:\\Program Files", "Steam"),
  ];
  return candidates.find((p) => existsSync(join(p, "steamapps")));
}

function scanSteam() {
  const root = steamRoot();
  if (!root) return [];
  let libs = [root];
  const lf = join(root, "steamapps", "libraryfolders.vdf");
  if (existsSync(lf)) libs = [...new Set([root, ...parseVdfValues(readFileSync(lf, "utf8"), "path")])];
  const out = [];
  for (const lib of libs) {
    const apps = join(lib, "steamapps");
    let files = [];
    try { files = readdirSync(apps).filter((f) => /^appmanifest_\d+\.acf$/.test(f)); } catch { continue; }
    for (const f of files) {
      const txt = readFileSync(join(apps, f), "utf8");
      const [appid] = parseVdfValues(txt, "appid");
      const [name] = parseVdfValues(txt, "name");
      const [installdir] = parseVdfValues(txt, "installdir");
      if (!appid || !name || /steamworks|redistributable|proton|soundtrack/i.test(name) || appid === "228980") continue;
      const dir = join(apps, "common", installdir || "");
      const exe = existsSync(dir) ? guessExe(dir, `${name} ${installdir}`) : null;
      out.push({ name, source: "steam", target: `steam://rungameid/${appid}`, exePath: exe, processName: exe ? basename(exe) : null });
    }
  }
  return out;
}

function scanEpic() {
  const dir = join(process.env.ProgramData || "C:\\ProgramData", "Epic", "EpicGamesLauncher", "Data", "Manifests");
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".item"))) {
    try {
      const m = JSON.parse(readFileSync(join(dir, f), "utf8"));
      if (!m.bIsApplication || !m.LaunchExecutable) continue;
      const exe = join(m.InstallLocation, m.LaunchExecutable);
      out.push({
        name: m.DisplayName,
        source: "epic",
        target: `com.epicgames.launcher://apps/${encodeURIComponent(`${m.CatalogNamespace}:${m.CatalogItemId}:${m.AppName}`)}?action=launch&silent=true`,
        exePath: existsSync(exe) ? exe : null,
        processName: basename(m.LaunchExecutable),
      });
    } catch {}
  }
  return out;
}

/** Installed games that are not yet in the library. */
export function scanLibrary() {
  const known = new Set(loadState().games.map((g) => g.target.toLowerCase()));
  return [...scanSteam(), ...scanEpic()]
    .filter((g) => !known.has(g.target.toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name));
}

