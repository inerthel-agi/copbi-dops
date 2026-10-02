// Standalone page in headless Chrome as a top-level page (no iframe sandbox): a click must grant a real Pointer Lock.
// Needs dist/copbi-dops-standalone.html (npm run package). Usage: node test/standalone.mjs
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const page = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../dist/copbi-dops-standalone.html"));
const server = createServer((q, s) => (q.url.startsWith("/favicon") ? s.writeHead(204).end() : s.writeHead(200, { "content-type": "text/html" }).end(page)));
await new Promise(r => server.listen(0, "127.0.0.1", r));
const profile = mkdtempSync(join(tmpdir(), "sl-sa-"));
const chrome = spawn(process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe",
    ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "about:blank"], { stdio: "ignore" });
let code = 1;
try {
    let port;
    for (let i = 0; i < 100 && !port; i++) { await sleep(100); try { port = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]; } catch { /* not ready */ } }
    const tab = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === "page");
    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise(r => { ws.onopen = r; });
    let seq = 0; const pending = new Map(), errors = [];
    ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id) pending.get(d.id)(d.result); if (d.method === "Runtime.exceptionThrown") errors.push(d.params.exceptionDetails.exception?.description); };
    const send = (method, params = {}) => new Promise(r => { pending.set(++seq, r); ws.send(JSON.stringify({ id: seq, method, params })); });
    const ev = async x => (await send("Runtime.evaluate", { expression: x, returnByValue: true })).result.value;
    await send("Runtime.enable");
    await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
    await send("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/` });
    await sleep(2000);
    const mouse = (type, x, y, button = "left", buttons = 1) => send("Input.dispatchMouseEvent", { type, x, y, button, buttons, clickCount: 1 });
    const checks = [], info = [];
    const ok = (n, p, d = "") => checks.push([n, !!p, d]);
    ok("menu renders", await ev("!!document.querySelector('.sl-mode')"));
    // Start Aim Range with a real click on the first mode button.
    const b = await ev("(() => { const r = document.querySelector('.sl-mode').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()");
    await mouse("mouseMoved", b[0], b[1], "none", 0); await mouse("mousePressed", b[0], b[1]); await mouse("mouseReleased", b[0], b[1], "left", 0);
    await sleep(1500);
    await mouse("mouseMoved", 640, 360, "none", 0);
    await mouse("mousePressed", 640, 360, "right", 2); await mouse("mouseReleased", 640, 360, "right", 0);
    await sleep(500);
    const locked = await ev("document.pointerLockElement ? document.pointerLockElement.className : null");
    // Chrome refuses requestPointerLock under automation, even on a bare page (checked), so the grant itself is reported, not asserted.
    info.push(`pointer lock grant in this automated Chrome: ${locked === "sl-root" ? "GRANTED" : "refused by the browser (also refused on an empty page): confirm by hand in a normal Chrome window"}`);
    ok("cursor is hidden while captured", await ev("document.querySelector('.sl-root').classList.contains('sl-engaged')"));
    const y0 = Number(await ev("document.querySelector('.sl-root').dataset.yaw"));
    for (let i = 1; i <= 12; i++) { await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 640 + i * 30, y: 360, button: "none", buttons: 0 }); await sleep(30); }
    await sleep(600);
    const y1 = Number(await ev("document.querySelector('.sl-root').dataset.yaw"));
    ok("mouse movement turns the view under the lock", y1 < y0 - 0.1, `yaw ${y0} -> ${y1}`);
    // Losing the lock (Esc in a real browser) fires pointerlockchange with no lock element: the capture must end.
    await ev("document.dispatchEvent(new Event('pointerlockchange'))");
    await sleep(400);
    ok("losing the lock releases the capture (cursor back)", await ev("!document.querySelector('.sl-root').classList.contains('sl-engaged')"));
    ok("no JS errors", errors.length === 0, errors.join(" | "));
    for (const line of info) console.log("INFO  " + line);
    for (const [n, p, d] of checks) console.log(`${p ? "PASS" : "FAIL"}  ${n}${d ? "  (" + d + ")" : ""}`);
    code = checks.every(c => c[1]) ? 0 : 1;
} finally { chrome.kill(); server.close(); await sleep(300); try { rmSync(profile, { recursive: true, force: true }); } catch { /* busy */ } }
process.exit(code);
