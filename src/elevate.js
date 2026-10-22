// Runs the CLI elevated (UAC prompt) and returns its JSON result.
import { execFile } from "node:child_process";
import { readFile, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { DATA_DIR } from "./state.js";
import { psq } from "./ps.js";

const CLI = fileURLToPath(new URL("../bin/gameboost.js", import.meta.url));

export async function runElevated(args) {
  const dir = join(DATA_DIR, "tmp");
  await mkdir(dir, { recursive: true });
  const out = join(dir, `elev-${randomBytes(6).toString("hex")}.json`);
  const argList = [CLI, ...args, "--json", "--out", out].map((a) => `"${String(a).replace(/"/g, '\\"')}"`).join(" ");
  const cmd = `try { $p = Start-Process -FilePath ${psq(process.execPath)} -ArgumentList ${psq(argList)} -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode } catch { Write-Error 'UAC'; exit 1223 }`;

  await new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", cmd], { windowsHide: true }, () => resolve());
  });
  let text;
  try {
    text = await readFile(out, "utf8");
  } catch {
    throw new Error("Administratorrechte wurden nicht erteilt (UAC abgelehnt).");
  } finally {
    unlink(out).catch(() => {});
  }
  const res = JSON.parse(text);
  if (!res.ok) throw new Error(res.error);
  return res.data;
}
