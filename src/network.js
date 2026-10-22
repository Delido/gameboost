// Network tools: DNS provider switcher (original servers are backed up), DNS benchmark and
// ping/jitter test.
import { execFile } from "node:child_process";
import { join } from "node:path";
import { runPS } from "./ps.js";
import { loadState, updateState, logHistory } from "./state.js";

export const DNS_PROVIDERS = {
  cloudflare: { title: "Cloudflare", v4: ["1.1.1.1", "1.0.0.1"], v6: ["2606:4700:4700::1111", "2606:4700:4700::1001"] },
  google: { title: "Google", v4: ["8.8.8.8", "8.8.4.4"], v6: ["2001:4860:4860::8888", "2001:4860:4860::8844"] },
  quad9: { title: "Quad9", v4: ["9.9.9.9", "149.112.112.112"], v6: ["2620:fe::fe", "2620:fe::9"] },
  adguard: { title: "AdGuard (Werbefilter)", v4: ["94.140.14.14", "94.140.15.15"], v6: ["2a10:50c0::ad1:ff", "2a10:50c0::ad2:ff"] },
};

export const DNS_PS = String.raw`
function GB-Adapters {
  @(Get-NetAdapter -Physical -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'Up' })
}
function GB-StaticDns($a) {
  $out = @{}
  foreach ($v in @(@{ fam = 'v4'; key = "SYSTEM\CurrentControlSet\Services\Tcpip\Parameters\Interfaces\$($a.InterfaceGuid)" }, @{ fam = 'v6'; key = "SYSTEM\CurrentControlSet\Services\Tcpip6\Parameters\Interfaces\$($a.InterfaceGuid)" })) {
    $ns = GB-RegGet 'HKLM' $v.key 'NameServer'
    $out[$v.fam] = if ($ns.exists -and $ns.value) { @(([string]$ns.value) -split '[,\s]+' | Where-Object { $_ }) } else { @() }
  }
  return $out
}
switch ($GB_IN.mode) {
  'get' {
    $res = @()
    foreach ($a in GB-Adapters) {
      $cur = @(Get-DnsClientServerAddress -InterfaceIndex $a.ifIndex -ErrorAction SilentlyContinue | ForEach-Object { $_.ServerAddresses })
      $st = GB-StaticDns $a
      $res += @{ name = $a.Name; description = $a.InterfaceDescription; index = $a.ifIndex; servers = @($cur | Where-Object { $_ }); static = (($st.v4.Count + $st.v6.Count) -gt 0) }
    }
    GB-Out @{ adapters = $res }
  }
  'backup' {
    $res = @{}
    foreach ($a in GB-Adapters) { $res["$($a.InterfaceGuid)"] = GB-StaticDns $a }
    GB-Out $res
  }
  'set' {
    foreach ($a in GB-Adapters) {
      $g = "$($a.InterfaceGuid)"
      if ($GB_IN.servers) { Set-DnsClientServerAddress -InterfaceIndex $a.ifIndex -ServerAddresses @($GB_IN.servers) }
      else {
        $b = if ($GB_IN.backup) { $GB_IN.backup.$g } else { $null }
        $orig = if ($b) { @($b.v4) + @($b.v6) | Where-Object { $_ } } else { @() }
        if ($orig.Count) { Set-DnsClientServerAddress -InterfaceIndex $a.ifIndex -ServerAddresses $orig }
        else { Set-DnsClientServerAddress -InterfaceIndex $a.ifIndex -ResetServerAddresses }
      }
    }
    Clear-DnsClientCache
    GB-Out @{ ok = $true }
  }
  'bench' {
    $domains = @('google.com', 'youtube.com', 'steampowered.com', 'epicgames.com', 'riotgames.com', 'discord.com', 'twitch.tv', 'ea.com')
    $res = @()
    foreach ($s in $GB_IN.servers) {
      $times = @(); $fail = 0
      foreach ($round in 1..2) {
        foreach ($d in $domains) {
          $sw = [Diagnostics.Stopwatch]::StartNew()
          try { Resolve-DnsName -Name $d -Server $s.ip -Type A -DnsOnly -NoHostsFile -QuickTimeout -ErrorAction Stop | Out-Null; $times += $sw.Elapsed.TotalMilliseconds }
          catch { $fail++ }
        }
      }
      $avg = if ($times.Count) { [math]::Round(($times | Measure-Object -Average).Average, 1) } else { $null }
      $res += @{ id = $s.id; title = $s.title; ip = $s.ip; avgMs = $avg; failed = $fail; queries = $times.Count + $fail }
    }
    GB-Out @{ results = $res }
  }
}
`;

