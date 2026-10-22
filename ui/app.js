"use strict";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtMB = (mb) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`);

const S = { catalog: null, tweaks: [], info: null, config: null, games: [], session: null, autoboost: null, rebootPending: false, loaded: {}, startup: [], startupDeleted: [], ctx: [], programs: [], dns: null };

// ───────────── API ─────────────
async function post(path, body = {}) {
  const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", "X-GB-Token": window.GB_TOKEN }, body: JSON.stringify(body) });
  return r.json();
}
async function api(argv, { busy = null } = {}) {
  if (busy) showBusy(busy);
  try {
    const r = await post("/api/exec", { argv });
    if (!r.ok) throw new Error(r.error || "Unbekannter Fehler");
    return r.data;
  } finally {
    if (busy) hideBusy();
  }
}

function toast(msg, type = "ok", ms = 4500) {
  const t = document.createElement("div");
  t.className = `toast ${type}`;
  t.textContent = msg;
  $("#toasts").append(t);
  setTimeout(() => t.remove(), ms);
}
const fail = (e) => toast(e.message || String(e), "error", 7000);
function showBusy(text) { $("#busy-text").textContent = text; $("#busy").classList.remove("hidden"); }
function hideBusy() { $("#busy").classList.add("hidden"); }

function modal(html, onMount) {
  $("#modal-box").innerHTML = html;
  $("#modal").classList.remove("hidden");
  const close = () => $("#modal").classList.add("hidden");
  $$("[data-close]", $("#modal-box")).forEach((b) => (b.onclick = close));
  onMount?.($("#modal-box"), close);
}
$("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") $("#modal").classList.add("hidden"); });

function confirmDialog(title, text, okLabel = "Fortfahren", danger = false) {
  return new Promise((resolve) => {
    modal(`<h3>${esc(title)}</h3><p class="muted">${text}</p><div class="row end"><button class="btn ghost" data-close>Abbrechen</button><button class="btn ${danger ? "danger" : "primary"}" id="ok">${esc(okLabel)}</button></div>`, (box, close) => {
      $$("[data-close]", box).forEach((b) => b.addEventListener("click", () => resolve(false)));
      $("#ok", box).onclick = () => { close(); resolve(true); };
    });
  });
}

const showExplorerBanner = () => $("#explorer-banner").classList.remove("hidden");

// ───────────── Navigation ─────────────
const PAGE_LOADERS = {
  startup: () => !S.loaded.startup && loadStartup(),
  contextmenu: () => { renderCtxTweaks(); if (!S.loaded.ctx) loadCtx(); },
  apps: () => !S.loaded.programs && loadPrograms(),
  network: () => !S.loaded.dns && loadDns(),
  maintenance: () => !S.loaded.schedule && loadSchedule(),
  history: () => loadHistory(),
  booster: () => renderBooster(),
};
function go(page) {
  $$("nav button").forEach((b) => b.classList.toggle("active", b.dataset.page === page));
  $$(".page").forEach((p) => p.classList.toggle("active", p.id === `page-${page}`));
  PAGE_LOADERS[page]?.();
  history.replaceState(null, "", `#${page}`);
}
$$("nav button").forEach((b) => (b.onclick = () => go(b.dataset.page)));
document.addEventListener("click", (e) => {
  const g = e.target.closest("[data-go]");
  if (g) go(g.dataset.go);
  if (e.target.closest("[data-refresh]")) refreshAll(true);
  const a = e.target.closest("[data-action]");
  if (a) runAction(a.dataset.action);
});

// ───────────── Data loading ─────────────
async function refreshTweaks() {
  const d = await api(["list"]);
  S.tweaks = d.tweaks;
  S.score = d.score;
  renderScore();
  renderTweaks();
  renderCtxTweaks();
  renderCategories();
}

async function refreshAll(withBusy = false) {
  try {
    if (withBusy) showBusy("System wird analysiert …");
    const [catalog, status, config, games, autoboost] = await Promise.all([
      S.catalog ? S.catalog : api(["catalog"]),
      api(["status"]),
      api(["config", "get"]),
      api(["games", "list"]),
      api(["autoboost", "status"]).catch(() => null),
    ]);
    S.catalog = catalog; S.info = status.info; S.session = status.session; S.config = config; S.games = games; S.autoboost = autoboost;
    await refreshTweaks();
    renderSpecs();
    renderPresets();
    renderActions();
    renderBoostState();
    renderBooster();
  } catch (e) { fail(e); } finally { hideBusy(); }
  loadChecks();
  loadBench();
  checkForUpdate();
}

// ───────────── Dashboard ─────────────
function renderScore() {
  const score = S.score ?? 0;
  const circ = 326.7;
  const ring = $("#score-ring");
  ring.style.strokeDashoffset = String(circ - (circ * score) / 100);
  ring.style.stroke = score >= 80 ? "var(--good)" : score >= 50 ? "var(--warn)" : "var(--bad)";
  $("#score").textContent = score;
  const relevant = S.tweaks.filter((t) => !t.optional);
  const applied = relevant.filter((t) => t.status === "applied").length;
  const total = relevant.filter((t) => t.status !== "unavailable").length;
  $("#score-label").textContent = score >= 85 ? "Dein PC ist optimal eingestellt" : score >= 50 ? "Gut – aber da geht noch mehr" : "Viel ungenutztes Potenzial";
  $("#score-detail").textContent = `${applied} von ${total} Optimierungen aktiv. Fortgeschrittene Eingriffe zählen nicht zum Score.`;
}

function renderSpecs() {
  const i = S.info;
  if (!i) return;
  $("#sys-subtitle").textContent = `${i.computer} · ${i.os.name} (Build ${i.os.build}) · läuft seit ${i.os.uptimeHours} h`;
  const ramUsed = i.ram.totalGB - i.ram.freeGB;
  const cards = [
    { icon: "🧮", label: "Prozessor", value: i.cpu.name, sub: `${i.cpu.cores} Kerne / ${i.cpu.threads} Threads · ${i.cpu.load ?? 0} % Last`, bar: i.cpu.load },
    ...i.gpus.map((g) => ({ icon: "🎮", label: "Grafikkarte", value: g.name, sub: `${g.vramGB} GB VRAM · Treiber ${g.driver} · ${g.resolution} @ ${g.refresh} Hz` })),
    { icon: "🧠", label: "Arbeitsspeicher", value: `${i.ram.totalGB} GB`, sub: `${ramUsed.toFixed(1)} GB belegt · ${i.ram.freeGB} GB frei`, bar: (ramUsed / i.ram.totalGB) * 100 },
    { icon: "⚡", label: "Energieplan", value: i.powerPlan.name || "–", sub: i.isLaptop ? "Laptop erkannt – Akku-Einstellungen bleiben unverändert" : "Desktop-PC" },
    ...i.disks.map((d) => ({ icon: "💽", label: `Laufwerk ${d.letter} ${d.media && d.media !== "Unspecified" ? "· " + d.media : ""}`, value: `${d.freeGB} GB frei von ${d.sizeGB} GB`, sub: d.label || "", bar: ((d.sizeGB - d.freeGB) / d.sizeGB) * 100 })),
  ];
  $("#specs").innerHTML = cards.map((c) => `
    <div class="card spec"><div class="si">${c.icon}</div><div style="min-width:0;flex:1">
      <div class="label">${esc(c.label)}</div><div class="value">${esc(c.value)}</div><div class="muted small">${esc(c.sub)}</div>
      ${c.bar != null ? `<div class="bar"><div style="width:${Math.min(100, Math.max(0, c.bar)).toFixed(0)}%"></div></div>` : ""}
    </div></div>`).join("");
  $("#admin-state").textContent = window.GB_ADMIN ? "🛡️ Administrator" : "Standardbenutzer";
  $("#admin-banner").classList.toggle("hidden", !!window.GB_ADMIN);
}

