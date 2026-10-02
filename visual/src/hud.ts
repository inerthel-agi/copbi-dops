// DOM HUD. Built with createElement/textContent only (innerHTML is rejected by the Power BI linter).

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent?: HTMLElement, text?: string): HTMLElementTagNameMap[K] {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    parent?.appendChild(e);
    return e;
}

export interface Tile { label: string; value: string; best?: boolean; }
export interface ModeCard { key: string; title: string; desc: string; best: string; }
export interface Ping { x: number; z: number; a: number; color: string; }
export interface ClassChip { label: string; detail: string; active: boolean; }
/** Class strip of the menu: index -1 = all weapons, then the classes. */
export interface ClassMenu { classes: ClassChip[]; onClass: (i: number) => void; onEdit: (() => void) | null; }
export interface EditorRow { label: string; value: string; desc: string; }

interface FeedEntry { node: HTMLElement; until: number; }

const ARC_COUNT = 6;

export class Hud {
    readonly root: HTMLDivElement;
    private text = new Map<HTMLElement, string>();
    private statKills: HTMLElement;
    private statAcc: HTMLElement;
    private statHs: HTMLElement;
    private timerLabel: HTMLElement;
    private timerValue: HTMLElement;
    private timerSub: HTMLElement;
    private zoneBox: HTMLElement;
    private zoneChips: { box: HTMLElement; fill: HTMLElement }[] = [];
    private feedBox: HTMLElement;
    private feedItems: FeedEntry[] = [];
    private cross: HTMLElement;
    private crossBars: HTMLElement[] = [];
    private hit: HTMLElement;
    private hitT = 0;
    private arcs: HTMLElement[] = [];
    private arcT: number[] = new Array(ARC_COUNT).fill(0);
    private arcNext = 0;
    private vignette: HTMLElement;
    private hurtT = 0;
    private scope: HTMLElement;
    private joy: HTMLElement;
    private statTtk: HTMLElement;
    private mini: HTMLCanvasElement;
    private miniCtx: CanvasRenderingContext2D;
    private hpFill: HTMLElement;
    private hpValue: HTMLElement;
    private bar: HTMLElement;
    private slots: HTMLElement[] = [];
    private ammoMag: HTMLElement;
    private ammoRes: HTMLElement;
    private ammoName: HTMLElement;
    private ammoClass: HTMLElement;
    private reloadFill: HTMLElement;
    private reloadBox: HTMLElement;
    private banner: HTMLElement;
    private bannerT = 0;
    private prompt: HTMLElement;
    private board: HTMLElement;
    private boardHead: HTMLElement;
    private boardBody: HTMLElement;
    private panel: HTMLElement;
    readonly diag: HTMLElement;
    private play: HTMLElement;

