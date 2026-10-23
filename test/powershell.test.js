// Parses every embedded PowerShell script with the real PowerShell parser (no execution).
// Catches syntax errors in scripts that only run on rarely used code paths.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PS_PRELUDE } from "../src/ps.js";
import { TWEAKS } from "../src/catalog.js";
import { ACTIONS } from "../src/actions.js";

const MODULES = ["actions", "apps", "bench", "boost", "catalog", "checks", "contextmenu", "engine", "files", "games", "install", "network", "registry", "schedule", "session", "startup", "system", "tray"];

async function collectScripts() {
  const scripts = { prelude: PS_PRELUDE };
  for (const m of MODULES) {
    const mod = await import(`../src/${m}.js`);
    for (const [name, value] of Object.entries(mod)) if (name.endsWith("_PS") && typeof value === "string") scripts[`${m}.${name}`] = value;
  }
  for (const t of TWEAKS) {
    t.ops.forEach((op, i) => {
      if (op.type === "custom") for (const k of ["detect", "apply", "revert"]) scripts[`tweak.${t.id}#${i}.${k}`] = `& { param($backup)\n${op[k]}\n}`;
    });
  }
  for (const a of ACTIONS) scripts[`action.${a.id}`] = `$m = & {\n${a.script}\n}`;
  return scripts;
}

const PARSER = String.raw`
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$errs = @{}
foreach ($f in Get-ChildItem -LiteralPath $args[0] -Filter *.ps1) {
  $tokens = $null; $e = $null
  [System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$tokens, [ref]$e) | Out-Null
  if ($e.Count) { $errs[$f.BaseName] = @($e | ForEach-Object { "Zeile $($_.Extent.StartLineNumber): $($_.Message)" }) }
}
$errs | ConvertTo-Json -Depth 4 -Compress
`;

test("all embedded PowerShell scripts parse without errors", { skip: process.platform !== "win32" }, async () => {
  const scripts = await collectScripts();
  const dir = mkdtempSync(join(tmpdir(), "gb-ps-"));
  try {
    const names = Object.keys(scripts);
    names.forEach((n, i) => writeFileSync(join(dir, `${i}.ps1`), "﻿" + scripts[n], "utf8"));
    writeFileSync(join(dir, "parse.ps1.txt"), PARSER, "utf8");
    const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `& ([scriptblock]::Create((Get-Content -Raw -LiteralPath '${join(dir, "parse.ps1.txt")}'))) '${dir}'`], { encoding: "utf8" }).trim();
    const errors = out && out !== "{}" ? JSON.parse(out) : {};
    const report = Object.entries(errors).map(([i, e]) => `${names[Number(i)]}:\n  ${[].concat(e).join("\n  ")}`);
    assert.equal(report.length, 0, `Syntaxfehler:\n${report.join("\n")}`);
    assert.ok(names.length > 40, "zu wenige Skripte gefunden");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
