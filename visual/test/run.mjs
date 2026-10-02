// Loads the packaged visual (.tmp/drop/pbiviz.json, same content as the .pbiviz) inside a
// sandbox="allow-scripts" iframe in headless Chrome, plays every mode with real CDP input events,
// and reports errors, network, FPS, host calls (selection / persistence) and screenshots.
// No dependencies: node:http + Chrome DevTools Protocol over Node's built-in WebSocket.
//   node test/run.mjs           run the headless scenario
//   node test/run.mjs --serve   only serve the stub (open the printed URL in any browser)
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const out = join(here, "out");
const KEYS = {
    KeyW: ["w", 87], KeyA: ["a", 65], KeyS: ["s", 83], KeyD: ["d", 68], KeyF: ["f", 70], KeyR: ["r", 82], KeyE: ["e", 69],
    KeyM: ["m", 77], KeyN: ["n", 78], KeyV: ["v", 86], KeyC: ["c", 67], Tab: ["Tab", 9], KeyX: ["x", 88], ShiftLeft: ["Shift", 16], Escape: ["Escape", 27], KeyP: ["p", 80], Enter: ["Enter", 13], Space: [" ", 32],
    Digit1: ["1", 49], Digit2: ["2", 50], Digit3: ["3", 51], Digit4: ["4", 52], Digit5: ["5", 53], Digit7: ["7", 55],
};
const drop = JSON.parse(readFileSync(join(root, ".tmp/drop/pbiviz.json"), "utf8"));
const files = {
    "/stub.html": [readFileSync(join(here, "stub.html")), "text/html"],
    "/frame.html": [readFileSync(join(here, "frame.html")), "text/html"],
    "/visual.js": [drop.content.js, "text/javascript"],
    "/visual.css": [drop.content.css, "text/css"],
};
const served = [];
const server = createServer((req, res) => {
    const path = req.url.split("?")[0];
    served.push(path);
    const f = files[path];
    if (!f) return void res.writeHead(path === "/favicon.ico" ? 204 : 404).end();
    res.writeHead(200, { "content-type": f[1], "cache-control": "no-store" }).end(f[0]);
});
await new Promise(r => server.listen(Number(process.env.PORT) || 0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
if (process.argv.includes("--serve")) {
    console.log(`Serving ${base}/stub.html (Ctrl+C to stop)`);
} else {
    process.exit(await check());
}

async function check() {
    const chromePath = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
    const profile = mkdtempSync(join(tmpdir(), "sl-chrome-"));
    const chrome = spawn(chromePath, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
        "--no-first-run", "--no-default-browser-check", "--window-size=1280,720", "about:blank"], { stdio: "ignore" });
    try {
        return await scenario(await connect(profile));
    } finally {
        chrome.kill();
        server.close();
        await sleep(300);
        try { rmSync(profile, { recursive: true, force: true }); } catch { /* Chrome may still hold files */ }
    }
}

async function connect(profile) {
    let port;
    for (let i = 0; i < 100 && !port; i++) {
        await sleep(100);
        try { port = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]; } catch { /* not ready */ }
    }
    const page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === "page");
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise(r => { ws.onopen = r; });
    let seq = 0;
    const pending = new Map(), logs = [], requests = [];
    const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
        pending.set(++seq, { res, rej });
        ws.send(JSON.stringify({ id: seq, method, params, sessionId }));
    });
    // Out-of-process iframes show up as child targets: instrument them before they run.
    const instrument = async sessionId => {
        await Promise.all(["Runtime.enable", "Network.enable", "Log.enable"].map(m => send(m, {}, sessionId)));
        await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId);
        if (sessionId) await send("Runtime.runIfWaitingForDebugger", {}, sessionId);
    };
    ws.onmessage = m => {
        const d = JSON.parse(m.data);
        if (d.id) {
            const p = pending.get(d.id);
            pending.delete(d.id);
            return d.error ? p.rej(new Error(d.error.message)) : p.res(d.result);
        }
        const p = d.params;
        if (d.method === "Target.attachedToTarget") void instrument(p.sessionId);
        if (d.method === "Network.requestWillBeSent") requests.push(p.request.url);
        if (d.method === "Runtime.consoleAPICalled") logs.push(`${p.type}: ${p.args.map(a => a.value ?? a.description).join(" ")}`);
        if (d.method === "Runtime.exceptionThrown") logs.push(`exception: ${p.exceptionDetails.exception?.description ?? p.exceptionDetails.text}`);
        if (d.method === "Log.entryAdded") logs.push(`${p.entry.level}: ${p.entry.text}`);
    };
    await instrument();
    await send("Page.enable");
    await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
    await send("Emulation.setFocusEmulationEnabled", { enabled: true });
    return { ws, send, logs, requests };
}


