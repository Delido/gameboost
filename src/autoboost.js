// Auto-Boost: a background watcher (started at logon by a scheduled task with highest privileges)
// that starts the Game Boost as soon as a library game runs – no matter whether it was started
// via GameBoost, Steam, Epic or a desktop shortcut – and ends it when the game exits.
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadState, updateState, logHistory, DATA_DIR } from "./state.js";
import { registerTask, unregisterTask, getTasks, TASKS } from "./schedule.js";

const PID_FILE = join(DATA_DIR, "autoboost.pid");
const POLL_MS = 5000;

function runningPid() {
  try {
    const pid = Number(readFileSync(PID_FILE, "utf8"));
    if (pid && pid !== process.pid) { process.kill(pid, 0); return pid; }
  } catch {}
  return null;
}

function processNames() {
  return new Promise((resolve) => {
    execFile("tasklist", ["/FO", "CSV", "/NH"], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, out) => {
      if (err) return resolve(null);
      resolve(new Set(String(out).split(/\r?\n/).map((l) => l.match(/^"([^"]+)"/)?.[1]?.toLowerCase()).filter(Boolean)));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The watcher loop. `execute` is injected to avoid a circular import with commands.js. */
export async function runAutoBoost(execute) {
  if (runningPid()) return { alreadyRunning: true };
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(PID_FILE, String(process.pid));
  const cleanup = () => { try { if (Number(readFileSync(PID_FILE, "utf8")) === process.pid) unlinkSync(PID_FILE); } catch {} };
  process.on("exit", cleanup);
  let misses = 0;
  let prev = null;         // game process of the auto session seen in the previous poll
  let stoppedByUs = false;
  let suppressed = null;   // game whose boost the user ended manually while it was still running

  while (loadState().config.autoBoost.enabled) {
    await sleep(POLL_MS);
    const names = await processNames();
    if (!names) continue;
    const state = loadState();
    if (suppressed && !names.has(suppressed.toLowerCase())) suppressed = null;
    if (prev && !state.session && !stoppedByUs && names.has(prev.toLowerCase())) suppressed = prev;
    stoppedByUs = false;

    if (!state.session) {
      const game = state.games.find((g) => g.boost && g.processName && g.processName !== suppressed && names.has(g.processName.toLowerCase()));
      if (game) {
        misses = 0;
        try { await execute(["boost", "start", "--game", game.id, "--watch", game.processName, "--auto"]); } catch {}
      }
    } else if (state.session.auto && state.session.watchProcess) {
      if (names.has(state.session.watchProcess.toLowerCase())) misses = 0;
      else if (++misses >= 3) {
        misses = 0;
        stoppedByUs = true;
        try { await execute(["boost", "stop"]); } catch {}
      }
    }
    prev = state.session?.auto ? state.session.watchProcess : null;
  }
  cleanup();
  return { stopped: true };
}

export async function autoBoostStatus() {
  const tasks = await getTasks();
  return { enabled: loadState().config.autoBoost.enabled, task: tasks[TASKS.autoboost] || null, running: !!runningPid() };
}

export async function enableAutoBoost() {
  updateState((s) => {
    s.config.autoBoost.enabled = true;
    logHistory(s, { action: "autoboost", name: "Aktiviert" });
  });
  await registerTask({ name: TASKS.autoboost, args: "autoboost run", schedule: "logon", description: "GameBoost: startet den Game Boost automatisch, sobald ein Spiel aus der Bibliothek läuft.", startNow: true });
  return autoBoostStatus();
}

export async function disableAutoBoost() {
  updateState((s) => {
    s.config.autoBoost.enabled = false;
    logHistory(s, { action: "autoboost", name: "Deaktiviert" });
  });
  await unregisterTask(TASKS.autoboost);
  const pid = runningPid();
  if (pid) try { process.kill(pid); } catch {}
  return autoBoostStatus();
}
