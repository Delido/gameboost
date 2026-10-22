import { Action, ActionPanel, Color, Detail, Icon, launchCommand, LaunchType } from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { Check, gb, openApp, sessionText, StatusData } from "./lib";

const CHECK_ICON: Record<Check["status"], string> = { ok: "✅", info: "ℹ️", warn: "⚠️", bad: "⛔" };

function bar(pct: number, width = 20) {
  const n = Math.round((Math.max(0, Math.min(100, pct)) / 100) * width);
  return "█".repeat(n) + "░".repeat(width - n);
}

export default function Command() {
  const { data, isLoading, revalidate } = usePromise(() => gb<StatusData>(["status"]));
  const checks = usePromise(() => gb<Check[]>(["check"]));
  const issues = (checks.data || []).filter((c) => c.status !== "ok");

  let markdown = "Analysiere System …";
  if (data) {
    const i = data.info;
    const ramUsed = i.ram.totalGB - i.ram.freeGB;
    const label = data.score >= 85 ? "Optimal eingestellt" : data.score >= 50 ? "Gut – da geht noch mehr" : "Viel ungenutztes Potenzial";
    markdown = [
      `# ⚡ Optimierungs-Score: ${data.score} / 100`,
      `\`${bar(data.score)}\`  **${label}** – ${data.applied} von ${data.total} Optimierungen aktiv`,
      "",
      data.session ? `### 🚀 Game Boost aktiv\n${sessionText(data.session)}` : "### Game Boost ist aus",
      "",
      "## System",
      `**CPU** · ${i.cpu.name} (${i.cpu.cores} Kerne / ${i.cpu.threads} Threads)`,
      "",
      ...i.gpus.map((g) => `**GPU** · ${g.name} – ${g.vramGB} GB VRAM · Treiber ${g.driver} · ${g.resolution} @ ${g.refresh} Hz\n`),
      `**RAM** · ${i.ram.totalGB} GB – \`${bar((ramUsed / i.ram.totalGB) * 100, 14)}\` ${ramUsed.toFixed(1)} GB belegt`,
      "",
      ...i.disks.map((d) => `**${d.letter}** ${d.media && d.media !== "Unspecified" ? `(${d.media})` : ""} – \`${bar(((d.sizeGB - d.freeGB) / d.sizeGB) * 100, 14)}\` ${d.freeGB} GB frei von ${d.sizeGB} GB\n`),
      "## Systemcheck",
      checks.isLoading ? "_Hardware wird geprüft …_" : issues.length ? issues.map((c) => `${CHECK_ICON[c.status]} **${c.title}** – ${c.detail}`).join("\n\n") : "✅ Keine Auffälligkeiten (Bildwiederholrate, RAM, Treiber, Laufwerke).",
    ].join("\n");
  }

  return (
    <Detail
      isLoading={isLoading || checks.isLoading}
      markdown={markdown}
      metadata={
        data && (
          <Detail.Metadata>
            <Detail.Metadata.Label title="Computer" text={data.info.computer} />
            <Detail.Metadata.Label title="Windows" text={`${data.info.os.name.replace("Microsoft ", "")} (Build ${data.info.os.build})`} />
            <Detail.Metadata.Label title="Laufzeit" text={`${data.info.os.uptimeHours} h`} />
            <Detail.Metadata.Label title="Energieplan" text={data.info.powerPlan.name} />
            <Detail.Metadata.Separator />
            <Detail.Metadata.TagList title="Game Boost">
              <Detail.Metadata.TagList.Item text={data.session ? "Aktiv" : "Aus"} color={data.session ? Color.Green : Color.SecondaryText} />
            </Detail.Metadata.TagList>
            <Detail.Metadata.Label title="Spiele in Bibliothek" text={String(data.games)} />
          </Detail.Metadata>
        )
      }
      actions={
        <ActionPanel>
          <Action title="GameBoost öffnen" icon={Icon.AppWindow} onAction={openApp} />
          <Action title="Game Boost umschalten" icon={Icon.Rocket} onAction={async () => { await launchCommand({ name: "toggle-boost", type: LaunchType.UserInitiated }); }} />
          <Action title="Optimierungen anzeigen" icon={Icon.List} onAction={() => launchCommand({ name: "optimizations", type: LaunchType.UserInitiated })} />
          {issues.filter((c) => c.fix?.type === "url" || c.fix?.type === "uri").map((c) => (
            <Action.Open key={c.id} title={`${c.fix?.label}: ${c.title}`} target={c.fix?.value || ""} icon={Icon.Link} />
          ))}
          <Action title="Neu laden" icon={Icon.Repeat} shortcut={{ modifiers: ["ctrl"], key: "r" }} onAction={() => { revalidate(); checks.revalidate(); }} />
        </ActionPanel>
      }
    />
  );
}
