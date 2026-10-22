// Tweak engine: detect / apply / revert. All operations of a request are compiled into a
// single PowerShell script so that even "detect everything" is one process launch.
import { runPS } from "./ps.js";
import { TWEAKS, getTweak, presetTweaks } from "./catalog.js";
import { loadState, updateState, logHistory } from "./state.js";

const SERVICE_START = { Automatic: 2, Manual: 3, Disabled: 4 };

export const DISPATCH_PS = String.raw`
$GB_RESULTS = @{}
foreach ($op in $GB_IN.ops) {
  $r = @{}
  try {
    switch ($op.type) {
      'reg' {
        $cur = GB-RegGet $op.hive $op.path $op.name
        if ($GB_IN.mode -eq 'detect') {
          # A missing value means "Windows default" – applied if that default already is the target.
          $r.applied = [bool](($cur.exists -and ("$($cur.value)" -eq "$($op.value)")) -or (-not $cur.exists -and $null -ne $op.def -and ("$($op.def)" -eq "$($op.value)")))
          $r.current = $cur
        } elseif ($GB_IN.mode -eq 'apply') {
          $r.backup = $cur
          GB-RegSet $op.hive $op.path $op.name $op.kind $op.value
        } else {
          $b = $op.backup
          if ($b) {
            if ($b.exists) { GB-RegSet $op.hive $op.path $op.name $b.kind $b.value } else { GB-RegDel $op.hive $op.path $op.name }
          } elseif ($null -ne $op.def) { GB-RegSet $op.hive $op.path $op.name $op.kind $op.def }
          else { GB-RegDel $op.hive $op.path $op.name }
        }
      }
      'service' {
        $p = "SYSTEM\CurrentControlSet\Services\$($op.name)"
        $cur = GB-RegGet 'HKLM' $p 'Start'
        if (-not $cur.exists) { $r.missing = $true; break }
        if ($GB_IN.mode -eq 'detect') {
          $r.applied = [bool]($cur.value -eq $op.start)
          $r.current = $cur
        } elseif ($GB_IN.mode -eq 'apply') {
          $r.backup = @{ start = $cur.value; delayed = (GB-RegGet 'HKLM' $p 'DelayedAutostart') }
          GB-RegSet 'HKLM' $p 'Start' 'DWord' $op.start
          if ($op.start -eq 4) { Stop-Service -Name $op.name -Force -ErrorAction SilentlyContinue -WarningAction SilentlyContinue }
        } else {
          $b = $op.backup
          $start = if ($b) { $b.start } else { 3 }
          GB-RegSet 'HKLM' $p 'Start' 'DWord' $start
          if ($b -and $b.delayed -and $b.delayed.exists) { GB-RegSet 'HKLM' $p 'DelayedAutostart' 'DWord' $b.delayed.value }
          if ($start -eq 2) { Start-Service -Name $op.name -ErrorAction SilentlyContinue -WarningAction SilentlyContinue }
        }
      }
      'power' {
        $cur = GB-PowerGet $op.sub $op.setting
        if ($null -eq $cur) { $r.missing = $true; break }
        if ($GB_IN.mode -eq 'detect') {
          $r.applied = [bool]($cur -eq $op.ac)
          $r.current = $cur
        } elseif ($GB_IN.mode -eq 'apply') {
          $r.backup = @{ ac = $cur }
          GB-PowerSet $op.sub $op.setting $op.ac
        } else {
          if ($op.backup) { GB-PowerSet $op.sub $op.setting $op.backup.ac }
        }
      }
      'custom' {
        $sb = $GB_CUSTOM[$op.key]
        $res = & $sb $op.backup
        if ($GB_IN.mode -eq 'detect') { $r.applied = [bool]$res }
        elseif ($GB_IN.mode -eq 'apply') { $r.backup = $res }
      }
    }
  } catch {
    $r.error = $_.Exception.Message
  }
  $GB_RESULTS[$op.key] = $r
}
GB-Out $GB_RESULTS
`;