    constructor(parent: HTMLElement) {
        const root = this.root = el("div", "sl-hud", parent);
        this.vignette = el("div", "sl-vignette", root);
        this.scope = el("div", "sl-scope", root);
        el("div", "sl-scope-h", this.scope);
        el("div", "sl-scope-v", this.scope);
        el("div", "sl-scope-dot", this.scope);

        // Gameplay layer: hidden in menus.
        const play = this.play = el("div", "sl-play", root);
        const stats = el("div", "sl-stats", play);
        const stat = (label: string) => {
            const b = el("div", "sl-stat", stats);
            const v = el("div", "sl-stat-v", b, "0");
            el("div", "sl-stat-l", b, label);
            return v;
        };
        this.statKills = stat("KILLS");
        this.statAcc = stat("ACCURACY");
        this.statHs = stat("HEADSHOT");
        this.statTtk = stat("AVG TTK");
        this.joy = el("div", "sl-joy", play);

        const timer = el("div", "sl-timer", play);
        this.timerLabel = el("div", "sl-timer-l", timer);
        this.timerValue = el("div", "sl-timer-v", timer);
        this.timerSub = el("div", "sl-timer-s", timer);
        this.zoneBox = el("div", "sl-zones", timer);

        this.feedBox = el("div", "sl-feed", play);

        this.cross = el("div", "sl-cross", play);
        for (let i = 0; i < 4; i++) this.crossBars.push(el("div", "sl-cross-bar", this.cross));
        el("div", "sl-cross-dot", this.cross);
        this.hit = el("div", "sl-hit", play);
        for (let i = 0; i < 4; i++) el("div", "sl-hit-bar", this.hit);
        const ring = el("div", "sl-dmg", play);
        for (let i = 0; i < ARC_COUNT; i++) this.arcs.push(el("div", "sl-dmg-arc", ring));

        const radar = el("div", "sl-radar", play);
        this.mini = el("canvas", "sl-mini", radar);
        this.mini.width = this.mini.height = 150;
        this.miniCtx = this.mini.getContext("2d");
        const hp = el("div", "sl-hp", radar);
        this.hpValue = el("div", "sl-hp-v", hp, "100");
        const hpBar = el("div", "sl-hp-bar", hp);
        this.hpFill = el("div", "sl-hp-fill", hpBar);

        this.bar = el("div", "sl-bar", play);

        const ammo = el("div", "sl-ammo", play);
        const nums = el("div", "sl-ammo-n", ammo);
        this.ammoMag = el("span", "sl-ammo-mag", nums);
        this.ammoRes = el("span", "sl-ammo-res", nums);
        this.ammoName = el("div", "sl-ammo-name", ammo);
        this.ammoClass = el("div", "sl-ammo-class", ammo);
        this.reloadBox = el("div", "sl-reload", ammo);
        this.reloadFill = el("div", "sl-reload-fill", this.reloadBox);

        this.banner = el("div", "sl-banner", play);
        this.prompt = el("div", "sl-prompt", play);

        this.board = el("div", "sl-board", root);
        el("div", "sl-board-t", this.board, "SCOREBOARD");
        const table = el("table", "", this.board);
        this.boardHead = el("thead", "", table);
        this.boardBody = el("tbody", "", table);

        this.panel = el("div", "sl-panel", root);
        this.diag = el("div", "sl-diag", root);
        this.showPlay(false);
    }

    private set(e: HTMLElement, v: string): void {
        if (this.text.get(e) === v) return;
        this.text.set(e, v);
        e.textContent = v;
    }

    showPlay(on: boolean): void {
        this.play.style.display = on ? "" : "none";
        if (!on) {
            this.scope.style.display = "none";
            this.vignette.style.opacity = "0";
        }
    }

    stats(kills: number, acc: number, hs: number, killLabel: string, ttk: string, ttkLabel: string): void {
        this.set(this.statTtk, ttk);
        this.set(this.statTtk.nextElementSibling as HTMLElement, ttkLabel);
        this.set(this.statKills, String(kills));
        this.set(this.statKills.nextElementSibling as HTMLElement, killLabel);
        this.set(this.statAcc, `${acc.toFixed(0)}%`);
        this.set(this.statHs, `${hs.toFixed(0)}%`);
    }

    timer(label: string, value: string, sub: string, urgent: boolean): void {
        this.set(this.timerLabel, label);
        this.set(this.timerValue, value);
        this.set(this.timerSub, sub);
        this.timerValue.classList.toggle("urgent", urgent);
    }

    /** Domination chips under the timer: letter, owner color, capture progress bar, outline when the player stands in it. */
    zones(list: { name: string; owner: number; prog: number; here: boolean }[]): void {
        this.zoneBox.style.display = list.length ? "" : "none";
        while (this.zoneChips.length < list.length) {
            const box = el("div", "sl-zone", this.zoneBox);
            el("span", "sl-zone-n", box);
            this.zoneChips.push({ box, fill: el("div", "sl-zone-f", box) });
        }
        list.forEach((z, i) => {
            const c = this.zoneChips[i], cls = `sl-zone ${z.owner === 1 ? "mine" : z.owner === -1 ? "theirs" : ""}${z.here ? " here" : ""}`;
            if (c.box.className !== cls) c.box.className = cls;
            this.set(c.box.firstChild as HTMLElement, z.name);
            c.fill.style.width = `${Math.abs(z.prog) * 100}%`;
            c.fill.style.background = z.prog >= 0 ? "#4aa3ff" : "#e2483a";
        });
    }

    joystick(on: boolean): void {
        this.joy.style.display = on ? "block" : "none";
    }

