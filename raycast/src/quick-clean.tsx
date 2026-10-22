import { closeMainWindow, showHUD, showToast, Toast } from "@raycast/api";
import { gb } from "./lib";

export default async function Command() {
  await closeMainWindow();
  try {
    const r = await gb<{ message: string }>(["run", "quick-clean"]);
    await showHUD(`✨ ${r.message}`);
  } catch (e) {
    await showToast({ style: Toast.Style.Failure, title: "Wartung fehlgeschlagen", message: (e as Error).message });
  }
}