export async function getDns() {
  const r = await runPS(DNS_PS, { mode: "get" });
  const adapters = r?.adapters || [];
  for (const a of adapters) {
    const match = Object.entries(DNS_PROVIDERS).find(([, p]) => a.servers.length && a.servers.every((s) => p.v4.includes(s) || p.v6.includes(s)));
    a.provider = a.static ? (match ? match[0] : "custom") : "auto";
  }
  return { adapters, providers: DNS_PROVIDERS, hasBackup: !!loadState().dnsBackup };
}

/** provider: cloudflare | google | quad9 | adguard | auto (= original servers / DHCP). */
export async function setDns(provider) {
  if (provider !== "auto" && !DNS_PROVIDERS[provider]) throw new Error(`Unbekannter DNS-Anbieter: ${provider} (${Object.keys(DNS_PROVIDERS).join(", ")}, auto)`);
  const state = loadState();
  if (provider === "auto") {
    await runPS(DNS_PS, { mode: "set", servers: null, backup: state.dnsBackup });
    updateState((s) => { s.dnsBackup = null; logHistory(s, { action: "dns-set", name: "Automatisch / ursprünglich" }); });
    return { provider };
  }
  // Keep the very first original configuration (like tweak backups).
  if (!state.dnsBackup) {
    const backup = await runPS(DNS_PS, { mode: "backup" });
    updateState((s) => { s.dnsBackup = backup || {}; });
  }
  const p = DNS_PROVIDERS[provider];
  await runPS(DNS_PS, { mode: "set", servers: [...p.v4, ...p.v6] });
  updateState((s) => logHistory(s, { action: "dns-set", name: p.title }));
  return { provider };
}

export async function benchDns() {
  const current = (await getDns()).adapters.flatMap((a) => a.servers).find((s) => /^\d+\.\d+\.\d+\.\d+$/.test(s));
  const servers = [
    ...(current && !Object.values(DNS_PROVIDERS).some((p) => p.v4.includes(current)) ? [{ id: "current", title: "Aktueller DNS (Router/Provider)", ip: current }] : []),
    ...Object.entries(DNS_PROVIDERS).map(([id, p]) => ({ id, title: p.title, ip: p.v4[0] })),
  ];
  const r = await runPS(DNS_PS, { mode: "bench", servers }, { timeout: 120000 });
  return (r?.results || []).sort((a, b) => (a.avgMs ?? 1e9) - (b.avgMs ?? 1e9));
}

const PING = join(process.env.SystemRoot || "C:\\Windows", "System32", "PING.EXE");

/** Ping statistics incl. jitter (mean deviation of consecutive round trips). "gateway" = router. */
export async function ping(host, count = 20) {
  if (host === "gateway") {
    const r = await runPS(String.raw`GB-Out @{ gw = [string](Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Sort-Object RouteMetric | Select-Object -First 1).NextHop }`);
    if (!r?.gw) throw new Error("Kein Standardgateway gefunden");
    host = r.gw;
  }
  if (!/^[a-z0-9.\-:]+$/i.test(String(host || ""))) throw new Error(`Ungültiger Host: ${host}`);
  count = Math.min(100, Math.max(1, Number(count) || 20));
  const out = await new Promise((resolve, reject) => {
    execFile(PING, ["-n", String(count), "-w", "1000", host], { windowsHide: true, timeout: count * 1500 + 5000 }, (err, stdout) => {
      if (!stdout && err) reject(new Error(err.message)); else resolve(String(stdout));
    });
  });
  const times = out.split(/\r?\n/).filter((l) => /TTL=/i.test(l)).map((l) => { const m = l.match(/[=<]\s*(\d+)\s*ms/i); return m ? Number(m[1]) : null; }).filter((x) => x !== null);
  if (!times.length) return { host, sent: count, received: 0, lossPct: 100 };
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const jitter = times.length > 1 ? times.slice(1).reduce((s, t, i) => s + Math.abs(t - times[i]), 0) / (times.length - 1) : 0;
  return {
    host, sent: count, received: times.length, lossPct: Math.round(((count - times.length) / count) * 100),
    minMs: Math.min(...times), maxMs: Math.max(...times), avgMs: Math.round(avg * 10) / 10, jitterMs: Math.round(jitter * 10) / 10,
  };
}
