// Schema checks for the declarative catalog: every tweak/action must be well-formed so that
// detect/apply/revert and the UI/CLI/Raycast can rely on it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TWEAKS, CATEGORIES, PRESETS, RISK_LABEL, REBOOT_LABEL, presetTweaks } from "../src/catalog.js";
import { ACTIONS, GROUPS } from "../src/actions.js";

const KINDS = new Set(["DWord", "QWord", "String", "ExpandString", "MultiString", "Binary"]);
const STARTUP = new Set(["Disabled", "Manual", "Automatic"]);

test("tweak ids are unique and kebab-case", () => {
  const ids = TWEAKS.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length, "doppelte IDs");
  for (const id of ids) assert.match(id, /^[a-z0-9]+(-[a-z0-9]+)*$/);
});

test("tweaks have valid metadata", () => {
  const cats = new Set(CATEGORIES.map((c) => c.id));
  for (const t of TWEAKS) {
    assert.ok(cats.has(t.category), `${t.id}: unbekannte Kategorie ${t.category}`);
    assert.ok(t.risk in RISK_LABEL, `${t.id}: risk`);
    assert.ok(t.reboot in REBOOT_LABEL, `${t.id}: reboot`);
    assert.ok([1, 2, 3].includes(t.impact), `${t.id}: impact`);
    assert.ok(t.title && t.description, `${t.id}: Titel/Beschreibung`);
    assert.equal(typeof t.admin, "boolean", `${t.id}: admin`);
    assert.ok(t.ops.length > 0, `${t.id}: keine ops`);
  }
});

test("every operation can be detected, applied and reverted", () => {
  for (const t of TWEAKS) {
    for (const op of t.ops) {
      switch (op.type) {
        case "reg":
          assert.ok(["HKCU", "HKLM"].includes(op.hive), `${t.id}: hive`);
          assert.ok(op.path && !op.path.startsWith("\\") && !op.path.endsWith("\\"), `${t.id}: path ${op.path}`);
          assert.equal(typeof op.name, "string", `${t.id}: name`);
          assert.ok(KINDS.has(op.kind), `${t.id}: kind ${op.kind}`);
          assert.ok(op.value !== undefined, `${t.id}: value`);
          break;
        case "service":
          assert.ok(op.name, `${t.id}: service name`);
          assert.ok(STARTUP.has(op.startup), `${t.id}: startup ${op.startup}`);
          break;
        case "power":
          assert.match(op.sub, /^[0-9a-f-]{36}$/, `${t.id}: sub`);
          assert.match(op.setting, /^[0-9a-f-]{36}$/, `${t.id}: setting`);
          assert.equal(typeof op.ac, "number", `${t.id}: ac`);
          break;
        case "custom":
          for (const k of ["detect", "apply", "revert"]) assert.ok(typeof op[k] === "string" && op[k].trim(), `${t.id}: custom.${k}`);
          assert.match(op.detect, /return/, `${t.id}: detect muss einen Wert zurückgeben`);
          break;
        default:
          assert.fail(`${t.id}: unbekannter op-Typ ${op.type}`);
      }
    }
  }
});

test("presets never contain optional (taste) tweaks and grow monotonically", () => {
  let prev = 0;
  for (const p of PRESETS) {
    const ids = presetTweaks(p.id);
    assert.ok(ids.length > prev, `${p.id} sollte mehr enthalten als das vorherige Profil`);
    prev = ids.length;
    for (const id of ids) assert.ok(!TWEAKS.find((t) => t.id === id).optional, `${p.id} enthält optionales ${id}`);
  }
});

test("maintenance actions are well-formed", () => {
  const groups = new Set(GROUPS.map((g) => g.id));
  const ids = ACTIONS.map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const a of ACTIONS) {
    assert.ok(a.title && a.description && a.icon, `${a.id}: Metadaten`);
    assert.ok(groups.has(a.group), `${a.id}: group`);
    assert.equal(typeof a.admin, "boolean", `${a.id}: admin`);
    assert.match(a.script, /return/, `${a.id}: muss eine Meldung zurückgeben`);
  }
});
