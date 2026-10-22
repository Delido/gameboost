// Command dispatcher shared by the CLI, the desktop UI server and (via CLI) Raycast.
// `execute` transparently elevates commands that need administrator rights.
import { TWEAKS, CATEGORIES, PRESETS, presetTweaks, RISK_LABEL, REBOOT_LABEL } from "./catalog.js";
import * as engine from "./engine.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { randomBytes } from "node:crypto";
import { runAction, publicActions, getAction, GROUPS } from "./actions.js";
import { startBoost, stopBoost, sessionStatus, spawnWatcher, watch } from "./boost.js";
import { listGames, addGame, removeGame, getGame, launchProcess, scanLibrary } from "./games.js";
import { sysinfo, isAdmin } from "./system.js";
import { listStartup, setStartup, deleteStartup, restoreStartup, listDeletedStartup, startupNeedsAdmin, restoreNeedsAdmin } from "./startup.js";
import { listContextMenu, setContextMenu } from "./contextmenu.js";
import { runChecks } from "./checks.js";
import { listPrograms, uninstallProgram, findLeftovers, listBloat, removeBloat } from "./apps.js";
import { findLargeFiles, deleteToRecycleBin, deleteNeedsAdmin, reveal, openUri, takeOwnership } from "./files.js";
import { getDns, setDns, benchDns, ping, DNS_PROVIDERS } from "./network.js";
import { getTasks, setMaintenanceSchedule, TASKS } from "./schedule.js";
import { runAutoBoost, autoBoostStatus, enableAutoBoost, disableAutoBoost } from "./autoboost.js";
import { runBenchmark, listBenchmarks, clearBenchmarks } from "./bench.js";
import { exportProfile, writeProfile, readProfile, importProfile } from "./profile.js";
import { runPS } from "./ps.js";
import { loadState, updateState, DEFAULT_CONFIG, DATA_DIR } from "./state.js";
import { runElevated } from "./elevate.js";
import { installShortcuts, removeShortcuts } from "./install.js";
import { checkUpdate, installUpdate, currentVersion } from "./update.js";

const VALUE_FLAGS = new Set(["preset", "category", "port", "out", "game", "watch", "name", "args", "process", "exe", "path", "min", "count", "file", "b64", "publisher", "location"]);

export function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (VALUE_FLAGS.has(key)) flags[key] = argv[++i];
      else flags[key] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}

const tweakIds = (pos, flags) => {
  if (flags.preset) return presetTweaks(flags.preset);
  if (flags.category) return TWEAKS.filter((t) => t.category === flags.category).map((t) => t.id);
  if (pos.length === 0) throw new Error("Keine Optimierung angegeben (IDs, --preset oder --category)");
  return pos;
};

