import { getPreferenceValues, Icon, Color, Image } from "@raycast/api";
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, userInfo } from "node:os";

// ───────────── Types (mirror the GameBoost CLI JSON output) ─────────────
export type Risk = "safe" | "moderate" | "advanced";
export type Reboot = "none" | "explorer" | "logoff" | "reboot";
export type Status = "applied" | "partial" | "default" | "unavailable" | "unknown";

export interface Tweak {
  id: string;
  category: string;
  title: string;
  description: string;
  risk: Risk;
  reboot: Reboot;
  impact: number;
  admin: boolean;
  status: Status;
  errors: string[];
  hasBackup: boolean;
  optional?: boolean;
}
export interface Category { id: string; title: string; icon: string; description: string; optional?: boolean }
export interface Preset { id: string; title: string; description: string; icon: string; tweaks: string[] }
export interface Action { id: string; title: string; description: string; icon: string; admin: boolean; group?: string; timeout?: number }
export interface TweakResult { id: string; title: string; ok: boolean; errors: string[]; reboot: Reboot }
export interface Session { startedAt: string; stoppedServices: string[]; killed: { name: string }[]; ramFreed: number; gameId: string | null; watchProcess: string | null }
export interface Game { id: string; name: string; target: string; exePath: string | null; processName: string | null; highPriority: boolean; gpuHighPerf: boolean; boost: boolean; source: string; lastPlayed?: string }
export interface ScannedGame { name: string; source: "steam" | "epic"; target: string; exePath: string | null; processName: string | null }
export type StartupType = "run" | "folder" | "runonce" | "appx" | "task" | "service";
export interface StartupItem { id: string; type: StartupType; name: string; command: string; scope: string; enabled: boolean; admin: boolean; canToggle: boolean; canDelete: boolean; publisher: string; broken: boolean }
export interface DeletedStartupItem { backupId: string; itemId: string; name: string; type: StartupType; scope: string; command: string; deletedAt: string }
export interface CtxItem { id: string; kind: "extension" | "verb" | "app"; name: string; publisher: string; path: string; locations: string[]; enabled: boolean }
export interface Check { id: string; group: string; title: string; status: "ok" | "info" | "warn" | "bad"; detail: string; fix: { type: "uri" | "url" | "action" | "tweak"; value: string; label: string } | null }
export interface SysInfo {
  computer: string;
  os: { name: string; build: number; uptimeHours: number };
  cpu: { name: string; cores: number; threads: number; load: number | null };
  ram: { totalGB: number; freeGB: number };
  gpus: { name: string; driver: string; vramGB: number; refresh: number; resolution: string }[];
  disks: { letter: string; label: string; sizeGB: number; freeGB: number; media: string }[];
  powerPlan: { name: string };
  isAdmin: boolean;
  isLaptop: boolean;
}
export interface StatusData { info: SysInfo; score: number; applied: number; total: number; session: Session | null; games: number }

// ───────────── CLI bridge ─────────────
interface Prefs { projectPath?: string; nodePath?: string }

// Raycast may start extensions without the usual Windows environment variables,
// so derive the user folders from the home directory when they are missing.
function home(): string {
  return process.env.USERPROFILE || homedir() || userInfo().homedir;
}
function localAppData(): string {
  return process.env.LOCALAPPDATA || join(home(), "AppData", "Local");
}
const LOCATION_FILE = () => join(localAppData(), "GameBoost", "location.json");

/** Folder the GameBoost CLI was last run from (written by the CLI on every start). */
function lastKnownRoot(): string | undefined {
  try {
    return JSON.parse(readFileSync(LOCATION_FILE(), "utf8")).root;
  } catch {
    return undefined;
  }
}

/** Environment for the CLI child process, so it uses the same data folder as when run manually. */
function childEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    USERPROFILE: home(),
    LOCALAPPDATA: localAppData(),
    APPDATA: process.env.APPDATA || join(home(), "AppData", "Roaming"),
    SystemRoot: process.env.SystemRoot || "C:\\Windows",
    windir: process.env.windir || process.env.SystemRoot || "C:\\Windows",
    // Without PATHEXT, PowerShell resolves `powercfg` to powercfg.cpl (opens the Control Panel).
    PATHEXT: ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC",
  };
}