    feed(now: number, killer: string, weapon: string, victim: string, head: boolean, mine: boolean, ttk?: string): void {
        const row = el("div", mine ? "sl-kf mine" : "sl-kf");
        el("span", "sl-kf-a", row, killer);
        el("span", "sl-kf-w", row, `[${weapon.toUpperCase()}]`);
        el("span", "sl-kf-b", row, victim);
        if (head) el("span", "sl-kf-hs", row, "HEADSHOT");
        if (ttk) el("span", "sl-kf-t", row, ttk);
        this.feedBox.prepend(row);
        this.feedItems.unshift({ node: row, until: now + 6 });
        while (this.feedItems.length > 5) this.feedItems.pop().node.remove();
    }

    clearFeed(): void {
        this.feedItems.forEach(f => f.node.remove());
        this.feedItems = [];
    }

    crosshair(gapPx: number, visible: boolean): void {
        this.cross.style.display = visible ? "" : "none";
        if (!visible) return;
        const g = Math.round(Math.min(120, gapPx + 3));
        const t = [`translate(-50%, ${-g}px) translateY(-100%)`, `translate(-50%, ${g}px)`, `translate(${-g}px, -50%) translateX(-100%)`, `translate(${g}px, -50%)`];
        this.crossBars.forEach((b, i) => {
            const v = t[i];
            if (b.dataset.t !== v) { b.dataset.t = v; b.style.transform = v; }
        });
    }

    hitmarker(head: boolean, kill: boolean): void {
        this.hitT = kill ? 0.45 : 0.22;
        this.hit.className = `sl-hit on${head ? " head" : ""}${kill ? " kill" : ""}`;
    }

    /** angle in radians: 0 = in front, positive = to the right. */
    damage(angle: number): void {
        const i = this.arcNext;
        this.arcNext = (i + 1) % ARC_COUNT;
        this.arcT[i] = 1.6;
        this.arcs[i].style.transform = `rotate(${angle}rad)`;
        this.hurtT = 0.35;
    }

    health(hp: number): void {
        this.set(this.hpValue, String(Math.ceil(hp)));
        this.hpFill.style.width = `${Math.max(0, hp)}%`;
        this.hpFill.classList.toggle("low", hp < 35);
        this.vignette.style.opacity = String(Math.min(1, Math.max(0, (1 - hp / 100) * 0.9) + this.hurtT * 1.2));
    }

    scoped(on: boolean): void {
        this.scope.style.display = on ? "block" : "none";
    }

    weaponBar(names: string[], active: number): void {
        const key = names.join("|");
        if (this.bar.dataset.k !== key) {
            this.bar.dataset.k = key;
            this.bar.replaceChildren();
            this.slots = names.map((n, i) => {
                const s = el("div", "sl-slot", this.bar);
                el("span", "sl-slot-k", s, String(i + 1));
                el("span", "sl-slot-n", s, n.toUpperCase());
                return s;
            });
        }
        this.slots.forEach((s, i) => s.classList.toggle("active", i === active));
    }

    ammo(mag: number, cap: number, reserve: number, name: string, cls: string, reload: number): void {
        this.set(this.ammoMag, String(mag));
        this.set(this.ammoRes, ` / ${reserve}`);
        this.set(this.ammoName, name.toUpperCase());
        this.set(this.ammoClass, cls.toUpperCase());
        this.ammoMag.classList.toggle("low", mag <= Math.ceil(cap * 0.25));
        this.reloadBox.style.visibility = reload >= 0 ? "visible" : "hidden";
        if (reload >= 0) this.reloadFill.style.width = `${Math.min(100, reload * 100)}%`;
    }

    showBanner(text: string, seconds = 2.2): void {
        this.set(this.banner, text);
        this.bannerT = seconds;
    }

    setPrompt(text: string): void {
        this.set(this.prompt, text);
    }

