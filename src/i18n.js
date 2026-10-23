// UI language: "auto" follows the Windows display language. Catalog texts (optimizations, actions,
// categories, presets) are localized here for the desktop UI; the UI itself translates its own
// texts (ui/i18n.js). CLI and Raycast stay German.
import en from "./i18n/en.js";
import { loadState } from "./state.js";

export function uiLang() {
  const l = loadState().config.ui?.lang;
  if (l === "de" || l === "en") return l;
  return (Intl.DateTimeFormat().resolvedOptions().locale || "").toLowerCase().startsWith("de") ? "de" : "en";
}

const withText = (item, t) => (t ? { ...item, title: t.title ?? item.title, description: t.description ?? item.description } : item);

/** Localizes the result of a command for the UI. Unknown shapes are returned unchanged. */
export function localize(command, data, lang = uiLang()) {
  if (lang !== "en" || !data) return data;
  const tweak = (t) => withText(t, en.tweaks[t.id]);
  const result = (r) => ({ ...r, title: en.tweaks[r.id]?.title ?? r.title });
  switch (command) {
    case "catalog":
      return {
        ...data,
        categories: data.categories.map((c) => withText(c, en.categories[c.id])),
        presets: data.presets.map((p) => withText(p, en.presets[p.id])),
        tweaks: data.tweaks.map(tweak),
        actions: data.actions.map((a) => withText(a, en.actions[a.id])),
        actionGroups: data.actionGroups?.map((g) => ({ ...g, title: en.actionGroups[g.id] ?? g.title })),
        riskLabels: { ...data.riskLabels, ...en.riskLabels },
        rebootLabels: { ...data.rebootLabels, ...en.rebootLabels },
      };
    case "list":
      return { ...data, categories: data.categories.map((c) => withText(c, en.categories[c.id])), tweaks: data.tweaks.map(tweak) };
    case "presets":
      return data.map((p) => withText(p, en.presets[p.id]));
    case "actions":
      return data.map((a) => withText(a, en.actions[a.id]));
    case "run":
      return { ...data, title: en.actions[data.id]?.title ?? data.title };
    case "apply":
    case "revert":
    case "profile":
      return data.results ? { ...data, results: data.results.map(result) } : data;
    default:
      return data;
  }
}
