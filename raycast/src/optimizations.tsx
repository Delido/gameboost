import { Action, ActionPanel, Alert, Color, confirmAlert, Icon, List, showToast, Toast } from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { useState } from "react";
import { Category, CATEGORY_ICON, gb, Preset, REBOOT_LABEL, RISK_COLOR, RISK_LABEL, Risk, STATUS_LABEL, statusIcon, summarize, Tweak, TweakResult } from "./lib";

interface ListData { categories: Category[]; tweaks: Tweak[]; score: number }

export default function Command() {
  const [risk, setRisk] = useState<string>("all");
  const { data, isLoading, revalidate, mutate } = usePromise(() => gb<ListData>(["list"]));
  const presets = usePromise(() => gb<Preset[]>(["presets"]));

  async function run(args: string[], verb: string, label: string) {
    const toast = await showToast({ style: Toast.Style.Animated, title: label });
    try {
      const r = await mutate(gb<{ results: TweakResult[] }>(args), { shouldRevalidateAfter: true });
      if (r.results.length === 0) {
        toast.style = Toast.Style.Success;
        toast.title = "Nichts zu tun";
        return;
      }
      const s = summarize(r.results, verb);
      toast.style = s.failed ? Toast.Style.Failure : Toast.Style.Success;
      toast.title = s.title;
      toast.message = s.message;
    } catch (e) {
      toast.style = Toast.Style.Failure;
      toast.title = "Fehlgeschlagen";
      toast.message = (e as Error).message;
    }
  }

  async function applyTweak(t: Tweak) {
    if (t.risk === "advanced") {
      const ok = await confirmAlert({ title: t.title, message: t.description, primaryAction: { title: "Trotzdem aktivieren", style: Alert.ActionStyle.Destructive } });
      if (!ok) return;
    }
    await run(["apply", t.id], "angewendet", `${t.title} wird angewendet …`);
  }

  async function applyPreset(p: Preset) {
    if (p.id === "max") {
      const ok = await confirmAlert({ title: p.title, message: p.description, primaryAction: { title: "Alles anwenden", style: Alert.ActionStyle.Destructive } });
      if (!ok) return;
    }
    await run(["apply", "--preset", p.id, "--restore-point"], "angewendet", `Profil „${p.title}“ wird angewendet …`);
  }

  async function revertAll() {
    const ok = await confirmAlert({ title: "Alles zurücksetzen?", message: "Alle von GameBoost geänderten Einstellungen werden wiederhergestellt.", primaryAction: { title: "Zurücksetzen", style: Alert.ActionStyle.Destructive } });
    if (ok) await run(["revert", "--all"], "zurückgesetzt", "Alles wird zurückgesetzt …");
  }

  const tweaks = (data?.tweaks || []).filter((t) => risk === "all" || t.risk === risk);

  const globalActions = (
    <>
      <ActionPanel.Submenu title="Profil anwenden" icon={Icon.Wand} shortcut={{ modifiers: ["ctrl"], key: "p" }}>
        {(presets.data || []).map((p) => (
          <Action key={p.id} title={`${p.title} (${p.tweaks.length})`} onAction={() => applyPreset(p)} />
        ))}
      </ActionPanel.Submenu>
      <Action title="Alles zurücksetzen" icon={Icon.ArrowCounterClockwise} style={Action.Style.Destructive} onAction={revertAll} />
      <Action title="Neu laden" icon={Icon.Repeat} shortcut={{ modifiers: ["ctrl"], key: "r" }} onAction={revalidate} />
    </>
  );

  return (
    <List
      isLoading={isLoading}
      navigationTitle={data ? `Optimierungen · Score ${data.score}/100` : "Optimierungen"}
      searchBarPlaceholder="Optimierung suchen …"
      searchBarAccessory={
        <List.Dropdown tooltip="Risikostufe" value={risk} onChange={setRisk}>
          <List.Dropdown.Item title="Alle Stufen" value="all" />
          <List.Dropdown.Item title="Sicher" value="safe" />
          <List.Dropdown.Item title="Moderat" value="moderate" />
          <List.Dropdown.Item title="Fortgeschritten" value="advanced" />
        </List.Dropdown>
      }
    >
      {(data?.categories || []).map((c) => {
        const items = tweaks.filter((t) => t.category === c.id);
        if (!items.length) return null;
        const on = items.filter((t) => t.status === "applied").length;
        return (
          <List.Section key={c.id} title={c.title} subtitle={`${on}/${items.length} aktiv`}>
            {items.map((t) => {
              const active = t.status === "applied" || t.status === "partial";
              return (
                <List.Item
                  key={t.id}
                  icon={statusIcon(t.status)}
                  title={t.title}
                  keywords={[t.id, c.title, ...t.description.split(" ")]}
                  accessories={[
                    ...(t.reboot !== "none" ? [{ tag: REBOOT_LABEL[t.reboot], tooltip: "Wirksam nach" }] : []),
                    { tag: { value: RISK_LABEL[t.risk as Risk], color: RISK_COLOR[t.risk as Risk] } },
                    { icon: CATEGORY_ICON[t.category], tooltip: STATUS_LABEL[t.status] },
                  ]}
                  subtitle={t.status === "partial" ? "teilweise aktiv" : undefined}
                  actions={
                    <ActionPanel>
                      <ActionPanel.Section title={t.title}>
                        {t.status !== "applied" && t.status !== "unavailable" && (
                          <Action title="Anwenden" icon={{ source: Icon.CheckCircle, tintColor: Color.Green }} onAction={() => applyTweak(t)} />
                        )}
                        {(active || t.hasBackup) && (
                          <Action title="Zurücksetzen" icon={Icon.ArrowCounterClockwise} onAction={() => run(["revert", t.id], "zurückgesetzt", `${t.title} wird zurückgesetzt …`)} />
                        )}
                        <Action
                          title={`Kategorie „${c.title}“ anwenden`}
                          icon={CATEGORY_ICON[c.id]}
                          shortcut={{ modifiers: ["ctrl"], key: "k" }}
                          onAction={() => {
                            const ids = items.filter((x) => x.risk !== "advanced" && x.status !== "applied" && x.status !== "unavailable").map((x) => x.id);
                            return ids.length ? run(["apply", ...ids], "angewendet", `${c.title} wird optimiert …`) : showToast({ title: "Bereits alles aktiv" });
                          }}
                        />
                        <Action.CopyToClipboard title="Beschreibung kopieren" content={`${t.title}\n${t.description}`} />
                      </ActionPanel.Section>
                      <ActionPanel.Section title="Alle">{globalActions}</ActionPanel.Section>
                    </ActionPanel>
                  }
                />
              );
            })}
          </List.Section>
        );
      })}
    </List>
  );
}