    minimap(map: HTMLCanvasElement, pxPerM: number, half: number, x: number, z: number, yaw: number, pings: Ping[]): void {
        const c = this.miniCtx, s = this.mini.width, zoom = 0.62;
        c.clearRect(0, 0, s, s);
        c.save();
        c.beginPath();
        c.arc(s / 2, s / 2, s / 2 - 1, 0, Math.PI * 2);
        c.clip();
        c.fillStyle = "rgba(22,24,20,0.72)";
        c.fillRect(0, 0, s, s);
        c.translate(s / 2, s / 2);
        c.rotate(yaw);
        c.scale(zoom, zoom);
        c.translate(-(x + half) * pxPerM, -(z + half) * pxPerM);
        c.drawImage(map, 0, 0);
        for (const p of pings) {
            c.globalAlpha = p.a;
            c.fillStyle = p.color;
            c.beginPath();
            c.arc((p.x + half) * pxPerM, (p.z + half) * pxPerM, 5 / zoom, 0, Math.PI * 2);
            c.fill();
        }
        c.restore();
        c.fillStyle = "rgba(255,255,255,0.08)";
        c.beginPath();
        c.moveTo(s / 2, s / 2);
        c.arc(s / 2, s / 2, s / 2, -Math.PI / 2 - 0.6, -Math.PI / 2 + 0.6);
        c.fill();
        c.fillStyle = "#ff7a1a";
        c.beginPath();
        c.moveTo(s / 2, s / 2 - 7);
        c.lineTo(s / 2 + 5, s / 2 + 5);
        c.lineTo(s / 2 - 5, s / 2 + 5);
        c.fill();
        c.strokeStyle = "rgba(214,206,170,0.45)";
        c.lineWidth = 2;
        c.beginPath();
        c.arc(s / 2, s / 2, s / 2 - 1, 0, Math.PI * 2);
        c.stroke();
    }

    scoreboard(show: boolean, head?: string[], rows?: { cells: string[]; me: boolean }[]): void {
        this.board.style.display = show ? "block" : "none";
        if (!show || !head) return;
        const tr = el("tr", "");
        head.forEach(h => el("th", "", tr, h));
        this.boardHead.replaceChildren(tr);
        this.boardBody.replaceChildren(...rows.map(r => {
            const row = el("tr", r.me ? "me" : "");
            r.cells.forEach(c => el("td", "", row, c));
            return row;
        }));
    }

    /** Per-frame decay of transient elements. */
    update(dt: number, now: number): void {
        this.hitT -= dt;
        if (this.hitT <= 0 && this.hit.classList.contains("on")) this.hit.className = "sl-hit";
        this.hurtT = Math.max(0, this.hurtT - dt);
        for (let i = 0; i < ARC_COUNT; i++) {
            if (this.arcT[i] <= 0) continue;
            this.arcT[i] -= dt;
            this.arcs[i].style.opacity = String(Math.max(0, Math.min(1, this.arcT[i])));
        }
        this.bannerT -= dt;
        this.banner.style.opacity = String(Math.max(0, Math.min(1, this.bannerT * 2)));
        while (this.feedItems.length && this.feedItems[this.feedItems.length - 1].until < now) this.feedItems.pop().node.remove();
    }

    // ---------- panels ----------

    hidePanel(): void {
        this.panel.style.display = "none";
        this.panel.replaceChildren();
    }

    menu(cm: ClassMenu, cards: ModeCard[], loadout: string, records: string, onPick: (key: string) => void, map: string, onMap: () => void, diff: string, onDiff: () => void): void {
        const p = this.openPanel("menu");
        const head = el("div", "sl-brand", p);
        el("div", "sl-brand-t", head, "CALL OF POWER BI");
        el("div", "sl-brand-s", head, "DATA OPS  ·  TACTICAL TRAINING SIMULATOR");
        const grid = el("div", "sl-modes", p);
        for (const c of cards) {
            const b = el("button", "sl-mode", grid);
            b.type = "button";
            el("div", "sl-mode-k", b, `[${c.key}]`);
            el("div", "sl-mode-t", b, c.title);
            el("div", "sl-mode-d", b, c.desc);
            el("div", "sl-mode-b", b, c.best);
            b.addEventListener("click", () => onPick(c.key));
        }
        const strip = el("div", "sl-classes", p);
        cm.classes.forEach((c, i) => {
            const b = el("button", c.active ? "sl-class active" : "sl-class", strip);
            b.type = "button";
            el("div", "sl-class-t", b, c.label);
            el("div", "sl-class-d", b, c.detail);
            b.addEventListener("click", () => cm.onClass(i - 1));
        });
        const row = el("div", "sl-buttons", p);
        const mb = el("button", "sl-btn sl-map", row, map);
        mb.type = "button";
        mb.addEventListener("click", onMap);
        const db = el("button", "sl-btn sl-diff", row, diff);
        db.type = "button";
        db.addEventListener("click", onDiff);
        el("span", "sl-line dim", row, "[C] NEXT CLASS");
        if (cm.onEdit) {
            const eb = el("button", "sl-btn primary sl-edit", row, "[V] EDIT CLASS");
            eb.type = "button";
            eb.addEventListener("click", cm.onEdit);
        }
        el("div", "sl-line", p, loadout);
        el("div", "sl-line dim", p, records);
        el("div", "sl-help", p,
            "WASD / ZQSD MOVE  ·  DRAG LOOK (OR JOYSTICK LOOK, FORMAT PANE)  ·  F FIRE (CLICK = SINGLE SHOT)  ·  RIGHT BUTTON / E AIM  ·  R RELOAD  ·  1-9 / WHEEL WEAPONS  ·  X TURN 180  ·  SHIFT SPRINT (ANY DIRECTION)  ·  C CROUCH / SLIDE WHILE SPRINTING, C AGAIN CANCELS  ·  SPACE JUMP  ·  TAB / B SCOREBOARD  ·  ESC / P PAUSE  ·  M MENU  ·  N NEXT MAP  ·  C NEXT CLASS  ·  V EDIT CLASS");
    }

