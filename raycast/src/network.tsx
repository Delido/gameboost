import { Action, ActionPanel, Alert, Color, confirmAlert, Icon, List, showToast, Toast } from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { useState } from "react";
import { gb } from "./lib";

interface DnsData {
  adapters: { name: string; description: string; servers: string[]; provider: string }[];
  providers: Record<string, { title: string; v4: string[] }>;
  hasBackup: boolean;
}
interface PingResult { host: string; received: number; lossPct: number; avgMs?: number; jitterMs?: number; minMs?: number; maxMs?: number }
interface BenchResult { id: string; title: string; ip: string; avgMs: number | null }

export default function Command() {
  const [search, setSearch] = useState("");
  const [ping, setPing] = useState<PingResult | null>(null);
  const [bench, setBench] = useState<BenchResult[] | null>(null);
  const dns = usePromise(() => gb<DnsData>(["dns", "get"]));
  const current = dns.data?.adapters.find((a) => a.servers.length)?.provider || "auto";

  async function setDns(id: string, title: string) {
    if (id !== "auto") {
      const ok = await confirmAlert({ title: `DNS auf ${title} umstellen?`, message: "Gilt für alle aktiven Adapter. Ein eigener DNS-Filter (z. B. Pi-hole) wird damit umgangen.", primaryAction: { title: "Umstellen", style: Alert.ActionStyle.Default } });
      if (!ok) return;
    }
    const toast = await showToast({ style: Toast.Style.Animated, title: "DNS wird umgestellt …" });
    try {
      await gb(["dns", "set", id]);
      toast.style = Toast.Style.Success;
      toast.title = `DNS: ${title}`;
      dns.revalidate();
    } catch (e) {
      toast.style = Toast.Style.Failure;
      toast.title = "Fehlgeschlagen";
      toast.message = (e as Error).message;
    }
  }

  async function runPing(host: string) {
    const toast = await showToast({ style: Toast.Style.Animated, title: `Ping zu ${host} …` });
    try {
      const r = await gb<PingResult>(["ping", host, "--count", "20"]);
      setPing(r);
      toast.style = r.received ? Toast.Style.Success : Toast.Style.Failure;
      toast.title = r.received ? `${r.host}: Ø ${r.avgMs} ms · Jitter ${r.jitterMs} ms · Verlust ${r.lossPct} %` : `${r.host} antwortet nicht`;
    } catch (e) {
      toast.style = Toast.Style.Failure;
      toast.title = "Fehlgeschlagen";
      toast.message = (e as Error).message;
    }
  }

  async function runBench() {
    const toast = await showToast({ style: Toast.Style.Animated, title: "DNS-Server werden verglichen …" });
    try {
      const r = await gb<BenchResult[]>(["dns", "bench"]);
      setBench(r);
      toast.style = Toast.Style.Success;
      toast.title = `Schnellster: ${r[0]?.title} (${r[0]?.avgMs} ms)`;
    } catch (e) {
      toast.style = Toast.Style.Failure;
      toast.title = "Fehlgeschlagen";
      toast.message = (e as Error).message;
    }
  }

  const providers = dns.data ? [["auto", dns.data.hasBackup ? "Ursprüngliche Einstellung" : "Automatisch (Router)"], ...Object.entries(dns.data.providers).map(([id, p]) => [id, p.title])] : [];
  const host = search.trim();

  return (
    <List isLoading={dns.isLoading} searchBarPlaceholder="Host für Ping eingeben (Enter) …" onSearchTextChange={setSearch} filtering={false}>
      {host && (
        <List.Section title="Ping">
          <List.Item icon={Icon.Wifi} title={`Ping zu ${host}`} actions={<ActionPanel><Action title="Messen" icon={Icon.Play} onAction={() => runPing(host)} /></ActionPanel>} />
        </List.Section>
      )}
      {ping && (
        <List.Section title="Letzte Messung">
          <List.Item
            icon={{ source: Icon.Gauge, tintColor: ping.lossPct > 0 || (ping.jitterMs ?? 0) > 10 ? Color.Orange : Color.Green }}
            title={ping.host}
            subtitle={ping.received ? `Ø ${ping.avgMs} ms · min ${ping.minMs} · max ${ping.maxMs}` : "keine Antwort"}
            accessories={[{ text: `Jitter ${ping.jitterMs ?? "–"} ms` }, { text: `Verlust ${ping.lossPct} %` }]}
          />
        </List.Section>
      )}
      <List.Section title="DNS-Server" subtitle={dns.data?.adapters.filter((a) => a.servers.length).map((a) => `${a.name}: ${a.servers.join(", ")}`).join(" · ")}>
        {providers.map(([id, title]) => {
          const b = bench?.find((x) => x.id === id);
          return (
            <List.Item
              key={id}
              icon={current === id ? { source: Icon.CheckCircle, tintColor: Color.Green } : Icon.Circle}
              title={title}
              accessories={b?.avgMs != null ? [{ text: `${b.avgMs} ms` }] : []}
              actions={
                <ActionPanel>
                  <Action title="Verwenden" icon={Icon.CheckCircle} onAction={() => setDns(id, title)} />
                  <Action title="DNS-Server vergleichen" icon={Icon.Stopwatch} shortcut={{ modifiers: ["ctrl"], key: "b" }} onAction={runBench} />
                </ActionPanel>
              }
            />
          );
        })}
      </List.Section>
      <List.Section title="Ping-Ziele">
        {[["gateway", "Router"], ["1.1.1.1", "Cloudflare"], ["8.8.8.8", "Google"]].map(([h, title]) => (
          <List.Item key={h} icon={Icon.Wifi} title={title} subtitle={h === "gateway" ? "Standardgateway" : h} actions={<ActionPanel><Action title="Ping messen" icon={Icon.Play} onAction={() => runPing(h)} /></ActionPanel>} />
        ))}
      </List.Section>
    </List>
  );
}
