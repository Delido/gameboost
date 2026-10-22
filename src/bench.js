// Before/after measurement of what the tweaks actually change:
// - timer latency: how long Sleep(1) really takes (timer resolution, power plan)
// - stalls: gaps in a tight loop > 100 µs (DPC/interrupt latency, core parking, C-states)
// - CPU single/multi: fixed integer workload for 2 s each (boost clocks, power plan)
import { runPS } from "./ps.js";
import { loadState, updateState } from "./state.js";

export const BENCH_PS = String.raw`
if (-not ('GBBench' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Threading;
using System.Threading.Tasks;
public static class GBBench {
  public static double[] Sleep1(int n) {
    var r = new double[n]; var sw = new Stopwatch();
    for (int i = 0; i < n; i++) { sw.Restart(); Thread.Sleep(1); r[i] = sw.Elapsed.TotalMilliseconds; }
    return r;
  }
  // returns { stallCount, maxStallMicroseconds }
  public static double[] Stalls(int ms) {
    var sw = Stopwatch.StartNew(); long last = 0, limit = Stopwatch.Frequency * ms / 1000, thr = Stopwatch.Frequency / 10000;
    long count = 0, max = 0;
    while (true) {
      long now = sw.ElapsedTicks;
      long gap = now - last;
      if (gap > thr) { count++; if (gap > max) max = gap; }
      last = now;
      if (now > limit) break;
    }
    return new double[] { count, max * 1000000.0 / Stopwatch.Frequency };
  }
  static long Work(int ms) {
    var sw = Stopwatch.StartNew(); long ops = 0; ulong x = 88172645463325252UL;
    while (sw.ElapsedMilliseconds < ms) {
      for (int i = 0; i < 100000; i++) { x ^= x << 13; x ^= x >> 7; x ^= x << 17; }
      ops++;
    }
    if (x == 42) ops++;
    return ops;
  }
  public static long Single(int ms) { return Work(ms); }
  public static long Multi(int ms) {
    int n = Environment.ProcessorCount; long total = 0; var lk = new object();
    Parallel.For(0, n, new ParallelOptions { MaxDegreeOfParallelism = n }, i => { long o = Work(ms); lock (lk) { total += o; } });
    return total;
  }
}
'@
}
[GBBench]::Single(300) | Out-Null
$s = [GBBench]::Sleep1(400) | Sort-Object
$avg = ($s | Measure-Object -Average).Average
$p99 = $s[[int]([math]::Floor($s.Count * 0.99)) - 1]
$st = [GBBench]::Stalls(3000)
$single = [GBBench]::Single(2000)
$multi = [GBBench]::Multi(2000)
$schemeOut = "$(powercfg /getactivescheme)"
GB-Out @{
  timerAvgMs = [math]::Round($avg, 2); timerP99Ms = [math]::Round($p99, 2)
  stalls = [int]$st[0]; maxStallUs = [math]::Round($st[1])
  cpuSingle = [math]::Round($single / 2.0); cpuMulti = [math]::Round($multi / 2.0)
  powerPlan = if ($schemeOut -match '\((.+)\)\s*$') { $Matches[1] } else { '' }
}
`;

export async function runBenchmark() {
  const r = await runPS(BENCH_PS, null, { timeout: 120000 });
  const entry = { at: new Date().toISOString(), ...r };
  updateState((s) => {
    s.benchmarks.unshift(entry);
    s.benchmarks = s.benchmarks.slice(0, 20);
  });
  return { result: entry, previous: loadState().benchmarks[1] || null };
}

export function listBenchmarks() {
  return loadState().benchmarks;
}

export function clearBenchmarks() {
  updateState((s) => { s.benchmarks = []; });
  return [];
}
