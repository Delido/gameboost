"use strict";
// Language switch for the UI. The German texts are the source; in English mode every text node
// (and placeholder/title attributes) is translated via window.GB_I18N_EN – also nodes that app.js
// inserts later (MutationObserver), so the rendering code stays language-agnostic.
(() => {
  const lang = window.GB_LANG === "en" ? "en" : "de";
  document.documentElement.lang = lang;
  const dict = window.GB_I18N_EN;
  window.gbT = (s) => s;
  if (lang !== "en" || !dict) return;

  const { exact, patterns } = dict;
  const tr = (s) => {
    const k = s.trim();
    if (!k) return s;
    let out = Object.hasOwn(exact, k) ? exact[k] : undefined;
    if (out === undefined) {
      for (const [re, rep] of patterns) {
        if (re.test(k)) { out = k.replace(re, rep); break; }
      }
    }
    return out === undefined ? s : s.replace(k, () => out);
  };
  window.gbT = tr;

  const ATTRS = ["placeholder", "title", "aria-label"];
  const SKIP = new Set(["SCRIPT", "STYLE", "CODE", "TEXTAREA"]);
  const fixAttrs = (el) => {
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (v) { const t = tr(v); if (t !== v) el.setAttribute(a, t); }
    }
  };
  const fixText = (node) => {
    if (node.parentElement && SKIP.has(node.parentElement.tagName)) return;
    const t = tr(node.nodeValue);
    if (t !== node.nodeValue) node.nodeValue = t;
  };
  const walk = (root) => {
    if (root.nodeType === Node.TEXT_NODE) return fixText(root);
    if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
    if (root.nodeType === Node.ELEMENT_NODE) {
      if (SKIP.has(root.tagName)) return;
      fixAttrs(root);
    }
    const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.nodeType === Node.ELEMENT_NODE && SKIP.has(n.tagName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (n.nodeType === Node.TEXT_NODE) fixText(n);
      else fixAttrs(n);
    }
  };

  document.title = tr(document.title);
  walk(document.body);
  new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === "childList") m.addedNodes.forEach(walk);
      else if (m.type === "characterData") fixText(m.target);
      else if (m.type === "attributes") fixAttrs(m.target);
    }
  }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
})();