function paths() {
  const prefs = getPreferenceValues<Prefs>();
  const roots = [prefs.projectPath?.trim(), lastKnownRoot()].filter((r): r is string => !!r);
  const cli = roots.map((r) => join(r, "bin", "gameboost.js")).find((p) => existsSync(p));
  if (!cli) {
    throw new Error(
      roots.length
        ? `GameBoost nicht gefunden in: ${roots.join(", ")} – bitte in den Extension-Einstellungen den Ordner prüfen.`
        : `GameBoost-Ordner unbekannt (${LOCATION_FILE()} fehlt) – einmal „node bin\\gameboost.js status“ im GameBoost-Ordner ausführen oder den Ordner in den Extension-Einstellungen setzen.`,
    );
  }
  // Installed via setup: bundled runtime next to bin\gameboost.js
  const bundled = join(cli, "..", "..", "runtime", "node.exe");
  const candidates = [prefs.nodePath, bundled, join(process.env.ProgramFiles || "C:\\Program Files", "nodejs", "node.exe"), join(localAppData(), "Programs", "nodejs", "node.exe")];
  const node = candidates.find((p) => p && existsSync(p)) || "node";
  return { node, cli };
}

/** Run a GameBoost CLI command and return its `data`. UAC prompts appear automatically when needed. */
export function gb<T>(args: string[], timeoutMs = 10 * 60 * 1000): Promise<T> {
  const { node, cli } = paths();
  return new Promise((resolve, reject) => {
    execFile(node, [cli, ...args, "--json"], { windowsHide: true, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, env: childEnv() }, (err, stdout, stderr) => {
      const line = String(stdout || "").trim().split(/\r?\n/).filter(Boolean).pop();
      if (line) {
        try {
          const res = JSON.parse(line) as { ok: boolean; data?: T; error?: string };
          return res.ok ? resolve(res.data as T) : reject(new Error(res.error || "Unbekannter Fehler"));
        } catch {
          /* fall through */
        }
      }
      reject(new Error((stderr || err?.message || "Keine Antwort von GameBoost").toString().trim()));
    });
  });
}

/** Start the desktop UI (detached). */
export function openApp() {
  const { node, cli } = paths();
  spawn(node, [cli, "ui"], { detached: true, stdio: "ignore", windowsHide: true, env: childEnv() }).unref();
}

// ───────────── Presentation helpers ─────────────
export const RISK_LABEL: Record<Risk, string> = { safe: "Sicher", moderate: "Moderat", advanced: "Fortgeschritten" };
export const RISK_COLOR: Record<Risk, Color> = { safe: Color.Green, moderate: Color.Yellow, advanced: Color.Red };
export const REBOOT_LABEL: Record<Reboot, string> = { none: "Sofort", explorer: "Explorer-Neustart", logoff: "Neuanmeldung", reboot: "Neustart" };

export function statusIcon(s: Status): Image.ImageLike {
  switch (s) {
    case "applied": return { source: Icon.CheckCircle, tintColor: Color.Green };
    case "partial": return { source: Icon.CircleProgress50, tintColor: Color.Blue };
    case "unavailable": return { source: Icon.Minus, tintColor: Color.SecondaryText };
    case "unknown": return { source: Icon.QuestionMarkCircle, tintColor: Color.SecondaryText };
    default: return { source: Icon.Circle, tintColor: Color.SecondaryText };
  }
}

export const STATUS_LABEL: Record<Status, string> = { applied: "Aktiv", partial: "Teilweise", default: "Standard", unavailable: "Nicht verfügbar", unknown: "Unbekannt" };

export const CATEGORY_ICON: Record<string, Icon> = {
  gaming: Icon.GameController,
  power: Icon.Bolt,
  network: Icon.Network,
  input: Icon.Mouse,
  services: Icon.Gear,
  privacy: Icon.Shield,
  visual: Icon.Stars,
  system: Icon.MemoryChip,
  contextmenu: Icon.Sidebar,
};

export function summarize(results: TweakResult[], verb: string) {
  const ok = results.filter((r) => r.ok);
  const bad = results.filter((r) => !r.ok);
  const reboot = ok.some((r) => r.reboot === "reboot");
  const title = ok.length === 1 ? `${ok[0].title} ${verb}` : `${ok.length} Optimierungen ${verb}`;
  const message = [bad.length ? `${bad.length} fehlgeschlagen: ${bad.map((b) => b.title).join(", ")}` : "", reboot ? "Neustart erforderlich" : ""].filter(Boolean).join(" · ");
  return { title, message, failed: bad.length > 0 };
}

export function sessionText(s: Session) {
  return `${s.stoppedServices.length} Dienste pausiert · ${s.killed.length} Apps beendet · ${s.ramFreed} MB RAM frei`;
}
