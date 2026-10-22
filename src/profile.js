// Export/import of the GameBoost setup (active optimizations, boost settings, game library),
// e.g. to set up a second PC the same way.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { TWEAKS } from "./catalog.js";
import * as engine from "./engine.js";
import { loadState, updateState, logHistory } from "./state.js";
import { addGame } from "./games.js";

export async function exportProfile() {
  const state = loadState();
  const tweaks = (await engine.detect()).filter((t) => t.status === "applied").map((t) => t.id);
  return {
    app: "gameboost",
    version: 1,
    exportedAt: new Date().toISOString(),
    computer: process.env.COMPUTERNAME || "",
    tweaks,
    config: { boost: state.config.boost },
    games: state.games.map(({ name, target, exePath, processName, args, highPriority, gpuHighPerf, boost, source }) => ({ name, target, exePath, processName, args, highPriority, gpuHighPerf, boost, source })),
  };
}

export function writeProfile(data, file) {
  writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
  return { file };
}

export function readProfile(file) {
  const data = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""));
  if (data?.app !== "gameboost") throw new Error("Keine GameBoost-Exportdatei");
  return data;
}

/** Applies a profile. Games whose files don't exist on this PC are skipped. */
export async function importProfile(data, { games = true, config = true } = {}) {
  const known = new Set(TWEAKS.map((t) => t.id));
  const ids = (data.tweaks || []).filter((id) => known.has(id));
  const results = ids.length ? await engine.apply(ids) : [];
  if (config && data.config?.boost) {
    updateState((s) => { s.config.boost = { ...s.config.boost, ...data.config.boost }; });
  }
  const added = [];
  const skipped = [];
  if (games) {
    const have = new Set(loadState().games.map((g) => g.target.toLowerCase()));
    for (const g of data.games || []) {
      const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(g.target) && !/^[a-z]:\\/i.test(g.target);
      if (have.has(g.target.toLowerCase()) || (!isUrl && !existsSync(g.target))) { skipped.push(g.name); continue; }
      try { added.push((await addGame({ ...g, exePath: g.exePath && existsSync(g.exePath) ? g.exePath : null })).name); } catch { skipped.push(g.name); }
    }
  }
  updateState((s) => logHistory(s, { action: "profile-import", name: `${data.computer || "Export"} · ${ids.length} Optimierungen, ${added.length} Spiele` }));
  return { results, games: added, skippedGames: skipped };
}
