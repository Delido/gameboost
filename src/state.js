// Persistent state: original values (backups), boost session, games and settings.
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";

export const DATA_DIR = join(process.env.LOCALAPPDATA || join(process.env.USERPROFILE || ".", "AppData", "Local"), "GameBoost");
const STATE_FILE = join(DATA_DIR, "state.json");

export const DEFAULT_CONFIG = {
  boost: {
    // Services stopped temporarily during a boost session (restarted afterwards).
    services: ["SysMain", "WSearch", "Spooler", "DiagTrack", "MapsBroker", "WerSvc", "wuauserv", "BITS", "DoSvc"],
    // Processes closed during a boost session (restarted afterwards, if they were running).
    processes: ["OneDrive.exe", "PhoneExperienceHost.exe", "Widgets.exe", "WidgetService.exe", "Teams.exe", "ms-teams.exe", "YourPhone.exe", "GoogleDriveFS.exe", "Dropbox.exe", "AdobeCollabSync.exe"],
    powerPlan: true,
    clearStandby: true,
    flushDns: true,
    restartProcesses: true,
  },
  // Background watcher that starts the boost as soon as a library game runs (also via Steam/Epic).
  autoBoost: {
    enabled: false,
  },
};

function defaults() {
  return {
    version: 1, backups: {}, session: null, games: [], config: structuredClone(DEFAULT_CONFIG), history: [],
    startupDeleted: [], startupServices: [], dnsBackup: null, benchmarks: [], update: null,
  };
}

export function loadState() {
  if (!existsSync(STATE_FILE)) return defaults();
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    const d = defaults();
    const config = { ...d.config, ...s.config };
    for (const section of Object.keys(d.config)) config[section] = { ...d.config[section], ...(s.config?.[section] || {}) };
    return { ...d, ...s, config };
  } catch {
    return defaults();
  }
}

export function saveState(state) {
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = STATE_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  renameSync(tmp, STATE_FILE);
}

/** Load, mutate, save. */
export function updateState(fn) {
  const s = loadState();
  const r = fn(s);
  saveState(s);
  return r;
}

export function logHistory(state, entry) {
  state.history.unshift({ at: new Date().toISOString(), ...entry });
  state.history = state.history.slice(0, 200);
}
