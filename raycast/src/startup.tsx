import { Action, ActionPanel, Alert, Color, confirmAlert, Icon, List, showToast, Toast } from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { DeletedStartupItem, gb, StartupItem, StartupType } from "./lib";

const SECTIONS: [StartupType, string][] = [
  ["run", "Programme (Registry)"],
  ["folder", "Autostart-Ordner"],
  ["appx", "Store-Apps"],
  ["task", "Geplante Aufgaben"],
  ["service", "Dienste von Drittanbietern"],
  ["runonce", "Einmalig (RunOnce)"],
];

export default function Command() {
  const { data, isLoading, mutate, revalidate } = usePromise(() => gb<StartupItem[]>(["startup", "list"]));
  const deleted = usePromise(() => gb<DeletedStartupItem[]>(["startup", "deleted"]));

  async function toggle(s: StartupItem) {
    const enable = !s.enabled;
    try {
      await mutate(gb(["startup", enable ? "enable" : "disable", s.id]), {
        optimisticUpdate: (items) => (items || []).map((x) => (x.id === s.id ? { ...x, enabled: enable } : x)),
      });
      await showToast({ title: `${s.name} ${enable ? "aktiviert" : "deaktiviert"}` });
    } catch (e) {
      await showToast({ style: Toast.Style.Failure, title: "Fehler", message: (e as Error).message });
    }
  }

  async function remove(s: StartupItem) {
    const ok = await confirmAlert({ title: `„${s.name}“ löschen?`, message: "Der Eintrag wird gesichert und kann jederzeit wiederhergestellt werden.", primaryAction: { title: "Löschen", style: Alert.ActionStyle.Destructive } });
    if (!ok) return;
    try {
      await gb(["startup", "delete", s.id]);
      await showToast({ title: `Gelöscht: ${s.name}` });
      revalidate();
      deleted.revalidate();
    } catch (e) {
      await showToast({ style: Toast.Style.Failure, title: "Fehler", message: (e as Error).message });
    }
  }

  async function restore(d: DeletedStartupItem) {
    try {
      await gb(["startup", "restore", d.backupId]);
      await showToast({ title: `Wiederhergestellt: ${d.name}` });
      revalidate();
      deleted.revalidate();
    } catch (e) {
      await showToast({ style: Toast.Style.Failure, title: "Fehler", message: (e as Error).message });
    }
  }

  const items = data || [];
  return (
    <List isLoading={isLoading || deleted.isLoading} searchBarPlaceholder="Autostart-Programm suchen …">
      {SECTIONS.map(([type, title]) => {
        const list = items.filter((s) => s.type === type);
        if (!list.length) return null;
        return (
          <List.Section key={type} title={title} subtitle={`${list.filter((s) => s.enabled).length}/${list.length} aktiv`}>
            {list.map((s) => (
              <List.Item
                key={s.id}
                icon={s.enabled ? { source: Icon.CheckCircle, tintColor: Color.Green } : { source: Icon.Circle, tintColor: Color.SecondaryText }}
                title={s.name}
                subtitle={s.publisher || s.command}
                keywords={[s.command, s.publisher]}
                accessories={[
                  ...(s.broken ? [{ tag: { value: "Ziel fehlt", color: Color.Red }, tooltip: "Programmdatei existiert nicht mehr – kann gefahrlos gelöscht werden" }] : []),
                  { tag: s.scope },
                  ...(s.admin ? [{ icon: Icon.Lock, tooltip: "Benötigt Administratorrechte" }] : []),
                ]}
                actions={
                  <ActionPanel>
                    {s.canToggle && <Action title={s.enabled ? "Deaktivieren" : "Aktivieren"} icon={s.enabled ? Icon.XMarkCircle : Icon.CheckCircle} onAction={() => toggle(s)} />}
                    {s.canDelete && <Action title="Löschen (wiederherstellbar)" icon={Icon.Trash} style={Action.Style.Destructive} shortcut={{ modifiers: ["ctrl"], key: "x" }} onAction={() => remove(s)} />}
                    <Action.CopyToClipboard title="Befehl kopieren" content={s.command} />
                  </ActionPanel>
                }
              />
            ))}
          </List.Section>
        );
      })}
      {!!deleted.data?.length && (
        <List.Section title="Gelöschte Einträge" subtitle={String(deleted.data.length)}>
          {deleted.data.map((d) => (
            <List.Item
              key={d.backupId}
              icon={{ source: Icon.Trash, tintColor: Color.SecondaryText }}
              title={d.name}
              subtitle={`gelöscht ${new Date(d.deletedAt).toLocaleString()}`}
              accessories={[{ tag: d.scope }]}
              actions={
                <ActionPanel>
                  <Action title="Wiederherstellen" icon={Icon.ArrowCounterClockwise} onAction={() => restore(d)} />
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      )}
    </List>
  );
}
