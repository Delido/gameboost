// Large file finder, deleting to the recycle bin and "show in Explorer".
import { opendir, lstat } from "node:fs/promises";
import { join, resolve, parse, sep } from "node:path";
import { spawn } from "node:child_process";
import { runPS } from "./ps.js";
import { updateState, logHistory } from "./state.js";

const SKIP_DIRS = new Set(["$recycle.bin", "system volume information", "windows", "winsxs", "$windows.~bt", "$windows.~ws", "config.msi"]);

/** Largest files below `root` (default: user profile). Stops after `timeLimit` ms. */
export async function findLargeFiles({ root = process.env.USERPROFILE, minMB = 200, limit = 100, timeLimit = 90000 } = {}) {
  root = resolve(root);
  const minBytes = minMB * 1024 * 1024;
  const deadline = Date.now() + timeLimit;
  const found = [];
  let scanned = 0;
  let truncated = false;
  const stack = [root];
  while (stack.length) {
    if (Date.now() > deadline) { truncated = true; break; }
    const dir = stack.pop();
    let handle;
    try { handle = await opendir(dir); } catch { continue; }
    for await (const e of handle) {
      const p = join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name.toLowerCase())) stack.push(p);
      } else if (e.isFile()) {
        scanned++;
        try {
          const st = await lstat(p);
          if (st.size >= minBytes) found.push({ path: p, sizeMB: Math.round(st.size / 1048576), modified: st.mtime.toISOString() });
        } catch {}
      }
    }
  }
  found.sort((a, b) => b.sizeMB - a.sizeMB);
  return { root, scanned, truncated, files: found.slice(0, limit) };
}

const PROTECTED = () => {
  const env = process.env;
  return [env.SystemRoot, env.ProgramFiles, env["ProgramFiles(x86)"], env.ProgramData, env.USERPROFILE, env.APPDATA, env.LOCALAPPDATA, join(env.LOCALAPPDATA || "", "Programs"), join(env.USERPROFILE || "", "Documents"), join(env.USERPROFILE || "", "Desktop"), join(env.USERPROFILE || "", "Downloads")]
    .filter(Boolean).map((p) => resolve(p).toLowerCase());
};

/** Refuses drive roots, the Windows folder and well-known top-level folders. */
export function assertDeletable(path) {
  const p = resolve(String(path || ""));
  const lower = p.toLowerCase();
  if (!path || parse(p).root.toLowerCase() === lower || lower === parse(p).root.toLowerCase().replace(/\\$/, "")) throw new Error(`Laufwerkswurzel kann nicht gelöscht werden: ${p}`);
  const win = resolve(process.env.SystemRoot || "C:\\Windows").toLowerCase();
  if (lower === win || lower.startsWith(win + sep)) throw new Error(`Windows-Systemordner kann nicht gelöscht werden: ${p}`);
  if (PROTECTED().includes(lower)) throw new Error(`Geschützter Ordner: ${p}`);
  return p;
}

export function deleteNeedsAdmin(paths) {
  const home = resolve(process.env.USERPROFILE || "").toLowerCase();
  return paths.some((p) => !resolve(p).toLowerCase().startsWith(home + sep));
}

export const DELETE_PS = String.raw`
Add-Type -AssemblyName Microsoft.VisualBasic
$fs = [Microsoft.VisualBasic.FileIO.FileSystem]
$ui = [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs
$bin = [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin
$res = @()
foreach ($p in $GB_IN.paths) {
  try {
    if (Test-Path -LiteralPath $p -PathType Container) { $fs::DeleteDirectory($p, $ui, $bin) }
    elseif (Test-Path -LiteralPath $p -PathType Leaf) { $fs::DeleteFile($p, $ui, $bin) }
    else { throw 'Nicht gefunden' }
    $res += @{ path = $p; ok = $true }
  } catch { $res += @{ path = $p; ok = $false; error = $_.Exception.Message } }
}
GB-Out @{ results = $res }
`;

/** Moves files/folders to the recycle bin (restorable from there). */
export async function deleteToRecycleBin(paths) {
  const list = paths.map(assertDeletable);
  if (!list.length) throw new Error("Keine Pfade angegeben");
  const r = await runPS(DELETE_PS, { paths: list });
  updateState((s) => logHistory(s, { action: "files-delete", paths: r.results.filter((x) => x.ok).map((x) => x.path) }));
  return r.results;
}

export function reveal(path) {
  spawn("explorer.exe", [`/select,${resolve(path)}`], { detached: true, stdio: "ignore" }).unref();
  return { path };
}

/** Opens a settings page or website. Only ms-settings: and https: are allowed. */
export function openUri(uri) {
  if (!/^(ms-settings:[\w-]*|https:\/\/[^\s"]+)$/i.test(String(uri))) throw new Error(`Nicht erlaubt: ${uri}`);
  spawn("explorer.exe", [uri], { detached: true, stdio: "ignore" }).unref();
  return { uri };
}

/** Take ownership + full control (used by the "Besitz übernehmen" context menu entry). */
export async function takeOwnership(path) {
  const p = assertDeletable(path);
  const ps = String.raw`
    $p = $GB_IN.path
    $dir = Test-Path -LiteralPath $p -PathType Container
    if ($dir) { & takeown.exe /f $p /r /d y | Out-Null } else { & takeown.exe /f $p | Out-Null }
    if ($LASTEXITCODE -ne 0) { throw 'takeown fehlgeschlagen' }
    if ($dir) { & icacls.exe $p /grant '*S-1-5-32-544:F' /t /c /q | Out-Null } else { & icacls.exe $p /grant '*S-1-5-32-544:F' /c /q | Out-Null }
    GB-Out @{ ok = $true }`;
  await runPS(ps, { path: p }, { timeout: 30 * 60 * 1000 });
  updateState((s) => logHistory(s, { action: "take-ownership", paths: [p] }));
  return { path: p };
}