function renderCategories() {
  if (!S.catalog) return;
  $("#cat-overview").innerHTML = S.catalog.categories.map((c) => {
    const items = S.tweaks.filter((t) => t.category === c.id && t.status !== "unavailable");
    const on = items.filter((t) => t.status === "applied").length;
    return `<div class="card cat" data-cat="${c.id}">
      <div class="cat-top"><strong>${c.icon} ${esc(c.title)}</strong><span class="badge">${on}/${items.length}</span></div>
      <div class="muted small">${esc(c.description)}</div>
      <div class="bar"><div style="width:${items.length ? (on / items.length) * 100 : 0}%"></div></div></div>`;
  }).join("");
  $$("#cat-overview .cat").forEach((el) => (el.onclick = () => {
    const cat = S.catalog.categories.find((c) => c.id === el.dataset.cat);
    if (cat?.optional) return go("contextmenu");
    go("tweaks");
    document.getElementById(`cat-${el.dataset.cat}`)?.scrollIntoView({ behavior: "smooth" });
  }));
}

// Systemcheck
const CHECK_ICON = { ok: "✅", info: "ℹ️", warn: "⚠️", bad: "⛔" };
const CHECK_ORDER = { bad: 0, warn: 1, info: 2, ok: 3 };
async function loadChecks() {
  try {
    const checks = await api(["check"]);
    checks.sort((a, b) => CHECK_ORDER[a.status] - CHECK_ORDER[b.status]);
    $("#checks").innerHTML = checks.map((c, i) => `
      <div class="card check-card ${c.status}">
        <div class="check-top"><span>${CHECK_ICON[c.status]}</span><strong>${esc(c.title)}</strong></div>
        <div class="muted small">${esc(c.detail)}</div>
        ${c.fix && c.status !== "ok" ? `<button class="btn small" data-fix="${i}">${esc(c.fix.label)}</button>` : ""}
      </div>`).join("") || `<div class="empty">Keine Prüfungen verfügbar.</div>`;
    $$("[data-fix]").forEach((b) => (b.onclick = async () => {
      const f = checks[Number(b.dataset.fix)].fix;
      if (f.type === "uri" || f.type === "url") api(["open", f.value]).catch(fail);
      else if (f.type === "action") runAction(f.value);
      else if (f.type === "tweak") { await applyTweaks({ ids: [f.value] }); loadChecks(); }
    }));
  } catch (e) { $("#checks").innerHTML = `<div class="empty">Systemcheck fehlgeschlagen: ${esc(e.message)}</div>`; }
}
$("#run-checks").onclick = () => { $("#checks").innerHTML = `<div class="empty">Hardware wird geprüft …</div>`; loadChecks(); };

// Leistungsmessung
const BENCH_METRICS = [
  ["timerAvgMs", "Timer-Latenz (Sleep 1 ms)", "ms", -1],
  ["timerP99Ms", "Timer-Latenz P99", "ms", -1],
  ["stalls", "System-Hänger > 100 µs", "", -1],
  ["maxStallUs", "Längster Hänger", "µs", -1],
  ["cpuSingle", "CPU Single-Core", "Pkt.", 1],
  ["cpuMulti", "CPU Multi-Core", "Pkt.", 1],
];
function renderBench(list) {
  const [cur, prev] = list;
  if (!cur) return;
  const delta = (k, dir) => {
    if (!prev || !prev[k]) return "";
    const d = ((cur[k] - prev[k]) / prev[k]) * 100;
    if (Math.abs(d) < 2) return `<span class="muted">±0 %</span>`;
    const better = d * dir > 0;
    return `<span class="${better ? "good" : "bad"}">${d > 0 ? "+" : ""}${d.toFixed(0)} %</span>`;
  };
  $("#bench").innerHTML = `
    <table class="bench-table">
      <thead><tr><th></th><th>Aktuell<div class="muted small">${new Date(cur.at).toLocaleString()} · ${esc(cur.powerPlan)}</div></th>
      ${prev ? `<th>Vorher<div class="muted small">${new Date(prev.at).toLocaleString()} · ${esc(prev.powerPlan)}</div></th><th>Änderung</th>` : ""}</tr></thead>
      <tbody>${BENCH_METRICS.map(([k, label, unit, dir]) => `<tr><td>${label}</td><td><strong>${cur[k]}</strong> ${unit}</td>${prev ? `<td>${prev[k]} ${unit}</td><td>${delta(k, dir)}</td>` : ""}</tr>`).join("")}</tbody>
    </table>
    <p class="muted small">Niedrigere Latenz und weniger Hänger bedeuten gleichmäßigere Frametimes. Für einen fairen Vergleich vor und nach dem Optimieren unter gleichen Bedingungen messen (keine Downloads, Spiele geschlossen).</p>`;
}
async function loadBench() {
  try { renderBench(await api(["bench", "list"])); } catch {}
}
$("#run-bench").onclick = async () => {
  try {
    await api(["bench", "run"], { busy: "Leistung wird gemessen (ca. 15 Sekunden) – bitte nichts tun …" });
    loadBench();
  } catch (e) { fail(e); }
};

$("#optimize-now").onclick = () => {
  const presets = S.catalog.presets;
  modal(`<h3>⚡ Optimierungsprofil wählen</h3>
    <p class="muted">Alle Änderungen werden gesichert und lassen sich jederzeit zurücksetzen.</p>
    ${presets.map((p, i) => `<label class="preset-option"><input type="radio" name="preset" value="${p.id}" ${i === 1 ? "checked" : ""}><div><strong>${p.icon} ${esc(p.title)}</strong><div class="muted small">${esc(p.description)}</div></div></label>`).join("")}
    <label class="check"><input type="checkbox" id="rp" checked> Vorher Wiederherstellungspunkt erstellen</label>
    <div class="row end"><button class="btn ghost" data-close>Abbrechen</button><button class="btn primary" id="go">Optimieren</button></div>`,
  (box, close) => {
    $("#go", box).onclick = async () => {
      const preset = $("input[name=preset]:checked", box).value;
      if (preset === "max" && !(await confirmDialog("Maximale Leistung", "Dieses Profil enthält Eingriffe, die Sicherheit (Speicherintegrität) und Komfort (z. B. Suchindex, Drucker) einschränken. Wirklich fortfahren?", "Ja, alles anwenden", true))) return;
      close();
      await applyTweaks({ preset, restorePoint: $("#rp", box).checked });
    };
  });
};

$("#quick-boost").onclick = () => toggleBoost();

// ───────────── Tweaks ─────────────
function renderPresets() {
  $("#presets").innerHTML = S.catalog.presets.map((p) => `
    <div class="card preset"><strong>${p.icon} ${esc(p.title)}</strong><div class="muted small">${esc(p.description)}</div>
    <button class="btn small" data-preset="${p.id}">Profil anwenden</button></div>`).join("");
  $$("[data-preset]").forEach((b) => (b.onclick = async () => {
    const p = b.dataset.preset;
    if (p === "max" && !(await confirmDialog("Maximale Leistung", "Enthält fortgeschrittene Eingriffe (u. a. Speicherintegrität aus). Fortfahren?", "Anwenden", true))) return;
    applyTweaks({ preset: p });
  }));
}

function tweakRows(items) {
  const { riskLabels, rebootLabels } = S.catalog;
  return items.map((t) => `
    <div class="tweak">
      <div>
        <div class="tweak-title">${esc(t.title)}
          <span class="badge ${t.risk}">${riskLabels[t.risk]}</span>
          ${t.reboot !== "none" ? `<span class="badge">${rebootLabels[t.reboot]}</span>` : ""}
          ${t.admin ? `<span class="badge" title="Benötigt Administratorrechte">Admin</span>` : ""}
          ${t.status === "partial" ? `<span class="badge partial">Teilweise aktiv</span>` : ""}
          ${t.status === "unavailable" ? `<span class="badge">Nicht verfügbar</span>` : ""}
        </div>
        <div class="tweak-desc">${esc(t.description)}</div>
        ${t.errors?.length && t.status !== "unknown" ? `<div class="tweak-err">${esc(t.errors.join("; "))}</div>` : ""}
      </div>
      <label class="switch ${t.status === "partial" ? "partial" : ""}" title="${t.status === "unknown" ? "Status nur mit Adminrechten lesbar" : ""}">
        <input type="checkbox" data-tweak="${t.id}" ${t.status === "applied" ? "checked" : ""} ${t.status === "unavailable" ? "disabled" : ""}><span></span>
      </label>
    </div>`).join("");
}

