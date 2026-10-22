import { Action, ActionPanel, Color, Icon, List, showToast, Toast } from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { useState } from "react";
import { CtxItem, gb, statusIcon, summarize, Tweak, TweakResult } from "./lib";

const KIND: Record<CtxItem["kind"], string> = { extension: "Erweiterung", verb: "Befehl", app: "App (Win 11)" };

async function restartExplorer() {
  await gb(["run", "restart-explorer"]);
  await showToast({ title: "Explorer neu gestartet" });
}

export default function Command() {
  const [all, setAll] = useState(false);
  const tweaks = usePromise(() => gb<{ tweaks: Tweak[] }>(["list", "--category", "contextmenu"]));
  const items = usePromise((showAll: boolean) => gb<CtxItem[]>(["ctx", "list", ...(showAll ? ["--all"] : [])]), [all]);

  async function runTweak(t: Tweak) {
    const apply = t.status !== "applied";
    const toast = await showToast({ style: Toast.Style.Animated, title: `${t.title} …` });
    try {
      const r = await gb<{ results: TweakResult[] }>([apply ? "apply" : "revert", t.id]);
      const s = summarize(r.results, apply ? "angewendet" : "zurückgesetzt");
      toast.style = s.failed ? Toast.Style.Failure : Toast.Style.Success;
      toast.title = s.title;
      toast.message = t.reboot === "explorer" ? "Explorer neu starten (Strg+E)" : s.message;
      tweaks.revalidate();
    } catch (e) {
      toast.style = Toast.Style.Failure;
      toast.title = "Fehlgeschlagen";
      toast.message = (e as Error).message;
    }
  }

  async function toggle(x: CtxItem) {
    const enable = !x.enabled;
    try {
      await items.mutate(gb(["ctx", enable ? "enable" : "disable", x.id, "--name", x.name]), {
        optimisticUpdate: (list) => (list || []).map((i) => (i.id === x.id ? { ...i, enabled: enable } : i)),
      });
      await showToast({ title: `${enable ? "Eingeblendet" : "Ausgeblendet"}: ${x.name}`, message: "Explorer neu starten (Strg+E)" });
    } catch (e) {
      await showToast({ style: Toast.Style.Failure, title: "Fehler", message: (e as Error).message });
    }
  }

  const explorerAction = <Action title="Explorer neu starten" icon={Icon.RotateClockwise} shortcut={{ modifiers: ["ctrl"], key: "e" }} onAction={restartExplorer} />;

  return (
    <List
      isLoading={tweaks.isLoading || items.isLoading}
      searchBarPlaceholder="Kontextmenü-Eintrag suchen …"
      searchBarAccessory={
        <List.Dropdown tooltip="Anzeige" value={all ? "all" : "third"} onChange={(v) => setAll(v === "all")}>
          <List.Dropdown.Item title="Nur Drittanbieter" value="third" />
          <List.Dropdown.Item title="Inkl. Microsoft" value="all" />
        </List.Dropdown>
      }
    >
      <List.Section title="Windows-Einträge & Erweiterungen">
        {(tweaks.data?.tweaks || []).map((t) => (
          <List.Item
            key={t.id}
            icon={statusIcon(t.status)}
            title={t.title}
            subtitle={t.description}
            actions={
              <ActionPanel>
                <Action title={t.status === "applied" ? "Zurücksetzen" : "Anwenden"} icon={t.status === "applied" ? Icon.ArrowCounterClockwise : Icon.CheckCircle} onAction={() => runTweak(t)} />
                {explorerAction}
              </ActionPanel>
            }
          />
        ))}
      </List.Section>
      <List.Section title="Einträge von Programmen" subtitle={String(items.data?.length ?? "")}>
        {(items.data || []).map((x) => (
          <List.Item
            key={`${x.kind}-${x.id}-${x.locations.join()}`}
            icon={x.enabled ? { source: Icon.Eye, tintColor: Color.Green } : { source: Icon.EyeDisabled, tintColor: Color.SecondaryText }}
            title={x.name}
            subtitle={x.publisher}
            keywords={[x.path, ...x.locations]}
            accessories={[{ tag: KIND[x.kind] }, { text: x.locations.join(", ") }]}
            actions={
              <ActionPanel>
                <Action title={x.enabled ? "Ausblenden" : "Einblenden"} icon={x.enabled ? Icon.EyeDisabled : Icon.Eye} onAction={() => toggle(x)} />
                {explorerAction}
                <Action.CopyToClipboard title="Pfad kopieren" content={x.path} />
              </ActionPanel>
            }
          />
        ))}
      </List.Section>
    </List>
  );
}