/** Build ops list (with stable keys) + the custom script blocks for the given tweaks. */
function compile(tweaks, mode, backups) {
  const ops = [];
  const customs = [];
  for (const t of tweaks) {
    t.ops.forEach((op, i) => {
      const key = `${t.id}#${i}`;
      const entry = { ...op, key, backup: backups?.[t.id]?.[i] ?? null };
      if (op.type === "service") entry.start = SERVICE_START[op.startup];
      if (op.type === "custom") {
        delete entry.detect; delete entry.apply; delete entry.revert;
        customs.push(`  '${key}' = { param($backup)\n${op[mode]}\n  }`);
      }
      ops.push(entry);
    });
  }
  const customPs = `$GB_CUSTOM = @{\n${customs.join("\n")}\n}\n`;
  return { ops, script: customPs + DISPATCH_PS };
}

function statusFromOps(t, results) {
  const rs = t.ops.map((_, i) => results[`${t.id}#${i}`] || {});
  const relevant = rs.filter((r) => !r.missing);
  const errors = rs.filter((r) => r.error).map((r) => r.error);
  if (relevant.length === 0) return { status: "unavailable", errors };
  if (relevant.every((r) => r.error)) return { status: "unknown", errors };
  const applied = relevant.filter((r) => r.applied).length;
  const status = applied === relevant.length ? "applied" : applied === 0 ? "default" : "partial";
  return { status, errors };
}

/** Detect the state of all (or the given) tweaks. */
export async function detect(ids = null) {
  const tweaks = ids ? ids.map(getTweak) : TWEAKS;
  const state = loadState();
  const { ops, script } = compile(tweaks, "detect", state.backups);
  const results = (await runPS(script, { mode: "detect", ops })) || {};
  return tweaks.map((t) => ({ ...publicTweak(t), ...statusFromOps(t, results), hasBackup: !!state.backups[t.id] }));
}

/** Apply tweaks. Keeps the *first* backup so that re-applying never loses the original value. */
export async function apply(ids) {
  const tweaks = ids.map(getTweak);
  const { ops, script } = compile(tweaks, "apply", null);
  const results = (await runPS(script, { mode: "apply", ops })) || {};
  return updateState((state) => {
    const out = [];
    for (const t of tweaks) {
      const rs = t.ops.map((_, i) => results[`${t.id}#${i}`] || {});
      const errors = rs.filter((r) => r.error).map((r) => r.error);
      if (!state.backups[t.id]) state.backups[t.id] = rs.map((r) => r.backup ?? null);
      else state.backups[t.id] = state.backups[t.id].map((b, i) => b ?? rs[i]?.backup ?? null);
      out.push({ id: t.id, title: t.title, ok: errors.length === 0, errors, reboot: t.reboot });
    }
    logHistory(state, { action: "apply", tweaks: ids });
    return out;
  });
}

/** Revert tweaks to their backed-up original values (or Windows defaults). */
export async function revert(ids) {
  const state = loadState();
  const tweaks = ids.map(getTweak);
  const { ops, script } = compile(tweaks, "revert", state.backups);
  const results = (await runPS(script, { mode: "revert", ops })) || {};
  return updateState((s) => {
    const out = [];
    for (const t of tweaks) {
      const rs = t.ops.map((_, i) => results[`${t.id}#${i}`] || {});
      const errors = rs.filter((r) => r.error).map((r) => r.error);
      if (errors.length === 0) delete s.backups[t.id];
      out.push({ id: t.id, title: t.title, ok: errors.length === 0, errors, reboot: t.reboot });
    }
    logHistory(s, { action: "revert", tweaks: ids });
    return out;
  });
}

export async function applyPreset(presetId) {
  return apply(presetTweaks(presetId));
}

/** Revert everything GameBoost has changed (all tweaks with a backup). */
export async function revertAll() {
  const ids = Object.keys(loadState().backups).filter((id) => TWEAKS.some((t) => t.id === id));
  if (ids.length === 0) return [];
  return revert(ids);
}

/** 0–100 score: weighted share of applied safe/moderate tweaks (optional categories excluded). */
export function score(detected) {
  const relevant = detected.filter((t) => t.risk !== "advanced" && !t.optional && t.status !== "unavailable");
  const total = relevant.reduce((s, t) => s + t.impact, 0);
  const got = relevant.reduce((s, t) => s + (t.status === "applied" ? t.impact : t.status === "partial" ? t.impact / 2 : 0), 0);
  return total ? Math.round((got / total) * 100) : 0;
}

export function publicTweak(t) {
  const { ops, ...rest } = t;
  return rest;
}

export function needsAdmin(ids) {
  return ids.some((id) => getTweak(id).admin);
}
