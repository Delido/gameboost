import { Action, ActionPanel, Alert, Color, confirmAlert, Form, Icon, List, showHUD, showToast, Toast, useNavigation, closeMainWindow } from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { Game, gb, ScannedGame, Session } from "./lib";

interface LaunchResult { game: Game; boost: { active: boolean; session?: Session } | null }

export default function Command() {
  const { data, isLoading, revalidate } = usePromise(() => gb<Game[]>(["games", "list"]));
  const games = [...(data || [])].sort((a, b) => (b.lastPlayed || "").localeCompare(a.lastPlayed || "") || a.name.localeCompare(b.name));

  async function launch(g: Game, boost = true) {
    const toast = await showToast({ style: Toast.Style.Animated, title: `${g.name} wird gestartet …` });
    try {
      const r = await gb<LaunchResult>(["games", "launch", g.id, ...(boost ? [] : ["--no-boost"])]);
      toast.hide();
      await closeMainWindow();
      await showHUD(`▶ ${r.game.name}${r.boost?.active ? " – 🚀 Game Boost aktiv" : ""}`);
    } catch (e) {
      toast.style = Toast.Style.Failure;
      toast.title = "Start fehlgeschlagen";
      toast.message = (e as Error).message;
    }
  }

  async function remove(g: Game) {
    if (!(await confirmAlert({ title: `${g.name} entfernen?`, message: "Priorität und GPU-Einstellung werden zurückgesetzt.", primaryAction: { title: "Entfernen", style: Alert.ActionStyle.Destructive } }))) return;
    try {
      await gb(["games", "remove", g.id]);
      await showToast({ title: `${g.name} entfernt` });
      revalidate();
    } catch (e) {
      await showToast({ style: Toast.Style.Failure, title: "Fehler", message: (e as Error).message });
    }
  }

  const libraryActions = (
    <>
      <Action.Push title="Steam/Epic durchsuchen" icon={Icon.MagnifyingGlass} target={<ScanList onDone={revalidate} />} shortcut={{ modifiers: ["ctrl"], key: "s" }} />
      <Action.Push title="Spiel hinzufügen" icon={Icon.Plus} target={<AddGameForm onDone={revalidate} />} shortcut={{ modifiers: ["ctrl"], key: "n" }} />
    </>
  );

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Spiel suchen …">
      <List.EmptyView
        icon={Icon.GameController}
        title="Noch keine Spiele"
        description="Durchsuche Steam/Epic (Strg+S) oder füge eine .exe hinzu (Strg+N)."
        actions={<ActionPanel>{libraryActions}</ActionPanel>}
      />
      {games.map((g) => (
        <List.Item
          key={g.id}
          icon={{ source: Icon.GameController, tintColor: g.source === "steam" ? Color.Blue : g.source === "epic" ? Color.Purple : Color.Orange }}
          title={g.name}
          subtitle={g.processName || undefined}
          accessories={[
            ...(g.highPriority ? [{ icon: Icon.ArrowUp, tooltip: "Hohe CPU-Priorität" }] : []),
            ...(g.boost ? [{ icon: Icon.Rocket, tooltip: "Auto-Boost" }] : []),
            ...(g.lastPlayed ? [{ date: new Date(g.lastPlayed), tooltip: "Zuletzt gespielt" }] : []),
          ]}
          actions={
            <ActionPanel>
              <Action title="Mit Game Boost spielen" icon={Icon.Rocket} onAction={() => launch(g, true)} />
              <Action title="Ohne Boost starten" icon={Icon.Play} onAction={() => launch(g, false)} />
              <Action title="Entfernen" icon={Icon.Trash} style={Action.Style.Destructive} shortcut={{ modifiers: ["ctrl"], key: "x" }} onAction={() => remove(g)} />
              <ActionPanel.Section>{libraryActions}</ActionPanel.Section>
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}

function ScanList({ onDone }: { onDone: () => void }) {
  const { data, isLoading, revalidate } = usePromise(() => gb<ScannedGame[]>(["games", "scan"]));

  async function importGames(args: string[], label: string) {
    const toast = await showToast({ style: Toast.Style.Animated, title: label });
    try {
      const added = await gb<Game[]>(["games", "import", ...args]);
      toast.style = Toast.Style.Success;
      toast.title = `${added.length} Spiel(e) übernommen`;
      revalidate();
      onDone();
    } catch (e) {
      toast.style = Toast.Style.Failure;
      toast.title = "Import fehlgeschlagen";
      toast.message = (e as Error).message;
    }
  }

  return (
    <List isLoading={isLoading} navigationTitle="Installierte Spiele" searchBarPlaceholder="Gefundene Spiele filtern …">
      <List.EmptyView icon={Icon.CheckCircle} title="Keine neuen Spiele gefunden" />
      {(data || []).map((g) => (
        <List.Item
          key={g.target}
          icon={{ source: Icon.GameController, tintColor: g.source === "steam" ? Color.Blue : Color.Purple }}
          title={g.name}
          subtitle={g.processName || "Prozess unbekannt"}
          accessories={[{ tag: g.source === "steam" ? "Steam" : "Epic" }]}
          actions={
            <ActionPanel>
              <Action title="Übernehmen" icon={Icon.Plus} onAction={() => importGames([g.name], `${g.name} wird übernommen …`)} />
              <Action title="Alle übernehmen" icon={Icon.Download} onAction={() => importGames(["--all"], "Alle Spiele werden übernommen …")} />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}

interface FormValues { exe: string[]; url: string; name: string; process: string; args: string; priority: boolean; gpu: boolean; boost: boolean }

function AddGameForm({ onDone }: { onDone: () => void }) {
  const { pop } = useNavigation();

  async function submit(v: FormValues) {
    const target = v.url.trim() || v.exe?.[0];
    if (!target) {
      await showToast({ style: Toast.Style.Failure, title: "Bitte .exe auswählen oder URL angeben" });
      return;
    }
    const args = ["games", "add", target];
    if (v.name.trim()) args.push("--name", v.name.trim());
    if (v.process.trim()) args.push("--process", v.process.trim());
    if (v.args.trim()) args.push("--args", v.args.trim());
    if (!v.priority) args.push("--no-priority");
    if (!v.gpu) args.push("--no-gpu");
    if (!v.boost) args.push("--no-boost");
    const toast = await showToast({ style: Toast.Style.Animated, title: "Spiel wird hinzugefügt …" });
    try {
      const g = await gb<Game>(args);
      toast.style = Toast.Style.Success;
      toast.title = `${g.name} hinzugefügt`;
      onDone();
      pop();
    } catch (e) {
      toast.style = Toast.Style.Failure;
      toast.title = "Fehler";
      toast.message = (e as Error).message;
    }
  }

  return (
    <Form
      navigationTitle="Spiel hinzufügen"
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Hinzufügen" icon={Icon.Plus} onSubmit={submit} />
        </ActionPanel>
      }
    >
      <Form.FilePicker id="exe" title="Spiel (.exe)" allowMultipleSelection={false} canChooseDirectories={false} />
      <Form.TextField id="url" title="…oder Launcher-URL" placeholder="steam://rungameid/730" />
      <Form.Separator />
      <Form.TextField id="name" title="Name" placeholder="optional" />
      <Form.TextField id="process" title="Prozessname" placeholder="optional, z. B. cs2.exe" info="Der Prozess, der während des Spielens läuft. Wird für die CPU-Priorität und das automatische Beenden des Boosts genutzt." />
      <Form.TextField id="args" title="Startparameter" placeholder="optional" />
      <Form.Checkbox id="priority" label="Hohe CPU-Priorität" defaultValue={true} />
      <Form.Checkbox id="gpu" label="Hochleistungs-GPU erzwingen" defaultValue={true} />
      <Form.Checkbox id="boost" label="Beim Start automatisch Game Boost" defaultValue={true} />
    </Form>
  );
}