    /** Create-a-class editor: each row cycles with its arrows. */
    classEditor(name: string, onRename: (name: string) => void, rows: EditorRow[], onStep: (row: number, dir: number) => void, onDone: () => void): void {
        const p = this.openPanel("editor");
        const input = el("input", "sl-ce-name", p);
        input.value = name;
        input.maxLength = 16;
        input.spellcheck = false;
        input.setAttribute("aria-label", "Class name");
        input.addEventListener("change", () => onRename(input.value));
        el("div", "sl-sum-s", p, "CLICK THE NAME TO RENAME. PICK A PRIMARY, A SECONDARY AND A PERK. SAVED IN THE REPORT.");
        rows.forEach((r, i) => {
            const line = el("div", "sl-ce", p);
            el("div", "sl-ce-l", line, r.label);
            const prev = el("button", "sl-btn sl-ce-prev", line, "<");
            const mid = el("div", "sl-ce-v", line);
            el("div", "sl-ce-n", mid, r.value);
            el("div", "sl-ce-d", mid, r.desc);
            const next = el("button", "sl-btn sl-ce-next", line, ">");
            prev.type = next.type = "button";
            prev.addEventListener("click", () => onStep(i, -1));
            next.addEventListener("click", () => onStep(i, 1));
        });
        const done = el("button", "sl-btn primary sl-ce-done", el("div", "sl-buttons", p), "[ENTER] DONE");
        done.type = "button";
        done.addEventListener("click", onDone);
    }

    summary(title: string, subtitle: string, tiles: Tile[], onRestart: () => void, onMenu: () => void): void {
        const p = this.openPanel("summary");
        el("div", "sl-sum-t", p, title);
        el("div", "sl-sum-s", p, subtitle);
        const grid = el("div", "sl-tiles", p);
        for (const t of tiles) {
            const b = el("div", t.best ? "sl-tile best" : "sl-tile", grid);
            el("div", "sl-tile-v", b, t.value);
            el("div", "sl-tile-l", b, t.label);
            if (t.best) el("div", "sl-tile-nb", b, "NEW BEST");
        }
        const row = el("div", "sl-buttons", p);
        const again = el("button", "sl-btn primary", row, "[ENTER] REDEPLOY");
        const menu = el("button", "sl-btn", row, "[M] MODE SELECT");
        again.type = menu.type = "button";
        again.addEventListener("click", onRestart);
        menu.addEventListener("click", onMenu);
    }

    pause(onMenu: () => void): void {
        const p = this.openPanel("pause");
        el("div", "sl-sum-t", p, "PAUSED");
        el("div", "sl-sum-s", p, "PRESS ESC OR P, OR CLICK THE GAME, TO RESUME");
        const row = el("div", "sl-buttons", p);
        const menu = el("button", "sl-btn", row, "[M] MODE SELECT");
        menu.type = "button";
        menu.addEventListener("click", onMenu);
    }

    private openPanel(kind: string): HTMLElement {
        this.panel.replaceChildren();
        this.panel.className = `sl-panel ${kind}`;
        this.panel.style.display = "flex";
        return el("div", "sl-panel-in", this.panel);
    }
}
