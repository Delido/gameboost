import { closeMainWindow, showHUD, showToast, Toast } from "@raycast/api";
import { openApp } from "./lib";

export default async function Command() {
  try {
    openApp();
    await closeMainWindow();
    await showHUD("GameBoost wird geöffnet …");
  } catch (e) {
    await showToast({ style: Toast.Style.Failure, title: "GameBoost konnte nicht gestartet werden", message: (e as Error).message });
  }
}
