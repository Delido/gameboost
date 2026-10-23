#!/usr/bin/env node
// GameBoost CLI. Every command supports --json (machine-readable output, used by Raycast).
import "../src/env.js";
import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execute, parseArgs, hasCommand } from "../src/commands.js";
import { RISK_LABEL, REBOOT_LABEL } from "../src/catalog.js";

const argv = process.argv.slice(2);
const { pos, flags } = parseArgs(argv);
if (flags.out) process.env.GB_ELEVATED = "1";

// Remember where GameBoost lives so the Raycast extension finds it even after the folder moved.
// An installed copy (with bundled runtime) always wins over a development checkout.
const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]$/, "");
try {
  const dir = join(process.env.LOCALAPPDATA || "", "GameBoost");
  const file = join(dir, "location.json");
  const installed = (root) => existsSync(join(root, "runtime", "node.exe")) && existsSync(join(root, "bin", "gameboost.js"));
  let known = null;
  try { known = JSON.parse(readFileSync(file, "utf8")).root; } catch {}
  if (known !== ROOT && (installed(ROOT) || !known || !installed(known))) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify({ root: ROOT }), "utf8");
  }
} catch {}

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`, yellow: (s) => `\x1b[33m${s}\x1b[0m`, red: (s) => `\x1b[31m${s}\x1b[0m`, cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

const HELP = `
${c.bold("GameBoost")} – Windows Gaming-Optimierer

${c.bold("Übersicht")}
  gameboost ui                         Desktop-Oberfläche öffnen
  gameboost status                     Systeminfo + Optimierungs-Score
  gameboost check                      Systemcheck (Hz, XMP, Treiber, ReBAR, SSD …)
  gameboost list [--category gaming]   Alle Optimierungen mit Status
  gameboost bench run | list | clear   Leistungsmessung (Timer, Hänger, CPU) für Vorher/Nachher

${c.bold("Optimieren")}
  gameboost apply <id...>              Optimierungen anwenden (mit Backup)
  gameboost apply --preset safe|balanced|max [--restore-point]
  gameboost revert <id...> | --all     Zurücksetzen auf Originalwerte
  gameboost presets                    Profile anzeigen

${c.bold("Wartung & Reparatur")}
  gameboost actions                    Wartungsaktionen anzeigen
  gameboost run <aktion>               z. B. quick-clean, clear-standby, trim-ssd, sfc, dism-restore
  gameboost schedule get | set daily|weekly|off   Automatische Wartung
  gameboost registry scan | clean <id...> | deleted | restore <backupId>   Kaputte Registry-Einträge

${c.bold("Game Booster")}
  gameboost boost start|stop|toggle|status
  gameboost games list|scan
  gameboost games add <exe|url> [--name N] [--process game.exe] [--args "..."] [--no-priority] [--no-gpu] [--no-boost]
  gameboost games import <Name...> | --all   Steam/Epic-Spiele übernehmen
  gameboost games launch <id|Name>     Spiel mit Boost starten (endet automatisch)
  gameboost games remove <id|Name>
  gameboost play <exe|lnk>             Beliebiges Programm mit Boost starten
  gameboost autoboost status|enable|disable   Boost automatisch, sobald ein Bibliotheksspiel läuft
  gameboost sessions [clear]           FPS-Berichte der letzten Spielsitzungen
  gameboost tray [status|enable|disable]   Tray-Symbol starten / mit Windows starten

${c.bold("Autostart & Kontextmenü")}
  gameboost startup list | enable <id> | disable <id> | delete <id>
  gameboost startup deleted | restore <backupId>
  gameboost ctx list [--all] | enable <id> | disable <id>

${c.bold("Apps & Speicher")}
  gameboost apps list | uninstall <id> | leftovers --name N [--publisher P] [--location L]
  gameboost apps bloat | remove-bloat <PackageFullName>
  gameboost files large [--path C:\\] [--min 500] | delete <pfad...> | reveal <pfad>

${c.bold("Netzwerk")}
  gameboost dns get | set cloudflare|google|quad9|adguard|auto | bench
  gameboost ping <host|gateway> [--count 20]

${c.bold("Einstellungen")}
  gameboost config get | set boost.services SysMain,WSearch | reset
  gameboost profile export [--file x.json] | import <x.json> [--no-games] [--no-config]
  gameboost history
  gameboost install [--desktop]        Startmenü-Verknüpfung (startet als Admin)
  gameboost update [--force] | update install   Nach Updates suchen / Update installieren
  gameboost version

Optionen: --json  Ausgabe als JSON
`;

function printSession(r, prev = null) {
  const d = (k) => (prev && prev[k] ? ` ${c.dim(`(${r[k] >= prev[k] ? "+" : ""}${Math.round(((r[k] - prev[k]) / prev[k]) * 100)} %)`)}` : "");
  console.log(`${c.bold(r.game)} ${c.dim(`${new Date(r.at).toLocaleString()} · ${r.minutes} min`)}`);
  console.log(`  Ø ${c.bold(r.avgFps + " FPS")}${d("avgFps")} · 1 % Low ${r.low1}${d("low1")} · 0,1 % Low ${r.low01} · Ruckler ${r.stutters}${r.gpuBoundPct != null ? ` · GPU-limitiert ${r.gpuBoundPct} %` : ""}`);
}

const CHECK_ICON = { ok: c.green("✔"), info: c.cyan("ℹ"), warn: c.yellow("⚠"), bad: c.red("✖") };
const STATUS_ICON = { applied: c.green("●"), partial: c.yellow("◐"), default: c.dim("○"), unavailable: c.dim("–"), unknown: c.dim("?") };

function printHuman(cmd, sub, data) {
  switch (cmd) {
    case "status": {
      const i = data.info;
      console.log(`\n${c.bold(i.computer)}  ${c.dim(i.os.name + " (Build " + i.os.build + ")")}`);
      console.log(`CPU   ${i.cpu.name} ${c.dim(`(${i.cpu.cores}C/${i.cpu.threads}T)`)}`);
      for (const g of i.gpus) console.log(`GPU   ${g.name} ${c.dim(`${g.vramGB} GB · Treiber ${g.driver} · ${g.resolution} @ ${g.refresh} Hz`)}`);
      console.log(`RAM   ${i.ram.totalGB} GB ${c.dim(`(${i.ram.freeGB} GB frei)`)}`);
      console.log(`Plan  ${i.powerPlan.name}`);
      const sc = data.score >= 80 ? c.green : data.score >= 50 ? c.yellow : c.red;
      console.log(`\nOptimierungs-Score: ${sc(c.bold(data.score + " / 100"))}  ${c.dim(`(${data.applied}/${data.total} aktiv)`)}`);
      console.log(`Game Boost: ${data.session ? c.green("AKTIV seit " + new Date(data.session.startedAt).toLocaleTimeString()) : c.dim("aus")}\n`);
      break;
    }
    case "list": {
      for (const cat of data.categories) {
        const items = data.tweaks.filter((t) => t.category === cat.id);
        if (!items.length) continue;
        console.log(`\n${cat.icon}  ${c.bold(cat.title)}`);
        for (const t of items) {
          const risk = t.risk === "safe" ? c.green(RISK_LABEL[t.risk]) : t.risk === "moderate" ? c.yellow(RISK_LABEL[t.risk]) : c.red(RISK_LABEL[t.risk]);
          console.log(`  ${STATUS_ICON[t.status]} ${t.title}  ${c.dim(t.id)}  ${risk}${t.reboot !== "none" ? c.dim(" · " + REBOOT_LABEL[t.reboot]) : ""}`);
        }
      }
      if (data.score !== null) console.log(`\nScore: ${c.bold(data.score)} / 100\n`);
      break;
    }
    case "apply": case "revert": {
      if (data.restorePoint) console.log(c.dim("Wiederherstellungspunkt: " + data.restorePoint));
      for (const r of data.results) console.log(`${r.ok ? c.green("✔") : c.red("✖")} ${r.title}${r.errors.length ? c.red("  " + r.errors.join("; ")) : ""}`);
      const reboot = data.results.filter((r) => r.ok && r.reboot === "reboot").length;
      if (reboot) console.log(c.yellow(`\n${reboot} Änderung(en) werden erst nach einem Neustart wirksam.`));
      if (!data.results.length) console.log(c.dim("Nichts zu tun."));
      break;
    }
    case "presets":
      for (const p of data) console.log(`${p.icon} ${c.bold(p.id.padEnd(9))} ${p.title} ${c.dim(`(${p.tweaks.length} Optimierungen) – ${p.description}`)}`);
      break;
    case "actions":
      for (const a of data) console.log(`${a.icon} ${c.bold(a.id.padEnd(20))} ${a.title}${a.admin ? c.dim(" [Admin]") : ""}`);
      break;
    case "run":
      console.log(`${c.green("✔")} ${data.title}: ${data.message}`);
      break;
    case "boost":
      if (sub === "status" || !sub) console.log(data.active ? c.green(`Game Boost AKTIV seit ${new Date(data.session.startedAt).toLocaleTimeString()}`) : "Game Boost ist aus.");
      else if (data.active) {
        const s = data.session;
        console.log(c.green(data.started ? "🚀 Game Boost gestartet" : "Game Boost war bereits aktiv"));
        console.log(c.dim(`  ${s.stoppedServices.length} Dienste pausiert, ${s.killed.length} Apps beendet, ${s.ramFreed} MB RAM freigegeben`));
        for (const e of data.errors || []) console.log(c.yellow("  ⚠ " + e));
      } else {
        console.log(data.wasActive ? `Game Boost beendet nach ${data.minutes} min – System wiederhergestellt.` : "Game Boost war nicht aktiv.");
        if (data.report) printSession(data.report);
      }
      break;
    case "games":
      if (sub === "list" || !sub) {
        if (!data.length) console.log(c.dim("Keine Spiele. Mit 'gameboost games scan' Steam/Epic durchsuchen."));
        for (const g of data) console.log(`🎮 ${c.bold(g.name)} ${c.dim(`[${g.id}] ${g.target}`)}`);
      } else if (sub === "scan") {
        for (const g of data) console.log(`${g.source.padEnd(6)} ${c.bold(g.name)} ${c.dim(g.processName || "(exe unbekannt)")}`);
      } else console.log(JSON.stringify(data, null, 2));
      break;
    case "startup":
      if (sub === "list" || !sub) for (const s of data) console.log(`${s.enabled ? c.green("●") : c.dim("○")} ${c.bold(s.name)}${s.broken ? c.red(" [Ziel fehlt]") : ""} ${c.dim(s.scope + (s.publisher ? " · " + s.publisher : "") + " · " + s.id)}`);
      else if (sub === "deleted") {
        if (!data.length) console.log(c.dim("Keine gelöschten Einträge."));
        for (const e of data) console.log(`${c.bold(e.name)} ${c.dim(`${e.scope} · gelöscht ${new Date(e.deletedAt).toLocaleString()} · ${e.backupId}`)}`);
      } else if (sub === "delete") console.log(`Gelöscht (wiederherstellbar mit 'gameboost startup restore ${data.backupId}'): ${data.name}`);
      else if (sub === "restore") console.log(`Wiederhergestellt: ${data.name}`);
      else console.log(`${data.enabled ? "Aktiviert" : "Deaktiviert"}: ${data.id}`);
      break;
    case "ctx":
      if (sub === "list" || !sub) for (const x of data) console.log(`${x.enabled ? c.green("●") : c.dim("○")} ${c.bold(x.name)} ${c.dim(`${x.locations.join(", ")}${x.publisher ? " · " + x.publisher : ""} · ${x.id}`)}`);
      else console.log(`${data.enabled ? "Eingeblendet" : "Ausgeblendet"}: ${data.id} ${c.dim("(Explorer-Neustart: gameboost run restart-explorer)")}`);
      break;
    case "check":
      for (const x of data) console.log(`${CHECK_ICON[x.status]} ${c.bold(x.title)}  ${x.detail}${x.fix?.type === "url" || x.fix?.type === "uri" ? c.dim("  → " + x.fix.value) : ""}`);
      break;
    case "apps":
      if (sub === "list" || !sub) for (const a of data) console.log(`${c.bold(a.name)} ${c.dim(`${a.version || ""} · ${a.publisher || "?"}${a.sizeMB ? ` · ${a.sizeMB} MB` : ""} · ${a.id}`)}`);
      else if (sub === "bloat") {
        if (!data.length) console.log(c.dim("Keine bekannten vorinstallierten Apps gefunden."));
        for (const a of data) console.log(`${c.bold(a.name)} ${c.dim(a.fullName)}`);
      } else if (sub === "leftovers") {
        if (!data.length) console.log(c.dim("Keine Reste gefunden."));
        for (const x of data) console.log(`${x.path} ${c.dim(x.sizeMB + " MB")}`);
      } else console.log(JSON.stringify(data, null, 2));
      break;
    case "files":
      if (sub === "large" || !sub) {
        for (const f of data.files) console.log(`${String(f.sizeMB).padStart(7)} MB  ${f.path}`);
        console.log(c.dim(`\n${data.scanned} Dateien in ${data.root} durchsucht${data.truncated ? " (Zeitlimit erreicht)" : ""}.`));
      } else if (sub === "delete") for (const r of data) console.log(`${r.ok ? c.green("✔") : c.red("✖")} ${r.path}${r.error ? c.red("  " + r.error) : ""}`);
      break;
    case "dns":
      if (sub === "bench") for (const r of data) console.log(`${r.title.padEnd(32)} ${r.avgMs != null ? c.bold(r.avgMs + " ms") : c.red("keine Antwort")} ${c.dim(r.ip)}`);
      else if (sub === "set") console.log(`DNS umgestellt: ${data.provider}`);
      else for (const a of data.adapters) console.log(`${c.bold(a.name)} ${c.dim(a.description)}\n  ${a.servers.join(", ") || "–"} ${c.dim("(" + (a.provider === "auto" ? "automatisch" : a.provider) + ")")}`);
      break;
    case "ping":
      if (!data.received) console.log(c.red(`${data.host}: keine Antwort`));
      else console.log(`${c.bold(data.host)}  Ø ${data.avgMs} ms · min ${data.minMs} · max ${data.maxMs} · Jitter ${data.jitterMs} ms · Verlust ${data.lossPct} %`);
      break;
    case "bench": {
      const show = (r, label) => r && console.log(`${label.padEnd(9)} Timer Ø ${r.timerAvgMs} ms (P99 ${r.timerP99Ms}) · Hänger ${r.stalls} (max ${r.maxStallUs} µs) · CPU 1T ${r.cpuSingle} · CPU MT ${r.cpuMulti} ${c.dim(r.powerPlan)}`);
      if (sub === "run" || !sub) { show(data.result, "Jetzt"); show(data.previous, "Vorher"); } else for (const r of data) show(r, new Date(r.at).toLocaleDateString());
      break;
    }
    case "autoboost":
      console.log(`Auto-Boost: ${data.enabled ? c.green("aktiv") : c.dim("aus")}${data.enabled ? c.dim(data.running ? " (Wächter läuft)" : " (Wächter startet bei der nächsten Anmeldung)") : ""}`);
      break;
    case "registry":
      if (sub === "scan" || !sub) {
        if (!data.items.length) console.log(c.green("✔ Keine kaputten Registry-Einträge gefunden."));
        for (const i of data.items) console.log(`${c.yellow("●")} ${c.bold(i.name)} ${c.dim(`[${data.categories[i.category]}]`)}\n  ${i.detail}${i.path ? c.dim("  " + i.path) : ""}\n  ${c.dim(i.id)}`);
      } else if (sub === "clean") for (const r of data) console.log(`${r.ok ? c.green("✔") : c.red("✖")} ${r.name || r.id}${r.error ? c.red("  " + r.error) : ""}`);
      else if (sub === "deleted") {
        if (!data.length) console.log(c.dim("Keine gesicherten Einträge."));
        for (const e of data) console.log(`${c.bold(e.name)} ${c.dim(`${e.key} · ${new Date(e.deletedAt).toLocaleString()} · ${e.backupId}`)}`);
      } else console.log(`Wiederhergestellt: ${data.name}${data.service ? c.dim(" (Dienst ist nach einem Neustart wieder registriert)") : ""}`);
      break;
    case "sessions":
      if (!data.length) console.log(c.dim("Noch keine Messungen. Spiele über GameBoost (oder mit Auto-Boost) starten – nach dem Spielen erscheint hier der FPS-Bericht."));
      data.forEach((r, i) => printSession(r, data.slice(i + 1).find((x) => x.gameId === r.gameId && x.process === r.process)));
      break;
    case "update":
      if (sub === "install") console.log(data.updated ? c.green(`✔ Aktualisiert: ${data.from} → ${data.to}`) : "Bereits aktuell.");
      else if (data.available) console.log(`${c.yellow("Update verfügbar:")} ${data.current} → ${c.bold(data.latest)}  ${c.dim(data.kind === "dev" ? "(Git-Checkout: git pull)" : "gameboost update install")}`);
      else console.log(`GameBoost ${data.current} ist aktuell${data.latest ? "" : c.dim(" (noch kein Release veröffentlicht)")}.`);
      break;
    case "version":
      console.log(`GameBoost ${data.version}`);
      break;
    case "schedule":
      console.log(`Automatische Wartung: ${{ daily: "täglich 12:00", weekly: "sonntags 12:00", off: "aus" }[data.schedule]}`);
      break;
    default:
      console.log(JSON.stringify(data, null, 2));
  }
}

async function main() {
  const [cmd, sub] = pos;
  if (flags.version) return console.log(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
  if (!cmd || flags.help || cmd === "help") return console.log(HELP);

  if (cmd === "ui") {
    const { startServer } = await import("../src/server.js");
    return startServer({ port: Number(flags.port) || 47821, open: !flags["no-open"] });
  }
  if (!hasCommand(cmd)) {
    console.error(c.red(`Unbekannter Befehl: ${cmd}`));
    console.log(HELP);
    process.exitCode = 1;
    return;
  }

  try {
    const data = await execute(argv.filter((a, i) => a !== "--json" && a !== "--out" && argv[i - 1] !== "--out"));
    if (flags.out) writeFileSync(flags.out, JSON.stringify({ ok: true, data }), "utf8");
    else if (flags.json) console.log(JSON.stringify({ ok: true, data }));
    else printHuman(cmd, sub, data);
  } catch (e) {
    if (flags.out) writeFileSync(flags.out, JSON.stringify({ ok: false, error: e.message }), "utf8");
    else if (flags.json) console.log(JSON.stringify({ ok: false, error: e.message }));
    else console.error(c.red("Fehler: " + e.message));
    process.exitCode = 1;
  }
}

main();