/** Command table: admin(pos, flags) decides whether elevation is needed. */
const COMMANDS = {
  status: {
    admin: () => false,
    run: async () => {
      const [info, tweaks] = await Promise.all([sysinfo(), engine.detect()]);
      const state = loadState();
      return {
        info,
        score: engine.score(tweaks),
        applied: tweaks.filter((t) => t.status === "applied" && !t.optional).length,
        total: tweaks.filter((t) => t.status !== "unavailable" && !t.optional).length,
        session: state.session,
        games: state.games.length,
      };
    },
  },
  list: {
    admin: () => false,
    run: async (pos, flags) => {
      const tweaks = await engine.detect(flags.category ? TWEAKS.filter((t) => t.category === flags.category).map((t) => t.id) : null);
      // The score only makes sense for performance categories (not e.g. the context menu).
      const scored = tweaks.some((t) => !t.optional);
      return { categories: CATEGORIES, tweaks, score: scored ? engine.score(tweaks) : null };
    },
  },
  catalog: {
    admin: () => false,
    run: async () => ({
      categories: CATEGORIES, presets: PRESETS, tweaks: TWEAKS.map(engine.publicTweak), actions: publicActions(), actionGroups: GROUPS,
      riskLabels: RISK_LABEL, rebootLabels: REBOOT_LABEL, dnsProviders: DNS_PROVIDERS,
    }),
  },
  presets: {
    admin: () => false,
    run: async () => PRESETS.map((p) => ({ ...p, tweaks: presetTweaks(p.id) })),
  },
  apply: {
    admin: (pos, flags) => engine.needsAdmin(tweakIds(pos, flags)) || !!flags["restore-point"],
    run: async (pos, flags) => {
      let restorePoint = null;
      if (flags["restore-point"]) {
        try { restorePoint = (await runAction("restore-point")).message; } catch (e) { restorePoint = `Fehlgeschlagen: ${e.message}`; }
      }
      return { results: await engine.apply(tweakIds(pos, flags)), restorePoint };
    },
  },
  revert: {
    admin: (pos, flags) => flags.all ? Object.keys(loadState().backups).length > 0 : engine.needsAdmin(tweakIds(pos, flags)),
    run: async (pos, flags) => ({ results: flags.all ? await engine.revertAll() : await engine.revert(tweakIds(pos, flags)) }),
  },
  actions: {
    admin: () => false,
    run: async () => publicActions(),
  },
  run: {
    admin: (pos) => getAction(pos[0]).admin,
    run: async (pos) => runAction(pos[0]),
  },
  boost: {
    admin: (pos) => ["start", "stop", "toggle"].includes(pos[0] || "status"),
    run: async (pos, flags) => {
      const sub = pos[0] || "status";
      if (sub === "status") return { active: !!sessionStatus(), session: sessionStatus() };
      const doStart = sub === "start" || (sub === "toggle" && !sessionStatus());
      if (doStart) {
        const r = await startBoost({ gameId: flags.game || null, watchProcess: flags.watch || null, auto: !!flags.auto });
        // Auto-Boost sessions are ended by the Auto-Boost watcher itself.
        if (!r.alreadyActive && flags.watch && !flags.auto) spawnWatcher(flags.watch);
        return { active: true, started: !r.alreadyActive, ...r };
      }
      return { active: false, ...(await stopBoost()) };
    },
  },
  watch: {
    admin: () => false,
    run: async (pos) => watch(pos[0]),
  },
  games: {
    admin: (pos, flags) => {
      const sub = pos[0] || "list";
      if (sub === "add") return !flags["no-priority"];
      if (sub === "import") return true;
      if (sub === "remove") return !!getGame(pos[1]).backup?.priority;
      return false;
    },
    run: async (pos, flags) => {
      const sub = pos[0] || "list";
      switch (sub) {
        case "list": return listGames();
        case "scan": return scanLibrary();
        case "add":
          return addGame({
            target: pos[1], name: flags.name, args: flags.args || "", processName: flags.process, exePath: flags.exe,
            highPriority: !flags["no-priority"], gpuHighPerf: !flags["no-gpu"], boost: !flags["no-boost"],
          });
        case "import": {
          // Import scanned games by name (or all with --all)
          const found = scanLibrary();
          const pick = flags.all ? found : found.filter((g) => pos.slice(1).some((n) => g.name.toLowerCase() === n.toLowerCase()));
          const added = [];
          for (const g of pick) added.push(await addGame({ ...g, highPriority: !!g.processName, gpuHighPerf: !!g.exePath }));
          return added;
        }
        case "remove": return removeGame(pos[1]);
        case "launch": {
          const game = getGame(pos[1]);
          let boost = null;
          if (game.boost && !flags["no-boost"]) {
            const args = ["boost", "start", "--game", game.id];
            if (game.processName) args.push("--watch", game.processName);
            boost = await execute(args);
          }
          await launchProcess(game);
          updateState((s) => { const g = s.games.find((x) => x.id === game.id); if (g) g.lastPlayed = new Date().toISOString(); });
          return { game, boost };
        }
        default: throw new Error(`Unbekannter Unterbefehl: games ${sub}`);
      }
    },
  },
  startup: {
    admin: (pos) => (["enable", "disable", "delete"].includes(pos[0]) && startupNeedsAdmin(pos[1])) || (pos[0] === "restore" && restoreNeedsAdmin(pos[1])),
    run: async (pos) => {
      const sub = pos[0] || "list";
      if (sub === "list") return listStartup();
      if (sub === "enable" || sub === "disable") return setStartup(pos[1], sub === "enable");
      if (sub === "delete") return deleteStartup(pos[1]);
      if (sub === "deleted") return listDeletedStartup();
      if (sub === "restore") return restoreStartup(pos[1]);
      throw new Error(`Unbekannter Unterbefehl: startup ${sub}`);
    },
  },
  ctx: {
    admin: () => false,
    run: async (pos, flags) => {
      const sub = pos[0] || "list";
      if (sub === "list") return listContextMenu({ all: !!flags.all });
      if (sub === "enable" || sub === "disable") return setContextMenu(pos[1], sub === "enable", flags.name);
      throw new Error(`Unbekannter Unterbefehl: ctx ${sub}`);
    },
  },
  check: {
    admin: () => false,
    run: async () => runChecks(),
  },
  apps: {
    admin: () => false,
    run: async (pos, flags) => {
      const sub = pos[0] || "list";
      switch (sub) {
        case "list": return listPrograms();
        case "uninstall": return uninstallProgram(pos[1]);
        case "leftovers": return findLeftovers({ name: flags.name || pos[1], publisher: flags.publisher || "", location: flags.location || "" });
        case "bloat": return listBloat();
        case "remove-bloat": return removeBloat(pos[1]);
        default: throw new Error(`Unbekannter Unterbefehl: apps ${sub}`);
      }
    },
  },
  files: {
    admin: (pos) => pos[0] === "delete" && deleteNeedsAdmin(pos.slice(1)),
    run: async (pos, flags) => {
      const sub = pos[0] || "large";
      if (sub === "large") return findLargeFiles({ root: flags.path || process.env.USERPROFILE, minMB: Number(flags.min) || 200 });
      if (sub === "delete") return deleteToRecycleBin(pos.slice(1));
      if (sub === "reveal") return reveal(pos[1]);
      throw new Error(`Unbekannter Unterbefehl: files ${sub}`);
    },
  },
  open: {
    admin: () => false,
    run: async (pos) => openUri(pos[0]),
  },
  dns: {
    admin: (pos) => pos[0] === "set",
    run: async (pos) => {
      const sub = pos[0] || "get";
      if (sub === "get") return getDns();
      if (sub === "set") return setDns(pos[1]);
      if (sub === "bench") return benchDns();
      throw new Error(`Unbekannter Unterbefehl: dns ${sub}`);
    },
  },
  ping: {
    admin: () => false,
    run: async (pos, flags) => ping(pos[0] || "1.1.1.1", flags.count),
  },
  schedule: {
    admin: (pos) => pos[0] === "set",
    run: async (pos) => {
      const sub = pos[0] || "get";
      if (sub === "get") {
        const t = (await getTasks())[TASKS.maintenance];
        return { schedule: t ? t.schedule : "off", task: t };
      }
      if (sub === "set") return setMaintenanceSchedule(pos[1]);
      throw new Error(`Unbekannter Unterbefehl: schedule ${sub}`);
    },
  },
  autoboost: {
    admin: (pos) => ["enable", "disable"].includes(pos[0]),
    run: async (pos) => {
      const sub = pos[0] || "status";
      if (sub === "status") return autoBoostStatus();
      if (sub === "enable") return enableAutoBoost();
      if (sub === "disable") return disableAutoBoost();
      if (sub === "run") return runAutoBoost(execute);
      throw new Error(`Unbekannter Unterbefehl: autoboost ${sub}`);
    },
  },
  bench: {
    admin: () => false,
    run: async (pos) => {
      const sub = pos[0] || "run";
      if (sub === "run") return runBenchmark();
      if (sub === "list") return listBenchmarks();
      if (sub === "clear") return clearBenchmarks();
      throw new Error(`Unbekannter Unterbefehl: bench ${sub}`);
    },
  },
  profile: {
    admin: (pos, flags) => pos[0] === "import" && !flags.b64,
    run: async (pos, flags) => {
      const sub = pos[0] || "export";
      if (sub === "export") {
        const data = await exportProfile();
        return flags.file ? { ...writeProfile(data, flags.file), data } : data;
      }
      if (sub === "import") {
        // From the UI the file content arrives base64-encoded; write it to a temp file so that only
        // a short path has to be passed through the UAC elevation.
        if (flags.b64) {
          const data = JSON.parse(Buffer.from(flags.b64, "base64").toString("utf8"));
          if (data?.app !== "gameboost") throw new Error("Keine GameBoost-Exportdatei");
          const dir = join(DATA_DIR, "tmp");
          mkdirSync(dir, { recursive: true });
          const file = join(dir, `import-${randomBytes(4).toString("hex")}.json`);
          writeFileSync(file, JSON.stringify(data), "utf8");
          const extra = [flags["no-games"] && "--no-games", flags["no-config"] && "--no-config"].filter(Boolean);
          return execute(["profile", "import", file, ...extra]);
        }
        return importProfile(readProfile(pos[1]), { games: !flags["no-games"], config: !flags["no-config"] });
      }
      throw new Error(`Unbekannter Unterbefehl: profile ${sub}`);
    },
  },
  play: {
    admin: () => false,
    run: async (pos) => {
      let target = pos[0];
      let args = "";
      if (!target) throw new Error("Pfad zur .exe oder Verknüpfung fehlt");
      if (extname(target).toLowerCase() === ".lnk") {
        const r = await runPS(String.raw`$l = (New-Object -ComObject WScript.Shell).CreateShortcut($GB_IN.path); GB-Out @{ target = $l.TargetPath; args = $l.Arguments }`, { path: target });
        if (!r?.target) throw new Error("Verknüpfung zeigt auf kein Programm");
        target = r.target;
        args = r.args || "";
      }
      const lib = listGames().find((g) => g.exePath && g.exePath.toLowerCase() === target.toLowerCase());
      if (lib) return COMMANDS.games.run(["launch", lib.id], {});
      const game = { id: null, name: basename(target, extname(target)), target, exePath: target, processName: basename(target), args };
      const boost = await execute(["boost", "start", "--watch", game.processName]);
      await launchProcess(game);
      return { game, boost };
    },
  },
  own: {
    admin: () => true,
    run: async (pos) => takeOwnership(pos[0]),
  },
  config: {
    admin: () => false,
    run: async (pos) => {
      const sub = pos[0] || "get";
      if (sub === "get") return loadState().config;
      if (sub === "reset") return updateState((s) => (s.config = structuredClone(DEFAULT_CONFIG)));
      if (sub === "set") {
        // config set boost.services SysMain,WSearch   |   config set boost.powerPlan false
        const [, key, ...rest] = pos;
        const raw = rest.join(" ");
        return updateState((s) => {
          const [section, field] = key.split(".");
          if (!s.config[section] || !(field in s.config[section])) throw new Error(`Unbekannte Einstellung: ${key}`);
          const cur = s.config[section][field];
          s.config[section][field] = Array.isArray(cur) ? raw.split(",").map((x) => x.trim()).filter(Boolean) : typeof cur === "boolean" ? raw === "true" : raw;
          return s.config;
        });
      }
      throw new Error(`Unbekannter Unterbefehl: config ${sub}`);
    },
  },
  history: {
    admin: () => false,
    run: async () => loadState().history,
  },
  install: {
    admin: () => false,
    run: async (pos, flags) => installShortcuts({ desktop: !!flags.desktop }),
  },
  update: {
    admin: () => false,
    run: async (pos, flags) => {
      const sub = pos[0] || "check";
      if (sub === "check") return checkUpdate({ force: !!flags.force });
      if (sub === "install") return installUpdate();
      throw new Error(`Unbekannter Unterbefehl: update ${sub}`);
    },
  },
  version: {
    admin: () => false,
    run: async () => ({ version: currentVersion() }),
  },
  // Called by the uninstaller: shortcuts, own context menu entries and scheduled tasks.
  cleanup: {
    admin: () => false,
    run: async () => {
      const r = await removeShortcuts();
      const tasks = await getTasks();
      const errors = [];
      if (tasks[TASKS.autoboost]) await execute(["autoboost", "disable"]).catch((e) => errors.push(e.message));
      if (tasks[TASKS.maintenance]) await execute(["schedule", "set", "off"]).catch((e) => errors.push(e.message));
      return { removed: r?.removed || [], errors };
    },
  },
};

export function hasCommand(name) {
  return Object.hasOwn(COMMANDS, name);
}

/** Run a command (argv without node/script), elevating via UAC if necessary. */
export async function execute(argv) {
  const { pos, flags } = parseArgs(argv);
  const [name, ...rest] = pos;
  const cmd = COMMANDS[name];
  if (!cmd) throw new Error(`Unbekannter Befehl: ${name}`);
  if (cmd.admin(rest, flags) && !(await isAdmin())) {
    if (process.env.GB_ELEVATED === "1") throw new Error("Administratorrechte erforderlich");
    return runElevated(argv.filter((a, i) => a !== "--json" && !(argv[i - 1] === "--out") && a !== "--out"));
  }
  return cmd.run(rest, flags);
}
