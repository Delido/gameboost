import { closeMainWindow, showHUD, showToast, Toast } from "@raycast/api";
import { gb, Session, sessionText } from "./lib";

interface BoostResult { active: boolean; started?: boolean; session?: Session; errors?: string[]; wasActive?: boolean; minutes?: number }

export default async function Command() {
  await closeMainWindow();
  try {
    const r = await gb<BoostResult>(["boost", "toggle"]);
    if (r.active && r.session) await showHUD(`🚀 Game Boost aktiv – ${sessionText(r.session)}`);
    else await showHUD(r.wasActive ? `⏹ Game Boost beendet (${r.minutes} min) – System wiederhergestellt` : "Game Boost war nicht aktiv");
  } catch (e) {
    await showToast({ style: Toast.Style.Failure, title: "Game Boost fehlgeschlagen", message: (e as Error).message });
  }
}