function bindTweakRows(root) {
  $$("[data-tweak]", root).forEach((cb) => (cb.onchange = async () => {
    const t = S.tweaks.find((x) => x.id === cb.dataset.tweak);
    if (cb.checked && t.risk === "advanced" && !(await confirmDialog(t.title, esc(t.description), "Trotzdem aktivieren", true))) { cb.checked = false; return; }
    cb.checked ? applyTweaks({ ids: [t.id] }) : revertTweaks([t.id]);
  }));
}

function renderTweaks() {
  if (!S.catalog) return;
  const q = $("#tweak-search").value.trim().toLowerCase();
  const risk = $("#risk-filter").value;
  const html = S.catalog.categories.filter((c) => !c.optional).map((c) => {
    const items = S.tweaks.filter((t) => t.category === c.id && (!risk || t.risk === risk) && (!q || (t.title + " " + t.description + " " + t.id).toLowerCase().includes(q)));
    if (!items.length) return "";
    return `<div class="cat-block" id="cat-${c.id}">
      <div class="cat-block-head"><h2>${c.icon} ${esc(c.title)}</h2>
        <div class="row"><button class="btn small ghost" data-cat-apply="${c.id}">Alle anwenden</button><button class="btn small ghost" data-cat-revert="${c.id}">Zurücksetzen</button></div></div>
      <div class="card tweak-list-card">${tweakRows(items)}</div></div>`;
  }).join("");
  $("#tweak-list").innerHTML = html || `<div class="empty">Keine Optimierung gefunden.</div>`;
  bindTweakRows($("#tweak-list"));
  $$("[data-cat-apply]").forEach((b) => (b.onclick = () => {
    const ids = S.tweaks.filter((t) => t.category === b.dataset.catApply && t.risk !== "advanced" && t.status !== "applied" && t.status !== "unavailable").map((t) => t.id);
    if (!ids.length) return toast("Alle sicheren/moderaten Optimierungen dieser Kategorie sind bereits aktiv.", "info");
    applyTweaks({ ids });
  }));
  $$("[data-cat-revert]").forEach((b) => (b.onclick = () => {
    const ids = S.tweaks.filter((t) => t.category === b.dataset.catRevert && (t.status === "applied" || t.status === "partial" || t.hasBackup)).map((t) => t.id);
    if (ids.length) revertTweaks(ids);
  }));
}
$("#tweak-search").oninput = renderTweaks;
$("#risk-filter").onchange = renderTweaks;

async function applyTweaks({ ids = null, preset = null, restorePoint = false }) {
  const argv = ["apply", ...(ids || [])];
  if (preset) argv.push("--preset", preset);
  if (restorePoint) argv.push("--restore-point");
  try {
    const r = await api(argv, { busy: restorePoint ? "Wiederherstellungspunkt wird erstellt und Optimierungen angewendet …" : "Optimierungen werden angewendet …" });
    reportResults(r.results, "angewendet");
    if (r.restorePoint) toast(r.restorePoint, r.restorePoint.startsWith("Fehl") ? "error" : "info");
  } catch (e) { fail(e); }
  await refreshTweaks().catch(fail);
}

async function revertTweaks(ids) {
  try {
    const r = await api(["revert", ...ids], { busy: "Wird zurückgesetzt …" });
    reportResults(r.results, "zurückgesetzt");
  } catch (e) { fail(e); }
  await refreshTweaks().catch(fail);
}

function reportResults(results, verb) {
  const ok = results.filter((r) => r.ok);
  const bad = results.filter((r) => !r.ok);
  if (ok.length) toast(ok.length === 1 ? `${ok[0].title} ${verb}.` : `${ok.length} Optimierungen ${verb}.`);
  for (const b of bad) toast(`${b.title}: ${b.errors.join("; ")}`, "error", 8000);
  if (ok.some((r) => r.reboot === "reboot")) { S.rebootPending = true; $("#reboot-banner").classList.remove("hidden"); }
  if (ok.some((r) => r.reboot === "explorer")) showExplorerBanner();
}

$("#revert-all").onclick = async () => {
  if (!(await confirmDialog("Alles zurücksetzen", "Alle von GameBoost geänderten Einstellungen werden auf ihre ursprünglichen Werte zurückgesetzt.", "Zurücksetzen", true))) return;
  try {
    const r = await api(["revert", "--all"], { busy: "Alle Änderungen werden zurückgesetzt …" });
    r.results.length ? reportResults(r.results, "zurückgesetzt") : toast("Es gab nichts zurückzusetzen.", "info");
  } catch (e) { fail(e); }
  refreshTweaks().catch(fail);
};

