// Local desktop UI: tiny HTTP server on 127.0.0.1 + Edge/Chrome in app mode.
// Security: random per-start token (required header), Host header check against DNS rebinding,
// JSON-only POST (forces CORS preflight, which we never answer).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { execute, parseArgs } from "./commands.js";
import { isAdmin } from "./system.js";
import { DATA_DIR } from "./state.js";
import { psq } from "./ps.js";
import { currentVersion } from "./update.js";

const UI_DIR = fileURLToPath(new URL("../ui/", import.meta.url));
const CLI = fileURLToPath(new URL("../bin/gameboost.js", import.meta.url));
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".ico": "image/x-icon", ".svg": "image/svg+xml" };
// Long-running background commands that must not be started from the UI.
const BLOCKED = new Set(["watch", "autoboost run", "cleanup"]);

function browserCandidates() {
  const pf = process.env.ProgramFiles || "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const local = process.env.LOCALAPPDATA || "";
  return [
    join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
    join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
    join(pf, "Google", "Chrome", "Application", "chrome.exe"),
    join(local, "Google", "Chrome", "Application", "chrome.exe"),
  ];
}

export function openWindow(url) {
  const browser = browserCandidates().find(existsSync);
  if (browser) {
    const profile = join(DATA_DIR, "window");
    mkdirSync(profile, { recursive: true });
    spawn(browser, [`--app=${url}`, `--user-data-dir=${profile}`, "--window-size=1320,880", "--no-first-run", "--no-default-browser-check"], { detached: true, stdio: "ignore" }).unref();
  } else {
    spawn("explorer.exe", [url], { detached: true, stdio: "ignore" }).unref();
  }
}

async function isRunning(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(800) });
    return r.ok && (await r.json()).app === "gameboost";
  } catch {
    return false;
  }
}

export async function startServer({ port = 47821, open = true } = {}) {
  const url = `http://127.0.0.1:${port}/`;
  if (await isRunning(port)) {
    if (open) openWindow(url);
    console.log(`GameBoost läuft bereits: ${url}`);
    return;
  }

  const token = randomBytes(24).toString("hex");
  const admin = await isAdmin();
  let lastPing = 0;
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

  const server = createServer(async (req, res) => {
    const send = (code, body, type = "application/json; charset=utf-8") => {
      res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY" });
      res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };
    if (!allowedHosts.has(req.headers.host)) return send(403, { ok: false, error: "forbidden" });
    const path = new URL(req.url, url).pathname;

    if (req.method === "GET" && path === "/api/health") return send(200, { app: "gameboost", version: currentVersion() });

    if (req.method === "GET" && !path.startsWith("/api/")) {
      const file = path === "/" ? "index.html" : path.slice(1);
      if (!/^[\w.-]+$/.test(file)) return send(404, "Not found", "text/plain");
      try {
        let body = await readFile(join(UI_DIR, file));
        if (file === "index.html") body = body.toString("utf8").replace("__GB_TOKEN__", token).replace("__GB_ADMIN__", String(admin));
        const ext = file.slice(file.lastIndexOf("."));
        return send(200, body, MIME[ext] || "application/octet-stream");
      } catch {
        return send(404, "Not found", "text/plain");
      }
    }

    if (req.method !== "POST" || req.headers["x-gb-token"] !== token || !String(req.headers["content-type"]).startsWith("application/json")) {
      return send(403, { ok: false, error: "forbidden" });
    }

    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 1e6) return send(413, { ok: false, error: "too large" });
    }
    let body;
    try { body = raw ? JSON.parse(raw) : {}; } catch { return send(400, { ok: false, error: "bad json" }); }

    if (path === "/api/ping") {
      lastPing = Date.now();
      return send(200, { ok: true, admin });
    }
    if (path === "/api/relaunch-admin") {
      send(200, { ok: true });
      relaunchElevated(port);
      return;
    }
    if (path === "/api/restart") {
      // After an update: start the new version (same rights) once this process has exited.
      send(200, { ok: true });
      restartServer(port);
      return;
    }
    if (path === "/api/exec") {
      const argv = Array.isArray(body.argv) ? body.argv.map(String) : [];
      const [name, sub] = parseArgs(argv).pos;
      if (!name || BLOCKED.has(name) || BLOCKED.has(`${name} ${sub}`) || name === "ui") return send(400, { ok: false, error: "Befehl nicht erlaubt" });
      try {
        return send(200, { ok: true, data: await execute(argv) });
      } catch (e) {
        return send(200, { ok: false, error: e.message });
      }
    }
    return send(404, { ok: false, error: "not found" });
  });

  await listenWithRetry(server, port);
  console.log(`GameBoost UI: ${url}${admin ? " (Administrator)" : ""}`);
  if (open) openWindow(url);

  // Quit when the window has been closed (no ping for 45 s after the first one).
  setInterval(() => {
    if (lastPing && Date.now() - lastPing > 45000) process.exit(0);
  }, 5000).unref();
}

function listenWithRetry(server, port, tries = 20) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      server.once("error", (e) => {
        if (e.code === "EADDRINUSE" && n > 0) setTimeout(() => attempt(n - 1), 300);
        else reject(e);
      });
      server.listen(port, "127.0.0.1", () => resolve());
    };
    attempt(tries);
  });
}

function restartServer(port) {
  const args = `"${CLI}" ui --port ${port} --no-open`;
  const cmd = `Start-Sleep -Milliseconds 1500; Start-Process -FilePath ${psq(process.execPath)} -ArgumentList ${psq(args)} -WindowStyle Hidden`;
  spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", cmd], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  setTimeout(() => process.exit(0), 300);
}

/** Restart the UI server with admin rights (UAC). The page reloads itself afterwards. */
function relaunchElevated(port) {
  const args = `"${CLI}" ui --port ${port} --no-open`;
  const cmd = `Start-Process -FilePath ${psq(process.execPath)} -ArgumentList ${psq(args)} -Verb RunAs -WindowStyle Hidden`;
  execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", cmd], { windowsHide: true }, (err) => {
    if (!err) setTimeout(() => process.exit(0), 300);
  });
}