async function scenario({ ws, send, logs, requests }) {
    mkdirSync(out, { recursive: true });
    const top = async expr => (await send("Runtime.evaluate", { expression: expr, returnByValue: true })).result.value;
    const snap = async () => (await top("window.results.last"))?.snap ?? {};
    const last = () => top("window.results.last");
    const msg = m => top(`window.send(${JSON.stringify(m)})`);
    const key = async (code, holdMs = 60) => {
        const [k, vk] = KEYS[code];
        await send("Input.dispatchKeyEvent", { type: "keyDown", code, key: k, windowsVirtualKeyCode: vk });
        await sleep(holdMs);
        await send("Input.dispatchKeyEvent", { type: "keyUp", code, key: k, windowsVirtualKeyCode: vk });
        await sleep(150);
    };
    const keyDown = (code) => send("Input.dispatchKeyEvent", { type: "keyDown", code, key: KEYS[code][0], windowsVirtualKeyCode: KEYS[code][1] });
    const keyUp = (code) => send("Input.dispatchKeyEvent", { type: "keyUp", code, key: KEYS[code][0], windowsVirtualKeyCode: KEYS[code][1] });
    const mouse = (type, x, y, button = "left", buttons = 1) => send("Input.dispatchMouseEvent", { type, x, y, button, buttons, clickCount: 1 });
    const click = async (x, y) => { await mouse("mousePressed", x, y); await mouse("mouseReleased", x, y, "left", 0); await sleep(200); };
    const shot = async name => {
        const s = await send("Page.captureScreenshot", { format: "png", clip: { x: 20, y: 20, width: 960, height: 540, scale: 1 } });
        writeFileSync(join(out, `${name}.png`), Buffer.from(s.data, "base64"));
    };
    const waitFor = async (pred, ms = 5000) => {
        for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
            const s = await snap();
            if (pred(s)) return s;
        }
        return snap();
    };
    const fpsOver = async ms => {
        const v = [];
        for (const end = Date.now() + ms; Date.now() < end; await sleep(500)) v.push((await snap()).fps);
        v.sort((a, b) => a - b);
        return v[v.length >> 1] ?? 0;
    };
    const checks = [], info = [];
    const ok = (name, pass, detail = "") => checks.push([name, !!pass, detail]);
    const CX = 500, CY = 290; // center of the 960x540 iframe placed at (20, 20)

    await send("Page.navigate", { url: `${base}/stub.html` });
    let s = await waitFor(x => x.state === "menu", 8000);
    await sleep(800);
    ok("menu loads with the Weapons data (8 rows)", s.state === "menu" && s.fromData && s.slots?.length === 8, `slots=${s.slots?.length}`);
    await shot("01-menu");

    // Focus the iframe with a real click, then pick Aim Range with the keyboard.
    await click(CX, 560 - 30);
    // N cycles the maps; every layout keeps spawns and enough range targets.
    for (const id of ["quarry", "blocks", "cargo", "derrick", "yard"]) {
        await key("KeyN");
        s = await waitFor(x => x.map === id, 4000);
        await sleep(300);
        if (id !== "yard") await shot(`01-map-${id}`);
        const savedMap = JSON.parse((await last()).log.persist.filter(p => p.merge?.[0]?.objectName === "loadouts").at(-1)?.merge[0].properties.data ?? "{}").map;
        ok(`N switches to map ${id} and saves it (spawns and range targets kept)`, s.map === id && savedMap === id && s.spawns[0] >= 3 && s.spawns[1] >= 5 && s.rangeTargets >= 10,
            `map=${s.map} saved=${savedMap} spawns=${s.spawns} targets=${s.rangeTargets}`);
    }
    // Classes: C picks class 1 (primary + secondary + perk), V edits it, the change is persisted, C cycles back to all weapons.
    await key("KeyC");
    s = await waitFor(x => x.loadouts?.active === 0, 3000);
    ok("C selects class 1: two weapons and a perk", s.slots.join() === "R-7 Carbine,Ward-9" && s.perk === "steady", `slots=${s.slots} perk=${s.perk}`);
    await key("KeyV");
    s = await waitFor(x => x.editing === 0, 3000);
    await msg({ type: "click", sel: ".sl-ce-next", i: 2 });
    await msg({ type: "click", sel: ".sl-ce-next", i: 0 });
    await msg({ type: "type", sel: ".sl-ce-name", value: "night ops!<b>" });
    s = await waitFor(x => x.perk === "quickhands" && x.loadouts.classes[0].name === "NIGHT OPSB", 3000);
    ok("class rename keeps only safe characters", s.loadouts.classes[0].name === "NIGHT OPSB", s.loadouts.classes[0].name);
    await shot("01-class-editor");
    const Lc = (await last()).log;
    const savedLo = JSON.parse(Lc.persist.filter(p => p.merge?.[0]?.objectName === "loadouts").at(-1)?.merge[0].properties.data ?? "{}");
    ok("class editor changes perk and primary, and persists them", s.editing === 0 && s.perk === "quickhands" && s.slots[0] !== "R-7 Carbine" &&
        savedLo.classes?.[0]?.perk === "quickhands" && savedLo.classes[0].primary === s.slots[0], `slots=${s.slots} perk=${s.perk} saved=${JSON.stringify(savedLo.classes?.[0])}`);
    await key("Enter");
    for (let i = 0; i < 5; i++) await key("KeyC");
    s = await waitFor(x => x.loadouts?.active === -1 && x.editing === -1, 3000);
    ok("cycling C returns to all weapons", s.slots.length === 8, `active=${s.loadouts?.active} slots=${s.slots.length}`);
    // D cycles the bot difficulty and writes it to the format pane setting; four presses come back to normal.
    await key("KeyD");
    await sleep(200);
    const diffSaved = (await last()).log.persist.filter(p => p.merge?.[0]?.objectName === "gameplay").at(-1)?.merge[0].properties.difficulty;
    for (let i = 0; i < 3; i++) await key("KeyD");
    await sleep(200);
    const diffBack = (await last()).log.persist.filter(p => p.merge?.[0]?.objectName === "gameplay").at(-1)?.merge[0].properties.difficulty;
    ok("D cycles bot difficulty and saves it (normal -> hard ... -> normal)", diffSaved === "hard" && diffBack === "normal", `${diffSaved} ... ${diffBack}`);
    await key("Digit1");
    s = await waitFor(x => x.state === "play" && x.mode === "range");
    let L = (await last()).log;
    ok("key 1 starts Aim Range", s.state === "play" && s.mode === "range");
    ok("equip calls selectionManager.select(Weapon)", L.select.at(-1) === "Weapon=R-7 Carbine", L.select.at(-1));
    ok("audio context running after the gesture", s.audio === "running", s.audio);
    await msg({ type: "audioCheck" });
    await sleep(300);
    const au = await top("window.acks.at(-1)");
    ok("synthesized sounds are valid (finite, audible, not clipped)", au?.n >= 30 && au.bad.length === 0, `buffers=${au?.n} bad=${au?.bad?.join(" | ")}`);

    // Fire with F (hold) and check ammo and shots.
    const mag0 = s.mag;
    await key("KeyF", 900);
    s = await snap();
    ok("holding F fires full-auto", s.stats.shots >= 6 && s.mag < mag0, `shots=${s.stats.shots} mag ${mag0}->${s.mag}`);

    // Click (no drag) = single shot fallback.
    const shots0 = s.stats.shots;
    await sleep(400);
    await click(CX, CY);
    s = await snap();
    ok("click/tap fires one shot", s.stats.shots === shots0 + 1, `${shots0}->${s.stats.shots}`);

    // Drag-look with pointer capture, continuing outside the iframe.
    const yaw0 = s.yaw;
    await mouse("mousePressed", CX, CY);
    await mouse("mouseMoved", CX + 300, CY);
    await sleep(120);
    const yawInside = (await snap()).yaw;
    await mouse("mouseMoved", 1200, CY); // x=1200 is outside the iframe (it ends at x=980)
    await sleep(120);
    const yawOutside = (await snap()).yaw;
    await sleep(400);
    await mouse("mouseReleased", 1200, CY, "left", 0); // released outside: an out-of-process iframe never sees it
    await sleep(100);
    await mouse("mouseMoved", CX - 100, CY, "none", 0); // hover back in without any button
    await sleep(150);
    await mouse("mouseMoved", CX - 200, CY, "none", 0);
    await sleep(150);
    const yawHover = (await snap()).yaw;
    ok("drag turns the view", yawInside < yaw0 - 0.2, `yaw ${yaw0} -> ${yawInside}`);
    info.push(`pointer capture outside the iframe: ${yawOutside < yawInside - 0.2 ? "delivered" : "NOT delivered (out-of-process sandboxed iframe)"} (yaw ${yawInside} -> ${yawOutside})`);
    ok("release outside leaves no ghost drag on hover", Math.abs(yawHover - yawOutside) < 0.01, `yaw ${yawOutside} -> ${yawHover}`);

    // Move with W.
    const p0 = (await snap()).pos;
    await key("KeyW", 1000);
    const p1 = (await snap()).pos;
    ok("W moves the player", Math.hypot(p1[0] - p0[0], p1[2] - p0[2]) > 2, `moved ${Math.hypot(p1[0] - p0[0], p1[2] - p0[2]).toFixed(2)} m`);

    // Reload.
    await key("KeyR");
    s = await snap();
    const reloading = s.reloading;
    s = await waitFor(x => !x.reloading && x.mag === 30, 4000);
    ok("R reloads to a full magazine", reloading && s.mag === 30, `mag=${s.mag}`);

    // Aimbot-assisted hits on raised targets (ADS held): exercises hit detection, zones, hit markers, kill feed.
    await keyDown("KeyE");
    let aimed = 0;
    for (let i = 0; i < 12; i++) {
        await msg({ type: "aim", head: i % 2 === 1 });
        await sleep(250);
        if ((await top("window.acks.at(-1)"))) aimed++;
        await key("KeyF", 30);
        await sleep(250);
    }
    s = await snap();
    await shot("02-range");
    await keyUp("KeyE");
    ok("hitscan drops aimed targets", s.stats.kills >= 4, `aimed=${aimed} kills=${s.stats.kills} heads=${s.stats.heads} hits=${s.stats.hits}`);
    ok("headshots are counted", s.stats.heads >= 1, `heads=${s.stats.heads}`);
    ok("reaction time is measured per target", s.stats.ttkN >= 4 && s.stats.ttkSum > 0 && s.stats.ttkBest > 0, `n=${s.stats.ttkN} sum=${s.stats.ttkSum} best=${s.stats.ttkBest}`);

    // Weapon switch 5 = Longshot, scope with E.
    await key("Digit5");
    s = await waitFor(x => x.weapon === "Longshot");
    L = (await last()).log;
    ok("key 5 equips Longshot and selects it", s.weapon === "Longshot" && L.select.at(-1) === "Weapon=Longshot", L.select.at(-1));
    await sleep(500);
    await keyDown("KeyE");
    s = await waitFor(x => x.ads > 0.95, 2000);
    await sleep(200);
    await shot("03-scope");
    await keyUp("KeyE");
    ok("E aims down sights", s.ads > 0.95, `ads=${s.ads}`);

    // Right mouse button also aims.
    await mouse("mousePressed", CX, CY, "right", 2);
    s = await waitFor(x => x.ads > 0.9, 1500);
    await mouse("mouseReleased", CX, CY, "right", 0);
    ok("right button aims", s.ads > 0.9, `ads=${s.ads}`);

    // Aiming and firing must win over a held sprint (both used to be blocked while Shift was down).
    await sleep(400);
    await keyDown("ShiftLeft");
    await keyDown("KeyW");
    await sleep(500);
    await keyDown("KeyE");
    const tAds = Date.now();
    const adsSprint = (await waitFor(x => x.ads >= 0.99, 600)).ads, adsMs = Date.now() - tAds;
    await keyUp("KeyE");
    await sleep(300);
    const shS = (await snap()).stats.shots;
    await key("KeyF", 250);
    const shS2 = (await snap()).stats.shots;
    await keyUp("KeyW");
    await keyUp("ShiftLeft");
    ok("aim works while holding sprint (sniper, full aim in under 0.6 s)", adsSprint >= 0.99, `ads=${adsSprint} after ${adsMs} ms`);
    ok("fire works while holding sprint", shS2 > shS, `shots ${shS} -> ${shS2}`);

    // Mouse-only play: hold right (aim), then press left (fire). Browsers send no pointerdown for the second button.
    await sleep(600);
    const sh0 = (await snap()).stats.shots;
    await mouse("mousePressed", CX, CY, "right", 2);
    await sleep(500);
    await mouse("mousePressed", CX, CY, "left", 3);
    await sleep(300);
    await mouse("mouseReleased", CX, CY, "left", 2);
    await shot("03b-ads-fire");
    await mouse("mouseReleased", CX, CY, "right", 0);
    s = await snap();
    ok("left button fires while right button aims", s.stats.shots > sh0, `shots ${sh0} -> ${s.stats.shots}, ads=${s.ads}`);

    // Capture mode (default in Power BI): right click captures the mouse, cursor hidden, movement turns the view with no button.
    await msg({ type: "objects", o: { gameplay: { lookMode: "capture" } } });
    await sleep(500);
    await mouse("mouseMoved", CX, CY, "none", 0);
    await mouse("mousePressed", CX, CY, "right", 2);
    await mouse("mouseReleased", CX, CY, "right", 0);
    await sleep(400);
    s = await snap();
    const hidden = (await last()).engagedCls;
    ok("right click captures the mouse and hides the cursor", s.engaged === true && hidden === true, `engaged=${s.engaged} cssClass=${hidden}`);
    const cy0 = s.yaw;
    for (let i = 1; i <= 8; i++) { await mouse("mouseMoved", CX + i * 8, CY, "none", 0); await sleep(25); }
    await sleep(200);
    ok("moving the mouse turns the view with no button held", (await snap()).yaw < cy0 - 0.08, `yaw ${cy0} -> ${(await snap()).yaw}`);
    await mouse("mouseMoved", CX, CY, "none", 0);
    await sleep(1600);
    let c0 = (await snap()).stats.shots;
    await mouse("mousePressed", CX, CY, "left", 1);
    await mouse("mouseReleased", CX, CY, "left", 0);
    await sleep(300);
    s = await snap();
    ok("left click fires without ADS", s.stats.shots === c0 + 1 && s.ads < 0.2, `shots ${c0} -> ${s.stats.shots}, ads=${s.ads}`);
    await sleep(1600);
    c0 = s.stats.shots;
    await mouse("mousePressed", CX, CY, "right", 2);
    await sleep(500);
    await mouse("mousePressed", CX, CY, "left", 3);
    await mouse("mouseReleased", CX, CY, "left", 2);
    await sleep(300);
    s = await snap();
    await mouse("mouseReleased", CX, CY, "right", 0);
    ok("right (ADS) + left fires", s.stats.shots === c0 + 1 && s.ads > 0.5, `shots ${c0} -> ${s.stats.shots}, ads=${s.ads}`);
    // Quick turn: X rotates the view by 180 degrees.
    const q0 = (await snap()).yaw;
    await key("KeyX");
    await sleep(500);
    const dq = Math.abs(Math.atan2(Math.sin((await snap()).yaw - q0), Math.cos((await snap()).yaw - q0)));
    ok("X turns the view by 180 degrees", Math.abs(dq - Math.PI) < 0.1, `delta ${dq.toFixed(2)} rad`);
    await msg({ type: "objects", o: { gameplay: { lookMode: "drag" } } });
    await sleep(300);

    // Scoreboard on Tab.
    await keyDown("Tab");
    await sleep(300);
    const board = (await last()).board;
    await shot("04-scoreboard");
    await keyUp("Tab");
    ok("Tab shows the scoreboard", board === true);

    // Omnidirectional sprint, slide, slide cancel.
    await keyDown("ShiftLeft");
    await keyDown("KeyD");
    await sleep(700);
    const strafeSprint = (await snap()).speed;
    await keyUp("KeyD");
    await keyDown("KeyW");
    await sleep(600);
    await key("KeyC", 40);
    s = await snap();
    const slideStart = s;
    await sleep(250);
    const slideMid = await snap();
    await key("KeyC", 40);
    await sleep(100);
    const afterCancel = await snap();
    await keyUp("KeyW");
    await keyUp("ShiftLeft");
    await sleep(400);
    ok("sprint works sideways (omnidirectional)", strafeSprint > 6, `speed ${strafeSprint}`);
    ok("C while sprinting slides faster than a sprint", (slideStart.sliding || slideMid.sliding) && Math.max(slideStart.speed, slideMid.speed) > 7.5, `sliding=${slideStart.sliding}/${slideMid.sliding} speed=${slideStart.speed}/${slideMid.speed}`);
    ok("C during the slide cancels it and keeps momentum", !afterCancel.sliding && afterCancel.speed > 6 && afterCancel.crouch < 0.6, `sliding=${afterCancel.sliding} speed=${afterCancel.speed} crouch=${afterCancel.crouch}`);

    // Class slicer simulation: filtered data changes the loadout without restarting the round.
    const t0 = (await snap()).time;
    await msg({ type: "filter", cls: "Sniper" });
    s = await waitFor(x => x.slots.length === 1);
    ok("slicer Sniper -> loadout [Longshot], round continues", s.slots.join() === "Longshot" && s.state === "play" && s.time >= t0, s.slots.join());
    await msg({ type: "filter", cls: "Pistol" });
    s = await waitFor(x => x.slots.join() === "Ward-9");
    L = (await last()).log;
    ok("slicer Pistol -> current weapon replaced and selected", s.weapon === "Ward-9" && L.select.at(-1) === "Weapon=Ward-9", `${s.weapon} ${L.select.at(-1)}`);
    await msg({ type: "filter", cls: null });
    await waitFor(x => x.slots.length === 8);

    // Joystick look: cursor offset from the center turns the view, no button held; leaving the visual stops it.
    await msg({ type: "objects", o: { gameplay: { lookMode: "joystick" } } });
    await sleep(400);
    await mouse("mouseMoved", CX, CY, "none", 0);
    await sleep(300);
    const jy0 = (await snap()).yaw;
    await mouse("mouseMoved", CX + 380, CY, "none", 0);
    await sleep(700);
    const jy1 = (await snap()).yaw;
    await mouse("mouseMoved", 1200, CY, "none", 0); // outside the visual
    await sleep(300);
    const jy2 = (await snap()).yaw, jy3 = await sleep(500).then(async () => (await snap()).yaw);
    ok("joystick look turns the view with no button", jy1 < jy0 - 0.4, `yaw ${jy0} -> ${jy1}`);
    // Headless Chrome puts this iframe out of process and sends it no leave event for synthetic mouse moves,
    // so this is reported, not asserted. Power BI Desktop runs it in process: checked there (see README).
    info.push(`joystick when the cursor leaves the iframe: ${Math.abs(jy3 - jy2) < 0.001 ? "stops" : "keeps turning (no leave event in headless out-of-process iframe)"}`);
    await msg({ type: "objects", o: { gameplay: { lookMode: "drag" } } });

    // Pause on blur is optional (default off), resume on click when enabled.
    await msg({ type: "blur" });
    await sleep(300);
    ok("blur does not pause by default", !(await snap()).paused);
    await msg({ type: "objects", o: { gameplay: { pauseOnBlur: true } } });
    await sleep(300);
    await msg({ type: "blur" });
    s = await waitFor(x => x.paused, 1500);
    await shot("05-pause");
    const pausedTime = s.time;
    await sleep(500);
    const stillPaused = (await snap()).time === pausedTime;
    await click(CX, CY);
    s = await waitFor(x => !x.paused, 1500);
    ok("blur pauses, click resumes", stillPaused && !s.paused);

    // End the round: summary + persisted best score.
    await msg({ type: "finish" });
    s = await waitFor(x => x.state === "summary", 3000);
    await sleep(400);
    L = (await last()).log;
    await shot("06-summary");
    const persisted = L.persist.at(-1)?.merge?.[0];
    ok("round end -> summary", s.state === "summary");
    ok("best scores persisted with persistProperties", persisted?.objectName === "records" && persisted.properties.rangeKills >= 4 && persisted.properties.bestTtk > 0,
        JSON.stringify(persisted?.properties));
    s = await waitFor(x => x.records.rangeKills >= 4, 2000);
    ok("persisted records come back through update()", s.records.rangeKills >= 4, JSON.stringify(s.records));

    // Menu (M) clears the selection, then Bot Duel.
    await key("KeyM");
    s = await waitFor(x => x.state === "menu");
    L = (await last()).log;
    ok("M returns to the menu and clears the selection", s.state === "menu" && L.select.at(-1) === null);
    await key("Digit2");
    s = await waitFor(x => x.mode === "duel" && x.bots === 1, 5000);
    ok("Bot Duel spawns one bot", s.mode === "duel" && s.bots === 1);
    await msg({ type: "crouchHead" });
    await sleep(200);
    const headFit = await top("window.acks.at(-1)");
    ok("bot head hitbox matches the drawn head (standing and crouched)", headFit === "ok,ok", headFit);
    const states = new Set();
    let firstShot = null;
    for (let i = 0; i < 24; i++) {
        await sleep(500);
        const x = await snap();
        x.botStates.forEach(b => states.add(b));
        if (firstShot === null && x.botShots > 0) firstShot = x.time;
    }
    info.push(`duel: first bot shot at ${firstShot ?? "none within 12 s"} s of play`);
    // The first shot depends on where the bot peeks (seeded but timing-dependent): wait for it instead of a fixed delay.
    s = await waitFor(x => x.botShots >= 1, 15000);
    await shot("07-duel");
    ok("duel bot moves, hides and peeks", states.has("hide") && states.has("peek"), [...states].join(","));
    await msg({ type: "spawnCheck" });
    await sleep(1500);
    const sp = await top("window.acks.at(-1)");
    ok("spawns: bots hidden and far enough, player respawns out of the bot's sight", sp?.n > 20 && sp.bad.length === 0, `checked=${sp?.n} bad=${sp?.bad?.slice(0, 3).join(" | ")}`);
    await msg({ type: "botSim" });
    await sleep(1500);
    const sim = await top("window.acks.at(-1)");
    ok("from every duel spawn spot the bot engages within 12 s (no stuck bot)", sim?.n > 10 && sim.bad.length === 0, `spots=${sim?.n} stuck=${sim?.bad?.join(" ")}`);
    ok("duel bot shoots back (shots fired at the player)", s.botShots >= 1, `botShots=${s.botShots} lastHurt=${s.lastHurt} deaths=${s.stats.deaths} health=${s.health}`);
    const fpsDuel = await fpsOver(3000);

    // Survival: waves of several bots.
    await key("KeyM");
    await waitFor(x => x.state === "menu");
    await key("Digit3");
    s = await waitFor(x => x.mode === "survival" && x.wave === 1 && x.bots >= 2, 9000);
    ok("Survival wave 1 spawns several bots", s.wave === 1 && s.bots >= 2, `wave=${s.wave} bots=${s.bots}`);
    await sleep(4000);
    await shot("08-survival");
    const fpsSurvival = await fpsOver(3000);
    ok("fps >= 30 with bots (duel / survival)", fpsDuel >= 30 && fpsSurvival >= 30, `duel ${fpsDuel} / survival ${fpsSurvival}`);

    // Summary keyboard: Enter redeploys.
    await msg({ type: "finish" });
    await waitFor(x => x.state === "summary", 3000);
    await key("Enter");
    s = await waitFor(x => x.state === "play" && x.mode === "survival");
    ok("Enter on the summary redeploys", s.state === "play");

    // Esc pauses and resumes; P does the same; the pause panel has a working menu button.
    await click(CX, CY);
    await key("Escape");
    s = await waitFor(x => x.paused, 1500);
    const escPaused = s.paused && !s.engaged;
    await key("Escape");
    s = await waitFor(x => !x.paused, 1500);
    const escResumed = !s.paused;
    await key("KeyP");
    s = await waitFor(x => x.paused, 1500);
    ok("Esc pauses, Esc resumes, P pauses", escPaused && escResumed && s.paused, `escPaused=${escPaused} escResumed=${escResumed} p=${s.paused}`);
    await key("KeyM");
    s = await waitFor(x => x.state === "menu", 1500);
    ok("M leaves the pause panel for the menu", s.state === "menu" && !s.paused, `state=${s.state} paused=${s.paused}`);

    // Resize: canvas follows the viewport.
    await top("const f = document.getElementById('visual'); f.width = 640; f.height = 360;");
    await sleep(800);
    const canvas = (await last()).canvas;
    ok("canvas follows viewport", String(canvas) === "640,360", String(canvas));
    const diag = (await last()).diag ?? "";
    const harnessErrors = await top("window.results.errors");
    ws.close();

    const external = requests.filter(u => !u.startsWith(base) && !/^(data|blob|about):/.test(u));
    // The pointer-lock block is the diagnostics probe result itself (reported in the overlay).
    const errors = [...harnessErrors, ...logs.filter(l => /^(error|exception)/.test(l) && !/Blocked pointer lock/.test(l))];
    const pbiviz = readdirSync(join(root, "dist")).filter(f => f.endsWith(".pbiviz")).map(f => statSync(join(root, "dist", f)).size).pop();
    const kb = n => `${(n / 1024).toFixed(0)} KB`;
    ok("no JS errors", errors.length === 0, errors.slice(0, 5).join(" | "));
    ok("no external requests", external.length === 0, external.join(" "));
    ok("bundle < 1 MB", drop.content.js.length < 1024 * 1024, kb(drop.content.js.length));

    console.log(`bundle visual.js ${kb(drop.content.js.length)} | packaged .pbiviz ${kb(pbiviz ?? 0)}`);
    console.log(`served: ${[...new Set(served)].join(" ")}`);
    console.log(`diagnostics overlay:\n  ${diag.split("\n").join("\n  ")}`);
    for (const line of info) console.log(`INFO  ${line}`);
    for (const [name, pass, detail] of checks) console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
    console.log(`screenshots: test/out/*.png`);
    return checks.every(c => c[1]) ? 0 : 1;
}
