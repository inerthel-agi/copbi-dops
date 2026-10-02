// Writes dist/copbi-dops-standalone.html: the packaged visual in a single page with a stub Power BI host.
// Outside Power BI there is no iframe sandbox, so the browser grants a real Pointer Lock.
// Usage: node tools/standalone.mjs (after pbiviz package). Settings: ?look=capture|drag|joystick
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const drop = JSON.parse(readFileSync(join(root, ".tmp/drop/pbiviz.json"), "utf8"));
const guid = drop.visual.guid;
const js = drop.content.js.replace(/<\/script/gi, "<\\/script");
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Call of Power BI: Data Ops</title>
<style>html,body{margin:0;height:100%;background:#171913;overflow:hidden}#game{position:absolute;inset:0}${drop.content.css}</style>
</head><body><div id="game"></div>
<script>
window.powerbi = { visuals: { plugins: {} } };
</script>
<script>${js}</script>
<script>
// Stub host: no data (built-in roster), best scores kept in localStorage.
const KEY = "copbi-dops.records";
const q = new URLSearchParams(location.search);
const objects = { gameplay: { lookMode: q.get("look") || "capture" }, display: { diagnostics: q.has("diag") } };
try { objects.records = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch (e) { objects.records = {}; }
try { objects.loadouts = JSON.parse(localStorage.getItem(KEY + ".loadouts") || "{}"); } catch (e) { objects.loadouts = {}; }
const host = {
  hostCapabilities: { allowInteractions: false },
  createSelectionManager: () => ({ select: () => Promise.resolve([]), clear: () => Promise.resolve(), hasSelection: () => false, registerOnSelectCallback() {} }),
  createSelectionIdBuilder: () => ({ withCategory() { return this; }, createSelectionId: () => ({}) }),
  persistProperties(c) {
    for (const i of c.merge || []) objects[i.objectName] = Object.assign({}, objects[i.objectName], i.properties);
    try {
      localStorage.setItem(KEY, JSON.stringify(objects.records));
      localStorage.setItem(KEY + ".loadouts", JSON.stringify(objects.loadouts || {}));
    } catch (e) { /* storage blocked */ }
    setTimeout(() => update(2), 0);
  },
};
const plugin = window.powerbi.visuals.plugins["${guid}"];
const visual = plugin.create({ element: document.getElementById("game"), host });
const update = type => visual.update({ viewport: { width: innerWidth, height: innerHeight }, dataViews: [{ metadata: { objects } }], type, viewMode: 1 });
update(62);
addEventListener("resize", () => update(4));
</script></body></html>
`;
mkdirSync(join(root, "dist"), { recursive: true });
const out = join(root, "dist", "copbi-dops-standalone.html");
writeFileSync(out, html);
console.log("Standalone page: " + out + " (" + Math.round(html.length / 1024) + " KB)");