// Export / Import
$("#profile-export").onclick = async () => {
  try {
    const data = await api(["profile", "export"], { busy: "Einstellungen werden exportiert …" });
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `gameboost-${(data.computer || "pc").toLowerCase()}-${data.exportedAt.slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast(`${data.tweaks.length} Optimierungen und ${data.games.length} Spiele exportiert.`);
  } catch (e) { fail(e); }
};
$("#profile-import").onclick = () => $("#profile-file").click();
$("#profile-file").onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (data.app !== "gameboost") throw new Error("Keine GameBoost-Exportdatei");
    modal(`<h3>⤒ Einstellungen importieren</h3>
      <p class="muted">Export von <strong>${esc(data.computer || "unbekannt")}</strong> (${new Date(data.exportedAt).toLocaleString()}).</p>
      <label class="check"><input type="checkbox" checked disabled> ${data.tweaks.length} Optimierungen anwenden (mit Backup)</label>
      <label class="check"><input type="checkbox" id="imp-config" checked> Boost-Einstellungen übernehmen</label>
      <label class="check"><input type="checkbox" id="imp-games" checked> ${data.games.length} Spiele übernehmen (nur wenn auf diesem PC installiert)</label>
      <div class="row end"><button class="btn ghost" data-close>Abbrechen</button><button class="btn primary" id="imp-go">Importieren</button></div>`,
    (box, close) => {
      $("#imp-go", box).onclick = async () => {
        const argv = ["profile", "import", "--b64", b64(text)];
        if (!$("#imp-config", box).checked) argv.push("--no-config");
        if (!$("#imp-games", box).checked) argv.push("--no-games");
        close();
        try {
          const r = await api(argv, { busy: "Einstellungen werden importiert …" });
          reportResults(r.results, "angewendet");
          if (r.games.length) toast(`${r.games.length} Spiele übernommen.`);
          if (r.skippedGames.length) toast(`${r.skippedGames.length} Spiele übersprungen (nicht installiert oder bereits vorhanden).`, "info");
        } catch (err) { fail(err); }
        refreshAll();
      };
    });
  } catch (err) { fail(err); }
};
function b64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// ───────────── Booster ─────────────
function renderBoostState() {
  const on = !!S.session;
  $("#boost-pill").className = `pill ${on ? "on" : "off"}`;
  $("#boost-pill").textContent = on ? "● Game Boost aktiv" : "Game Boost aus";
  $("#quick-boost").classList.toggle("on", on);
  $("#quick-boost-state").textContent = on ? `Aktiv seit ${new Date(S.session.startedAt).toLocaleTimeString()}` : "Ressourcen für Spiele freigeben";
  $("#boost-card").classList.toggle("on", on);
  $("#boost-title").textContent = on ? "🚀 Game Boost ist aktiv" : "Game Boost ist aus";
  $("#boost-detail").textContent = on
    ? `${S.session.stoppedServices.length} Dienste pausiert · ${S.session.killed.length} Apps beendet · ${S.session.ramFreed} MB RAM freigegeben${S.session.watchProcess ? ` · endet automatisch mit ${S.session.watchProcess}` : ""}${S.session.auto ? " · gestartet von Auto-Boost" : ""}`
    : "Startet den GameBoost-Energieplan, stoppt Dienste, beendet Apps und leert den Standby-RAM.";
  $("#boost-toggle").textContent = on ? "Boost beenden" : "Boost starten";
  $("#boost-toggle").classList.toggle("danger", on);
  $("#boost-toggle").classList.toggle("primary", !on);
  $("#quick-games").textContent = S.games.length ? `${S.games.length} Spiele in der Bibliothek` : "Bibliothek verwalten";
}

async function toggleBoost() {
  try {
    const r = await api(["boost", "toggle"], { busy: S.session ? "System wird wiederhergestellt …" : "Game Boost wird gestartet …" });
    if (r.active) {
      S.session = r.session;
      toast(`🚀 Game Boost aktiv: ${r.session.stoppedServices.length} Dienste pausiert, ${r.session.killed.length} Apps beendet, ${r.session.ramFreed} MB RAM frei.`);
      (r.errors || []).forEach((e) => toast(e, "error"));
    } else {
      S.session = null;
      toast(r.wasActive ? `Game Boost beendet (${r.minutes} min). System wiederhergestellt.` : "Game Boost war nicht aktiv.", "info");
    }
  } catch (e) { fail(e); }
  renderBoostState();
}
$("#boost-toggle").onclick = toggleBoost;

function renderAutoBoost() {
  const a = S.autoboost;
  $("#autoboost-toggle").checked = !!a?.enabled;
  $("#autoboost").classList.toggle("on", !!a?.enabled);
  const games = S.games.filter((g) => g.boost && g.processName).length;
  $("#autoboost-detail").textContent = a?.enabled
    ? `Aktiv – überwacht ${games} Spiel(e) aus der Bibliothek${a.running ? "" : " (Wächter startet bei der nächsten Anmeldung)"}. Der Boost startet, sobald eines läuft, und endet mit dem Spiel.`
    : "Startet den Boost automatisch, sobald ein Spiel aus der Bibliothek läuft – auch wenn du es über Steam, Epic oder eine Desktop-Verknüpfung startest. Endet mit dem Spiel.";
}
$("#autoboost-toggle").onchange = async (e) => {
  const enable = e.target.checked;
  try {
    S.autoboost = await api(["autoboost", enable ? "enable" : "disable"], { busy: enable ? "Auto-Boost wird eingerichtet …" : "Auto-Boost wird deaktiviert …" });
    toast(enable ? "Auto-Boost aktiv." : "Auto-Boost deaktiviert.", enable ? "ok" : "info");
  } catch (err) { fail(err); }
  renderAutoBoost();
};

function renderBooster() {
  if (!S.config) return;
  renderAutoBoost();
  const games = S.games;
  $("#games").innerHTML = games.length ? games.map((g) => `
    <div class="card game">
      <div class="game-top"><div class="game-icon">${esc(g.name.slice(0, 1).toUpperCase())}</div>
        <div style="min-width:0"><strong title="${esc(g.name)}">${esc(g.name)}</strong><div class="meta" title="${esc(g.target)}">${esc(g.processName || g.target)}</div></div></div>
      <div class="row small muted">${g.highPriority ? "⬆ Hohe Priorität" : ""} ${g.gpuHighPerf ? "· 🎮 GPU-Leistung" : ""} ${g.boost ? "· 🚀 Auto-Boost" : ""}</div>
      <div class="row"><button class="btn primary small" data-launch="${g.id}">▶ Spielen</button><button class="btn small ghost" data-remove="${g.id}" title="Entfernen">✕</button></div>
    </div>`).join("") : `<div class="empty">Noch keine Spiele. Durchsuche Steam/Epic oder füge eine .exe hinzu.</div>`;
  $$("[data-launch]").forEach((b) => (b.onclick = async () => {
    try {
      const r = await api(["games", "launch", b.dataset.launch], { busy: "Spiel wird mit Boost gestartet …" });
      toast(`▶ ${r.game.name} gestartet${r.boost ? " – Game Boost aktiv" : ""}.`);
      if (r.boost?.session) S.session = r.boost.session;
      renderBoostState();
    } catch (e) { fail(e); }
  }));
  $$("[data-remove]").forEach((b) => (b.onclick = async () => {
    const g = S.games.find((x) => x.id === b.dataset.remove);
    if (!(await confirmDialog("Spiel entfernen", `${esc(g.name)} aus der Bibliothek entfernen? Priorität und GPU-Einstellung werden zurückgesetzt.`, "Entfernen", true))) return;
    try { await api(["games", "remove", g.id], { busy: "Wird entfernt …" }); S.games = await api(["games", "list"]); renderBooster(); renderBoostState(); } catch (e) { fail(e); }
  }));

  const b = S.config.boost;
  const chips = (list, key) => list.map((x, i) => `<span class="chip">${esc(x)}<button data-chip="${key}" data-i="${i}" title="Entfernen">×</button></span>`).join("");
  $("#cfg-services").innerHTML = chips(b.services, "services");
  $("#cfg-processes").innerHTML = chips(b.processes, "processes");
  $$("[data-chip]").forEach((x) => (x.onclick = () => {
    const key = x.dataset.chip;
    saveConfig(key, b[key].filter((_, i) => i !== Number(x.dataset.i)));
  }));
  const opts = [["powerPlan", "GameBoost-Energieplan aktivieren"], ["clearStandby", "Standby-RAM leeren"], ["flushDns", "DNS-Cache leeren"], ["restartProcesses", "Beendete Apps danach neu starten"]];
  $("#cfg-options").innerHTML = opts.map(([k, l]) => `<label><span class="switch"><input type="checkbox" data-opt="${k}" ${b[k] ? "checked" : ""}><span></span></span>${l}</label>`).join("");
  $$("[data-opt]").forEach((x) => (x.onchange = () => saveConfig(x.dataset.opt, x.checked)));
}

async function saveConfig(key, value) {
  try {
    S.config = await api(["config", "set", `boost.${key}`, Array.isArray(value) ? value.join(",") : String(value)]);
    renderBooster();
  } catch (e) { fail(e); }
}
const addChip = (key, input) => {
  const v = $(input).value.trim();
  if (!v) return;
  if (!S.config.boost[key].includes(v)) saveConfig(key, [...S.config.boost[key], v]);
  $(input).value = "";
};
$("#cfg-service-add").onclick = () => addChip("services", "#cfg-service-input");
$("#cfg-process-add").onclick = () => addChip("processes", "#cfg-process-input");
$("#cfg-service-input").onkeydown = (e) => e.key === "Enter" && addChip("services", "#cfg-service-input");
$("#cfg-process-input").onkeydown = (e) => e.key === "Enter" && addChip("processes", "#cfg-process-input");

$("#add-game").onclick = () => modal(`<h3>＋ Spiel hinzufügen</h3>
  <label class="field">Pfad zur .exe oder Launcher-URL<input id="g-target" placeholder="C:\\Games\\MeinSpiel\\game.exe  oder  steam://rungameid/730"></label>
  <label class="field">Name (optional)<input id="g-name"></label>
  <label class="field">Prozessname beim Spielen (optional, z. B. cs2.exe)<input id="g-proc"></label>
  <label class="field">Startparameter (optional)<input id="g-args"></label>
  <label class="check"><input type="checkbox" id="g-prio" checked> Hohe CPU-Priorität</label>
  <label class="check"><input type="checkbox" id="g-gpu" checked> Hochleistungs-GPU erzwingen</label>
  <label class="check"><input type="checkbox" id="g-boost" checked> Beim Start automatisch Game Boost</label>
  <div class="row end"><button class="btn ghost" data-close>Abbrechen</button><button class="btn primary" id="g-save">Hinzufügen</button></div>`,
(box, close) => {
  $("#g-save", box).onclick = async () => {
    const target = $("#g-target", box).value.trim().replace(/^"|"$/g, "");
    if (!target) return toast("Bitte Pfad oder URL angeben.", "error");
    const argv = ["games", "add", target];
    if ($("#g-name", box).value.trim()) argv.push("--name", $("#g-name", box).value.trim());
    if ($("#g-proc", box).value.trim()) argv.push("--process", $("#g-proc", box).value.trim());
    if ($("#g-args", box).value.trim()) argv.push("--args", $("#g-args", box).value.trim());
    if (!$("#g-prio", box).checked) argv.push("--no-priority");
    if (!$("#g-gpu", box).checked) argv.push("--no-gpu");
    if (!$("#g-boost", box).checked) argv.push("--no-boost");
    try {
      const g = await api(argv, { busy: "Spiel wird hinzugefügt …" });
      close(); toast(`${g.name} hinzugefügt.`);
      S.games = await api(["games", "list"]); renderBooster(); renderBoostState();
    } catch (e) { fail(e); }
  };
});

$("#scan-games").onclick = async () => {
  try {
    const found = await api(["games", "scan"], { busy: "Steam- und Epic-Bibliotheken werden durchsucht …" });
    const box = $("#scan-results");
    box.classList.remove("hidden");
    if (!found.length) { box.innerHTML = `<p class="muted">Keine neuen Spiele gefunden.</p>`; return; }
    box.innerHTML = `<div class="section-head" style="margin-top:0"><h3>${found.length} installierte Spiele gefunden</h3>
      <div class="row"><button class="btn small" id="import-all">Alle übernehmen</button><button class="btn small ghost" id="scan-close">Schließen</button></div></div>
      <div class="list">${found.map((g) => `<div class="list-item"><div><strong>${esc(g.name)}</strong><div class="cmd">${esc(g.source === "steam" ? "Steam" : "Epic")} · ${esc(g.processName || "Prozess unbekannt")}</div></div>
      <button class="btn small" data-import="${esc(g.name)}">Übernehmen</button></div>`).join("")}</div>`;
    $("#scan-close").onclick = () => box.classList.add("hidden");
    const importGames = async (argv) => {
      try {
        const added = await api(argv, { busy: "Spiele werden übernommen …" });
        toast(`${added.length} Spiel(e) übernommen.`);
        S.games = await api(["games", "list"]); renderBooster(); renderBoostState();
        $("#scan-games").click();
      } catch (e) { fail(e); }
    };
    $("#import-all").onclick = () => importGames(["games", "import", "--all"]);
    $$("[data-import]", box).forEach((b) => (b.onclick = () => importGames(["games", "import", b.dataset.import])));
  } catch (e) { fail(e); }
};

// ───────────── Maintenance ─────────────
function renderActions() {
  const groups = S.catalog.actionGroups || [{ id: undefined, title: "" }];
  $("#actions").innerHTML = groups.map((g) => {
    const items = S.catalog.actions.filter((a) => a.group === g.id);
    if (!items.length) return "";
    return `<h2>${esc(g.title)}</h2><div class="grid actions">${items.map((a) => `
      <div class="card action"><div class="action-top"><span class="ai">${a.icon}</span><strong>${esc(a.title)}</strong>${a.admin ? `<span class="badge">Admin</span>` : ""}</div>
      <div class="muted small">${esc(a.description)}</div><div class="result" id="res-${a.id}"></div>
      <button class="btn small" data-action="${a.id}">Ausführen</button></div>`).join("")}</div>`;
  }).join("");
}

const SLOW_ACTIONS = new Set(["sfc", "dism-restore", "component-cleanup", "remove-windows-old"]);
async function runAction(id) {
  const a = S.catalog.actions.find((x) => x.id === id);
  if (id === "remove-windows-old" && !(await confirmDialog(a.title, esc(a.description), "Löschen", true))) return;
  try {
    const r = await api(["run", id], { busy: SLOW_ACTIONS.has(id) ? `${a.title} – das kann bis zu 30 Minuten dauern …` : `${a.title} …` });
    toast(`${a.icon} ${r.message}`, "ok", SLOW_ACTIONS.has(id) ? 15000 : 4500);
    const el = document.getElementById(`res-${id}`);
    if (el) el.textContent = `✔ ${r.message}`;
    if (id === "restart-explorer") $("#explorer-banner").classList.add("hidden");
    if (id === "clear-standby" || id === "quick-clean") api(["status"]).then((s) => { S.info = s.info; renderSpecs(); }).catch(() => {});
  } catch (e) { fail(e); }
}

const SCHEDULE_LABEL = { off: "Aus", daily: "täglich um 12:00", weekly: "sonntags um 12:00" };
async function loadSchedule() {
  try {
    const s = await api(["schedule", "get"]);
    S.loaded.schedule = true;
    $("#schedule-select").value = s.schedule;
    $("#schedule-detail").textContent = s.schedule === "off"
      ? "Führt die 1-Klick-Wartung regelmäßig im Hintergrund aus (Aufgabenplanung, mit Adminrechten)."
      : `Läuft ${SCHEDULE_LABEL[s.schedule]}${s.task?.lastRun ? ` · zuletzt ${new Date(s.task.lastRun).toLocaleString()}` : ""}. Verpasste Termine werden nachgeholt.`;
  } catch (e) { fail(e); }
}
$("#schedule-select").onchange = async (e) => {
  try {
    await api(["schedule", "set", e.target.value], { busy: "Zeitplan wird gespeichert …" });
    toast(e.target.value === "off" ? "Automatische Wartung deaktiviert." : `Automatische Wartung: ${SCHEDULE_LABEL[e.target.value]}.`);
  } catch (err) { fail(err); }
  loadSchedule();
};

// ───────────── Startup ─────────────
const STARTUP_TYPES = [
  ["run", "Programme (Registry)", ""],
  ["folder", "Autostart-Ordner", ""],
  ["appx", "Store-Apps", "Wie in Einstellungen › Apps › Autostart."],
  ["task", "Geplante Aufgaben", "Starten bei Anmeldung oder Systemstart – oft Updater und Hilfsprogramme."],
  ["service", "Dienste von Drittanbietern", "Deaktivieren stellt den Dienst auf „Manuell“. Vorsicht bei Audio-, Treiber-, RGB- und Anti-Cheat-Diensten."],
  ["runonce", "Einmalige Einträge (RunOnce)", "Laufen einmal bei der nächsten Anmeldung, z. B. Abschluss einer Installation."],
];
async function loadStartup() {
  try {
    const [items, deleted] = await Promise.all([api(["startup", "list"]), api(["startup", "deleted"])]);
    S.startup = items; S.startupDeleted = deleted; S.loaded.startup = true;
    renderStartup();
  } catch (e) { fail(e); }
}
function renderStartup() {
  const q = $("#startup-search").value.trim().toLowerCase();
  const match = (s) => !q || `${s.name} ${s.command} ${s.publisher}`.toLowerCase().includes(q);
  const broken = S.startup.filter((s) => s.broken).length;
  const html = STARTUP_TYPES.map(([type, title, hint]) => {
    const items = S.startup.filter((s) => s.type === type && match(s));
    if (!items.length) return "";
    const on = items.filter((s) => s.enabled).length;
    return `<div class="section-head"><h2>${esc(title)} <span class="badge">${on}/${items.length} aktiv</span></h2></div>
      ${hint ? `<p class="muted small">${esc(hint)}</p>` : ""}
      <div class="card list">${items.map((s) => `
        <div class="list-item ${s.enabled ? "" : "off"}"><div>
          <strong>${esc(s.name)}</strong> <span class="badge">${esc(s.scope)}</span>${s.admin ? ` <span class="badge">Admin</span>` : ""}${s.broken ? ` <span class="badge bad" title="Die Programmdatei existiert nicht mehr – der Eintrag kann gefahrlos gelöscht werden">Ziel fehlt</span>` : ""}
          <div class="cmd" title="${esc(s.command)}">${s.publisher ? `<span class="pub">${esc(s.publisher)}</span> · ` : ""}${esc(s.command)}</div></div>
          <div class="row nowrap">
            ${s.canDelete ? `<button class="btn small ghost icon" data-startup-del="${esc(s.id)}" title="Löschen (wiederherstellbar)">🗑</button>` : ""}
            ${s.canToggle ? `<label class="switch"><input type="checkbox" data-startup="${esc(s.id)}" ${s.enabled ? "checked" : ""}><span></span></label>` : ""}
          </div></div>`).join("")}</div>`;
  }).join("");
  $("#startup-list").innerHTML = (broken && !q ? `<div class="banner warn inline"><span>🧹 ${broken} Einträge zeigen auf Programme, die nicht mehr existieren (Badge „Ziel fehlt“). Diese können gefahrlos gelöscht werden.</span></div>` : "")
    + (html || `<div class="empty">Keine Autostart-Einträge gefunden.</div>`);
  $$("[data-startup]").forEach((cb) => (cb.onchange = async () => {
    const s = S.startup.find((x) => x.id === cb.dataset.startup);
    try {
      await api(["startup", cb.checked ? "enable" : "disable", s.id]);
      s.enabled = cb.checked;
      cb.closest(".list-item").classList.toggle("off", !s.enabled);
      toast(`${s.enabled ? "Aktiviert" : "Deaktiviert"}: ${s.name}`);
    } catch (e) { cb.checked = !cb.checked; fail(e); }
  }));
  $$("[data-startup-del]").forEach((b) => (b.onclick = async () => {
    const s = S.startup.find((x) => x.id === b.dataset.startupDel);
    const what = s.type === "task" ? "Die geplante Aufgabe wird gesichert und entfernt." : s.type === "folder" ? "Die Verknüpfung wird gesichert und aus dem Autostart-Ordner entfernt." : "Der Registry-Eintrag wird gesichert und entfernt.";
    if (!(await confirmDialog(`„${s.name}“ löschen?`, `${what} Du kannst ihn unten unter „Gelöschte Einträge“ jederzeit wiederherstellen.`, "Löschen", true))) return;
    try {
      await api(["startup", "delete", s.id], { busy: "Wird gelöscht …" });
      toast(`Gelöscht: ${s.name}`);
      loadStartup();
    } catch (e) { fail(e); }
  }));
  renderStartupDeleted();
}
function renderStartupDeleted() {
  const d = S.startupDeleted;
  $("#startup-deleted").innerHTML = d.length ? `<div class="section-head"><h2>Gelöschte Einträge</h2></div>
    <div class="card list">${d.map((e) => `<div class="list-item"><div><strong>${esc(e.name)}</strong> <span class="badge">${esc(e.scope)}</span>
      <div class="cmd">Gelöscht am ${new Date(e.deletedAt).toLocaleString()} · ${esc(e.command)}</div></div>
      <button class="btn small" data-startup-restore="${esc(e.backupId)}">↺ Wiederherstellen</button></div>`).join("")}</div>` : "";
  $$("[data-startup-restore]").forEach((b) => (b.onclick = async () => {
    try {
      const r = await api(["startup", "restore", b.dataset.startupRestore], { busy: "Wird wiederhergestellt …" });
      toast(`Wiederhergestellt: ${r.name}`);
      loadStartup();
    } catch (e) { fail(e); }
  }));
}
$("#refresh-startup").onclick = loadStartup;
$("#startup-search").oninput = () => S.loaded.startup && renderStartup();

// ───────────── Context menu ─────────────
function renderCtxTweaks() {
  if (!S.catalog) return;
  const cats = S.catalog.categories.filter((c) => c.optional).map((c) => c.id);
  const items = S.tweaks.filter((t) => cats.includes(t.category));
  $("#ctx-tweaks").innerHTML = `<div class="card tweak-list-card">${tweakRows(items)}</div>`;
  bindTweakRows($("#ctx-tweaks"));
}
const CTX_KIND = { extension: "Erweiterung", verb: "Befehl", app: "App (Windows 11)" };
async function loadCtx() {
  try {
    const argv = ["ctx", "list"];
    if ($("#ctx-all").checked) argv.push("--all");
    S.ctx = await api(argv);
    S.loaded.ctx = true;
    $("#ctx-list").innerHTML = S.ctx.length ? S.ctx.map((x) => `
      <div class="list-item ${x.enabled ? "" : "off"}"><div><strong>${esc(x.name)}</strong> <span class="badge">${CTX_KIND[x.kind]}</span> ${x.locations.map((l) => `<span class="badge">${esc(l)}</span>`).join(" ")}
        <div class="cmd" title="${esc(x.path)}">${x.publisher ? `<span class="pub">${esc(x.publisher)}</span> · ` : ""}${esc(x.path)}</div></div>
        <label class="switch"><input type="checkbox" data-ctx="${esc(x.id)}" ${x.enabled ? "checked" : ""}><span></span></label></div>`).join("")
      : `<div class="empty">Keine Kontextmenü-Einträge von Drittanbietern gefunden.</div>`;
    $$("[data-ctx]").forEach((cb) => (cb.onchange = async () => {
      const x = S.ctx.find((i) => i.id === cb.dataset.ctx);
      try {
        await api(["ctx", cb.checked ? "enable" : "disable", x.id, "--name", x.name]);
        x.enabled = cb.checked;
        cb.closest(".list-item").classList.toggle("off", !x.enabled);
        // the same CLSID can appear twice (extension + app entry)
        $$(`[data-ctx="${CSS.escape(x.id)}"]`).forEach((o) => (o.checked = cb.checked));
        toast(`${x.enabled ? "Eingeblendet" : "Ausgeblendet"}: ${x.name}`);
        showExplorerBanner();
      } catch (e) { cb.checked = !cb.checked; fail(e); }
    }));
  } catch (e) { fail(e); }
}
$("#refresh-ctx").onclick = loadCtx;
$("#ctx-all").onchange = loadCtx;

// ───────────── Apps & Speicher ─────────────
$$("#apps-tabs button").forEach((b) => (b.onclick = () => {
  $$("#apps-tabs button").forEach((x) => x.classList.toggle("active", x === b));
  $$("#page-apps .tab-page").forEach((p) => p.classList.toggle("active", p.id === `tab-${b.dataset.tab}`));
  if (b.dataset.tab === "bloat" && !S.loaded.bloat) loadBloat();
}));

async function loadPrograms() {
  try {
    S.programs = await api(["apps", "list"]);
    S.loaded.programs = true;
    renderPrograms();
  } catch (e) { fail(e); }
}
function renderPrograms() {
  const q = $("#programs-search").value.trim().toLowerCase();
  const sort = $("#programs-sort").value;
  const items = S.programs.filter((p) => !q || `${p.name} ${p.publisher}`.toLowerCase().includes(q));
  if (sort === "size") items.sort((a, b) => b.sizeMB - a.sizeMB);
  if (sort === "date") items.sort((a, b) => (b.installDate || "").localeCompare(a.installDate || ""));
  $("#programs-list").innerHTML = items.length ? items.map((p) => `
    <div class="list-item"><div><strong>${esc(p.name)}</strong>
      <div class="cmd">${[p.publisher, p.version, p.sizeMB ? fmtMB(p.sizeMB) : "", p.installDate ? `installiert ${new Date(p.installDate).toLocaleDateString()}` : ""].filter(Boolean).map(esc).join(" · ")}</div></div>
      <button class="btn small ghost" data-uninstall="${esc(p.id)}">Deinstallieren</button></div>`).join("")
    : `<div class="empty">Keine Programme gefunden.</div>`;
  $$("[data-uninstall]").forEach((b) => (b.onclick = () => uninstall(S.programs.find((p) => p.id === b.dataset.uninstall))));
}
$("#programs-search").oninput = () => S.loaded.programs && renderPrograms();
$("#programs-sort").onchange = () => S.loaded.programs && renderPrograms();
$("#refresh-programs").onclick = loadPrograms;

async function uninstall(p) {
  if (!(await confirmDialog(`${p.name} deinstallieren?`, "Das Deinstallationsprogramm des Herstellers wird gestartet. Danach kann GameBoost nach übrig gebliebenen Ordnern suchen.", "Deinstallieren", true))) return;
  try {
    await api(["apps", "uninstall", p.id], { busy: "Deinstallation wird gestartet …" });
  } catch (e) { return fail(e); }
  modal(`<h3>🗑 ${esc(p.name)}</h3>
    <p class="muted">Das Deinstallationsprogramm läuft. Folge den Schritten im Fenster des Herstellers und suche danach nach Resten.</p>
    <div class="row end"><button class="btn ghost" data-close>Fertig</button><button class="btn primary" id="lo-search">Nach Resten suchen</button></div>`,
  (box, close) => {
    $("#lo-search", box).onclick = async () => {
      close();
      await loadPrograms();
      const still = S.programs.some((x) => x.id === p.id);
      try {
        const found = await api(["apps", "leftovers", "--name", p.name, "--publisher", p.publisher || "", "--location", p.location || ""], { busy: "Suche nach Resten …" });
        showLeftovers(p, found, still);
      } catch (e) { fail(e); }
    };
  });
}

function showLeftovers(p, found, still) {
  if (!found.length) return toast(still ? `${p.name} ist noch installiert – keine Reste gesucht.` : `Keine Reste von ${p.name} gefunden.`, "info");
  modal(`<h3>🔍 Reste von ${esc(p.name)}</h3>
    ${still ? `<p class="banner warn inline">⚠ Das Programm ist laut Windows noch installiert. Lösche Ordner erst, wenn die Deinstallation abgeschlossen ist.</p>` : ""}
    <p class="muted small">Prüfe die Pfade, bevor du löschst. Ausgewählte Ordner werden in den Papierkorb verschoben.</p>
    ${found.map((f, i) => `<label class="check"><input type="checkbox" data-lo="${i}" ${still ? "" : "checked"}> <span><code>${esc(f.path)}</code> <span class="muted small">${fmtMB(f.sizeMB)}</span></span></label>`).join("")}
    <div class="row end"><button class="btn ghost" data-close>Abbrechen</button><button class="btn danger" id="lo-del">Ausgewählte löschen</button></div>`,
  (box, close) => {
    $("#lo-del", box).onclick = async () => {
      const paths = $$("[data-lo]", box).filter((c) => c.checked).map((c) => found[Number(c.dataset.lo)].path);
      if (!paths.length) return close();
      close();
      try {
        const r = await api(["files", "delete", ...paths], { busy: "Wird in den Papierkorb verschoben …" });
        const ok = r.filter((x) => x.ok).length;
        toast(`${ok} Ordner in den Papierkorb verschoben.`);
        r.filter((x) => !x.ok).forEach((x) => toast(`${x.path}: ${x.error}`, "error", 8000));
      } catch (e) { fail(e); }
    };
  });
}

async function loadBloat() {
  try {
    const items = await api(["apps", "bloat"]);
    S.loaded.bloat = true;
    $("#bloat-list").innerHTML = items.length ? items.map((a) => `
      <div class="list-item"><div><strong>${esc(a.name)}</strong><div class="cmd">${esc(a.package)} · ${esc(a.version)}</div></div>
      <button class="btn small ghost" data-bloat="${esc(a.fullName)}" data-name="${esc(a.name)}">Entfernen</button></div>`).join("")
      : `<div class="empty">🎉 Keine bekannten vorinstallierten Apps gefunden.</div>`;
    $$("[data-bloat]").forEach((b) => (b.onclick = async () => {
      if (!(await confirmDialog(`${b.dataset.name} entfernen?`, "Die App wird für deinen Benutzer deinstalliert. Du kannst sie jederzeit kostenlos aus dem Microsoft Store neu installieren.", "Entfernen", true))) return;
      try {
        const r = await api(["apps", "remove-bloat", b.dataset.bloat], { busy: "App wird entfernt …" });
        toast(`${r.name} entfernt.`);
        loadBloat();
      } catch (e) { fail(e); }
    }));
  } catch (e) { fail(e); }
}

$("#large-scan").onclick = async () => {
  const argv = ["files", "large", "--min", $("#large-min").value];
  const path = $("#large-path").value.trim().replace(/^"|"$/g, "");
  if (path) argv.push("--path", path);
  try {
    const r = await api(argv, { busy: "Dateien werden durchsucht (max. 90 Sekunden) …" });
    $("#large-path").value = r.root;
    $("#large-list").innerHTML = (r.files.length ? r.files.map((f) => `
      <div class="list-item"><div><strong>${fmtMB(f.sizeMB)}</strong> <span class="muted small">geändert ${new Date(f.modified).toLocaleDateString()}</span>
        <div class="cmd" title="${esc(f.path)}">${esc(f.path)}</div></div>
        <div class="row nowrap"><button class="btn small ghost icon" data-reveal="${esc(f.path)}" title="Im Explorer zeigen">📂</button><button class="btn small ghost icon" data-fdel="${esc(f.path)}" title="In den Papierkorb">🗑</button></div></div>`).join("")
      : `<div class="empty">Keine Dateien über ${$("#large-min").selectedOptions[0].text.replace("ab ", "")} gefunden.</div>`)
      + `<div class="list-item muted small">${r.scanned.toLocaleString()} Dateien durchsucht${r.truncated ? " – Zeitlimit erreicht, Ergebnis unvollständig" : ""}.</div>`;
    $$("[data-reveal]").forEach((b) => (b.onclick = () => api(["files", "reveal", b.dataset.reveal]).catch(fail)));
    $$("[data-fdel]").forEach((b) => (b.onclick = async () => {
      if (!(await confirmDialog("In den Papierkorb verschieben?", `<code>${esc(b.dataset.fdel)}</code>`, "Löschen", true))) return;
      try {
        const [res] = await api(["files", "delete", b.dataset.fdel], { busy: "Wird gelöscht …" });
        if (!res.ok) throw new Error(res.error);
        b.closest(".list-item").remove();
        toast("In den Papierkorb verschoben.");
      } catch (e) { fail(e); }
    }));
  } catch (e) { fail(e); }
};

// ───────────── Network ─────────────
async function loadDns() {
  try {
    S.dns = await api(["dns", "get"]);
    S.loaded.dns = true;
    renderDns();
  } catch (e) { fail(e); }
}
function renderDns() {
  const d = S.dns;
  const active = d.adapters.filter((a) => a.servers.length);
  const provider = active[0]?.provider || "auto";
  $("#dns-current").innerHTML = active.map((a) => `<div><strong>${esc(a.name)}</strong>: ${esc(a.servers.join(", "))} <span class="badge">${provider === "auto" ? "automatisch" : provider === "custom" ? "eigener" : esc(d.providers[a.provider]?.title || a.provider)}</span></div>`).join("") || "Kein aktiver Netzwerkadapter.";
  const opts = [["auto", d.hasBackup ? "Ursprüngliche Einstellung" : "Automatisch (Router)"], ...Object.entries(d.providers).map(([id, p]) => [id, p.title])];
  $("#dns-options").innerHTML = opts.map(([id, title]) => `<button class="btn small ${provider === id ? "primary" : ""}" data-dns="${id}">${esc(title)}</button>`).join("");
  $$("[data-dns]").forEach((b) => (b.onclick = async () => {
    const id = b.dataset.dns;
    if (id === provider) return;
    if (id !== "auto" && !(await confirmDialog(`DNS auf ${S.dns.providers[id].title} umstellen?`, "Gilt für alle aktiven Netzwerkadapter (IPv4 und IPv6). Falls du einen eigenen DNS-Filter nutzt (z. B. Pi-hole oder Router-Kindersicherung), wird dieser damit umgangen. „Ursprüngliche Einstellung“ stellt alles wieder her.", "Umstellen"))) return;
    try {
      await api(["dns", "set", id], { busy: "DNS wird umgestellt …" });
      toast(`DNS umgestellt: ${id === "auto" ? "ursprüngliche Einstellung" : S.dns.providers[id].title}.`);
      loadDns();
    } catch (e) { fail(e); }
  }));
}
$("#dns-bench").onclick = async () => {
  try {
    const r = await api(["dns", "bench"], { busy: "DNS-Server werden verglichen …" });
    const max = Math.max(...r.map((x) => x.avgMs || 0), 1);
    $("#dns-bench-result").innerHTML = r.map((x, i) => `<div class="bench-row"><span>${i === 0 ? "🏆 " : ""}${esc(x.title)}</span>
      <div class="bar"><div style="width:${x.avgMs ? (x.avgMs / max) * 100 : 100}%"></div></div><strong>${x.avgMs != null ? `${x.avgMs} ms` : "–"}</strong></div>`).join("")
      + `<p class="muted small">Durchschnittliche Antwortzeit für ${r[0]?.queries || 16} Anfragen an Spiele- und Plattform-Domains.</p>`;
  } catch (e) { fail(e); }
};
async function runPing(host) {
  if (!host) return toast("Bitte Host oder IP angeben.", "error");
  try {
    const r = await api(["ping", host, "--count", "20"], { busy: `Ping zu ${host} (20 Pakete) …` });
    const rate = (v, good, ok) => (v <= good ? "good" : v <= ok ? "warn" : "bad");
    $("#ping-result").innerHTML = r.received ? `<div class="ping-stats">
      <div><span class="muted small">Ziel</span><strong>${esc(r.host)}</strong></div>
      <div><span class="muted small">Ø Ping</span><strong class="${rate(r.avgMs, 30, 70)}">${r.avgMs} ms</strong></div>
      <div><span class="muted small">Jitter</span><strong class="${rate(r.jitterMs, 3, 10)}">${r.jitterMs} ms</strong></div>
      <div><span class="muted small">Verlust</span><strong class="${rate(r.lossPct, 0, 2)}">${r.lossPct} %</strong></div>
      <div><span class="muted small">Min / Max</span><strong>${r.minMs} / ${r.maxMs} ms</strong></div></div>`
      : `<p class="bad">${esc(r.host)} antwortet nicht (100 % Verlust).</p>`;
  } catch (e) { fail(e); }
}
$$("[data-ping]").forEach((b) => (b.onclick = () => runPing(b.dataset.ping)));
$("#ping-run").onclick = () => runPing($("#ping-host").value.trim());
$("#ping-host").onkeydown = (e) => e.key === "Enter" && runPing($("#ping-host").value.trim());

// ───────────── History ─────────────
const HIST = {
  apply: "✔ Angewendet", revert: "↺ Zurückgesetzt", "boost-start": "🚀 Boost gestartet", "boost-stop": "⏹ Boost beendet", "game-add": "＋ Spiel hinzugefügt", "game-remove": "✕ Spiel entfernt",
  "startup-delete": "🗑 Autostart gelöscht", "startup-restore": "↺ Autostart wiederhergestellt", "ctx-enable": "📋 Kontextmenü eingeblendet", "ctx-disable": "📋 Kontextmenü ausgeblendet",
  "app-uninstall": "🗑 Deinstallation gestartet", "appx-remove": "🗑 App entfernt", "files-delete": "🗑 In Papierkorb verschoben", "take-ownership": "🔑 Besitz übernommen",
  "dns-set": "🧭 DNS umgestellt", update: "⬆️ Aktualisiert", schedule: "🗓️ Automatische Wartung", autoboost: "⚡ Auto-Boost", "profile-import": "⤒ Einstellungen importiert",
};
async function loadHistory() {
  try {
    const h = await api(["history"]);
    const title = (id) => S.tweaks.find((t) => t.id === id)?.title || id;
    const revertable = (e) => e.action === "apply" && (e.tweaks || []).filter((id) => S.tweaks.find((t) => t.id === id)?.hasBackup);
    $("#history-list").innerHTML = h.length ? h.map((e, i) => {
      const detail = e.tweaks ? e.tweaks.map(title).join(", ") : e.paths ? e.paths.join(", ") : e.game ? e.game : e.name ? e.name : e.minutes != null ? `${e.minutes} min` : "";
      const rev = revertable(e);
      return `<div class="list-item"><div><strong>${HIST[e.action] || esc(e.action)}</strong>${e.auto ? ` <span class="badge">Auto-Boost</span>` : ""}
        <div class="cmd" title="${esc(detail)}">${esc(detail)}</div></div>
        <div class="row nowrap"><span class="muted small">${new Date(e.at).toLocaleString()}</span>${rev && rev.length ? `<button class="btn small ghost" data-hist-revert="${i}" title="${esc(rev.map(title).join(", "))}">↺ Zurücksetzen</button>` : ""}</div></div>`;
    }).join("") : `<div class="empty">Noch keine Änderungen.</div>`;
    $$("[data-hist-revert]").forEach((b) => (b.onclick = async () => {
      const ids = revertable(h[Number(b.dataset.histRevert)]);
      if (!(await confirmDialog("Änderung zurücksetzen", `Folgende Optimierungen werden auf ihre ursprünglichen Werte zurückgesetzt:<br><br>${ids.map((id) => esc(title(id))).join("<br>")}`, "Zurücksetzen"))) return;
      await revertTweaks(ids);
      loadHistory();
    }));
  } catch (e) { fail(e); }
}

// ───────────── Updates ─────────────
async function checkForUpdate() {
  try {
    const u = await api(["update", "check"]);
    $("#app-version").textContent = `Version ${u.current}`;
    if (!u.available) return;
    $("#update-text").textContent = `⬆️ GameBoost ${u.latest} ist verfügbar (installiert: ${u.current}).`;
    $("#update-install").textContent = u.kind === "dev" ? "Release ansehen" : u.canInstall ? "Jetzt aktualisieren" : "Installer herunterladen";
    $("#update-banner").classList.remove("hidden");
    $("#update-notes").onclick = () => modal(`<h3>Neu in GameBoost ${esc(u.latest)}</h3>
      <div class="notes">${esc(u.notes || "Keine Versionshinweise.").replace(/\n/g, "<br>")}</div>
      <div class="row end"><button class="btn ghost" data-close>Schließen</button></div>`);
    $("#update-install").onclick = async () => {
      if (u.kind === "dev") return api(["open", u.url]).catch(fail);
      if (!u.canInstall) return api(["open", u.setup || u.url]).catch(fail);
      try {
        const r = await api(["update", "install"], { busy: `GameBoost ${u.latest} wird heruntergeladen und installiert …` });
        if (!r.updated) return toast("GameBoost ist bereits aktuell.", "info");
        showBusy("GameBoost wird neu gestartet …");
        await post("/api/restart").catch(() => {});
        const start = Date.now();
        while (Date.now() - start < 60000) {
          await new Promise((res) => setTimeout(res, 1000));
          try {
            const h = await (await fetch("/api/health", { cache: "no-store" })).json();
            if (h.version === r.to) return location.reload();
          } catch {}
        }
        hideBusy();
        toast("Update installiert – bitte GameBoost neu starten.", "info", 10000);
      } catch (e) { fail(e); }
    };
  } catch {}
}

// ───────────── Admin relaunch & heartbeat ─────────────
$("#relaunch-admin").onclick = async () => {
  showBusy("Warte auf Bestätigung (UAC) …");
  await post("/api/relaunch-admin").catch(() => {});
  // The server restarts elevated on the same port; reload once it is back with a new token.
  const start = Date.now();
  await new Promise((r) => setTimeout(r, 1500));
  while (Date.now() - start < 60000) {
    try {
      const html = await (await fetch("/", { cache: "no-store" })).text();
      if (html.includes("window.GB_ADMIN = true")) return location.reload();
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  hideBusy();
  toast("Neustart als Administrator abgebrochen.", "error");
};

setInterval(async () => {
  try {
    await post("/api/ping");
    const b = await api(["boost", "status"]);
    if (!!b.session !== !!S.session) { S.session = b.session; renderBoostState(); }
  } catch {}
}, 10000);
post("/api/ping").catch(() => {});

refreshAll(true).then(() => {
  const page = location.hash.slice(1);
  if (page && page !== "dashboard" && document.getElementById(`page-${page}`)) go(page);
});
