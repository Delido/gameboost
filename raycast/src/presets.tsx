import { Action, ActionPanel, Alert, confirmAlert, Icon, List, showToast, Toast } from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { gb, Preset, summarize, TweakResult } from "./lib";

export default function Command() {
  const { data, isLoading } = usePromise(() => gb<Preset[]>(["presets"]));

  async function apply(p: Preset, restorePoint: boolean) {
    if (p.id === "max") {
      const ok = await confirmAlert({ title: p.title, message: p.description, primaryAction: { title: "Alles anwenden", style: Alert.ActionStyle.Destructive } });
      if (!ok) return;
    }
    const toast = await showToast({ style: Toast.Style.Animated, title: `„${p.title}“ wird angewendet …`, message: restorePoint ? "inkl. Wiederherstellungspunkt" : undefined });
    try {
      const r = await gb<{ results: TweakResult[]; restorePoint: string | null }>(["apply", "--preset", p.id, ...(restorePoint ? ["--restore-point"] : [])]);
      const s = summarize(r.results, "angewendet");
      toast.style = s.failed ? Toast.Style.Failure : Toast.Style.Success;
      toast.title = s.title;
      toast.message = s.message;
    } catch (e) {
      toast.style = Toast.Style.Failure;
      toast.title = "Fehlgeschlagen";
      toast.message = (e as Error).message;
    }
  }

  async function revertAll() {
    const ok = await confirmAlert({ title: "Alles zurücksetzen?", message: "Alle von GameBoost geänderten Einstellungen werden wiederhergestellt.", primaryAction: { title: "Zurücksetzen", style: Alert.ActionStyle.Destructive } });
    if (!ok) return;
    const toast = await showToast({ style: Toast.Style.Animated, title: "Wird zurückgesetzt …" });
    try {
      const r = await gb<{ results: TweakResult[] }>(["revert", "--all"]);
      const s = summarize(r.results, "zurückgesetzt");
      toast.style = s.failed ? Toast.Style.Failure : Toast.Style.Success;
      toast.title = r.results.length ? s.title : "Nichts zurückzusetzen";
      toast.message = s.message;
    } catch (e) {
      toast.style = Toast.Style.Failure;
      toast.title = "Fehlgeschlagen";
      toast.message = (e as Error).message;
    }
  }

  return (
    <List isLoading={isLoading}>
      {(data || []).map((p) => (
        <List.Item
          key={p.id}
          icon={p.icon}
          title={p.title}
          subtitle={p.description}
          accessories={[{ text: `${p.tweaks.length} Optimierungen` }]}
          actions={
            <ActionPanel>
              <Action title="Mit Wiederherstellungspunkt anwenden" icon={Icon.Wand} onAction={() => apply(p, true)} />
              <Action title="Sofort anwenden" icon={Icon.Bolt} onAction={() => apply(p, false)} />
            </ActionPanel>
          }
        />
      ))}
      <List.Item
        icon="↩️"
        title="Alles zurücksetzen"
        subtitle="Alle Änderungen von GameBoost rückgängig machen"
        actions={
          <ActionPanel>
            <Action title="Alles zurücksetzen" icon={Icon.ArrowCounterClockwise} style={Action.Style.Destructive} onAction={revertAll} />
          </ActionPanel>
        }
      />
    </List>
  );
}
