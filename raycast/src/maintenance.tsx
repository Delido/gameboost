import { Action, ActionPanel, Color, Icon, List, showToast, Toast } from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { Action as GbAction, gb } from "./lib";

export default function Command() {
  const { data, isLoading } = usePromise(() => gb<GbAction[]>(["actions"]));

  async function run(a: GbAction) {
    const toast = await showToast({ style: Toast.Style.Animated, title: `${a.title} …` });
    try {
      const r = await gb<{ message: string }>(["run", a.id], 20 * 60 * 1000);
      toast.style = Toast.Style.Success;
      toast.title = a.title;
      toast.message = r.message;
    } catch (e) {
      toast.style = Toast.Style.Failure;
      toast.title = `${a.title} fehlgeschlagen`;
      toast.message = (e as Error).message;
    }
  }

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Wartungsaktion suchen …">
      {(data || []).map((a) => (
        <List.Item
          key={a.id}
          icon={a.icon}
          title={a.title}
          subtitle={a.description}
          accessories={a.admin ? [{ tag: { value: "Admin", color: Color.SecondaryText } }] : []}
          actions={
            <ActionPanel>
              <Action title="Ausführen" icon={Icon.Play} onAction={() => run(a)} />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
