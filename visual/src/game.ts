import {
    ACESFilmicToneMapping, Fog, Mesh, PCFShadowMap, PerspectiveCamera, PointLight, Scene, Vector3, WebGLRenderer
} from "three";
import { Sfx } from "./audio";
import { Bot, BotContext, Target } from "./bots";
import { Effects } from "./effects";
import { Hud, Ping, Tile } from "./hud";
import { Input } from "./input";
import { buildWeapon, DEFAULT_ROSTER, hitDamage, kindOf, rangeMultiplier, rng, Weapon, WeaponRow, Zone } from "./rules";
import { ViewModel } from "./viewmodel";
import { Box, CoverPoint, HALF, MapId, MAPS, rayBox, Vec, World } from "./world";

export type Mode = "range" | "duel" | "survival";
export type Difficulty = "easy" | "normal" | "hard" | "veteran";

export interface Settings {
    sensitivity: number;   // 1..100
    invertY: boolean;
    fov: number;           // degrees
    difficulty: Difficulty;
    volume: number;        // 0..100
    quality: "low" | "high";
    diagnostics: boolean;
    lookMode: "capture" | "drag" | "joystick";
    pauseOnBlur: boolean;
}
export const DEFAULT_SETTINGS: Settings = { sensitivity: 45, invertY: false, fov: 75, difficulty: "normal", volume: 70, quality: "high", diagnostics: false, lookMode: "capture", pauseOnBlur: false };

export interface Records { rangeKills: number; duelKills: number; survivalWave: number; accuracy: number; spray: number; bestTtk: number; }
export const EMPTY_RECORDS: Records = { rangeKills: 0, duelKills: 0, survivalWave: 0, accuracy: 0, spray: 0, bestTtk: 0 };

export const PERKS = [
    { id: "steady", name: "STEADY AIM", desc: "HIP-FIRE SPREAD -35%" },
    { id: "quickhands", name: "QUICK HANDS", desc: "RELOAD 30% FASTER" },
    { id: "quickdraw", name: "QUICKDRAW", desc: "AIM 30% FASTER" },
    { id: "light", name: "LIGHTWEIGHT", desc: "MOVE AND SPRINT 8% FASTER" },
    { id: "scavenger", name: "SCAVENGER", desc: "+50% RESERVE AMMO" },
] as const;
export type PerkId = typeof PERKS[number]["id"];
export interface ClassDef { name: string; primary: string; secondary: string; perk: PerkId; }
/** Menu choices saved in the report. active = index of the class in use, -1 = every weapon of the table (1-9). */
export interface Loadouts { active: number; classes: ClassDef[]; map: MapId; }
const CLASS_COUNT = 5;
export const DEFAULT_LOADOUTS: Loadouts = {
    active: -1,
    classes: [["ASSAULT", "R-7 Carbine", "steady"], ["RUSHER", "Hawk SMG", "light"], ["SNIPER", "Longshot", "quickdraw"],
        ["MARKSMAN", "Talon DMR", "scavenger"], ["BREACHER", "Brute", "quickhands"]]
        .map(([name, primary, perk]) => ({ name, primary, secondary: "Ward-9", perk: perk as PerkId })),
    map: "yard",
};

/** Class names: letters, digits, space, - and . only, uppercase, 16 characters. */
export const cleanName = (v: unknown): string => (typeof v === "string" ? v.replace(/[^A-Za-z0-9 .-]/g, "").trim().slice(0, 16).toUpperCase() : "");

/** Untrusted input (persisted JSON): keeps only well-formed fields. */
export function sanitizeLoadouts(raw: unknown): Loadouts {
    const d = DEFAULT_LOADOUTS, o = (raw && typeof raw === "object" ? raw : {}) as Partial<Loadouts>;
    const list = Array.isArray(o.classes) ? o.classes : [];
    const str = (v: unknown, def: string) => (typeof v === "string" && v ? v.slice(0, 24) : def);
    const classes = d.classes.map((c, i) => {
        const x = (list[i] ?? {}) as Partial<ClassDef>;
        return {
            name: cleanName(x.name) || c.name, primary: str(x.primary, c.primary), secondary: str(x.secondary, c.secondary),
            perk: PERKS.some(p => p.id === x.perk) ? x.perk : c.perk,
        };
    });
    const a = Number(o.active);
    const map = MAPS.find(m => m.id === o.map)?.id ?? d.map;
    return { active: Number.isInteger(a) && a >= -1 && a < CLASS_COUNT ? a : -1, classes, map };
}

export interface GameHooks {
    /** Weapon equipped by the player (null = back to the menu). */
    equip(name: string | null): void;
    /** New personal bests to persist. */
    records(r: Records): void;
    /** Classes edited in the menu, to persist. */
    loadouts(l: Loadouts): void;
    /** Difficulty picked in the menu, to persist in the format pane setting. */
    difficulty(d: Difficulty): void;
}

interface Slot { w: Weapon; mag: number; reserve: number; }
interface Stats { shots: number; hits: number; heads: number; kills: number; deaths: number; sprayShots: number; sprayHits: number; missed: number; ttkSum: number; ttkN: number; ttkBest: number; }
const newStats = (): Stats => ({ shots: 0, hits: 0, heads: 0, kills: 0, deaths: 0, sprayShots: 0, sprayHits: 0, missed: 0, ttkSum: 0, ttkN: 0, ttkBest: 0 });

const EYE = 1.65, CROUCH_EYE = 1.12, RADIUS = 0.32;
const SPEED = { walk: 4.6, sprint: 6.6, crouch: 2.3, ads: 2.8 };
const GRAVITY = 20, JUMP = 6.4, REGEN_DELAY = 4.5, REGEN_RATE = 28;
const JOY_DEADZONE = 0.12;
const SLIDE_TIME = 0.8, SLIDE_BOOST = 1.32, SLIDE_FRICTION = 5.5;
const RANGE_TIME = 60, DUEL_TIME = 180, DUEL_SCORE = 5, RECORD_MIN_SHOTS = 15;
const BOT_NAMES = ["ANVIL", "RIFT", "OSPREY", "GHOUL", "MANTIS", "COBALT", "SABLE", "TALUS", "WRAITH", "BRAMBLE", "CINDER", "DUSK"];
const BOT_WEAPON = "VX-3 Rifle";
// skill drives aim error and reaction time; damage per hit on 100 HP (easy 9 hits, normal 6, hard 5, veteran 4);
// rush = share of cover picks replaced by a push toward the player.
const SKILL: Record<Difficulty, number> = { easy: 0.2, normal: 0.5, hard: 0.75, veteran: 0.92 };
const BOT_DAMAGE: Record<Difficulty, number> = { easy: 12, normal: 18, hard: 24, veteran: 30 };
const RUSH: Record<Difficulty, number> = { easy: 0.05, normal: 0.15, hard: 0.3, veteran: 0.45 };
const DIFFS: Difficulty[] = ["easy", "normal", "hard", "veteran"];
const MODE_KEYS: Record<string, Mode> = { "1": "range", "2": "duel", "3": "survival" };
const DUST: [number, number, number] = [0.6, 0.56, 0.45];
const BLOOD: [number, number, number] = [0.42, 0.1, 0.07];
const SPARK: [number, number, number] = [1, 0.72, 0.38];
const UP = new Vector3(0, 1, 0), SIDE = new Vector3(1, 0, 0);

const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const pct = (a: number, b: number) => (b > 0 ? a / b * 100 : 0);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

interface Trace { t: number; bot: Bot | null; target: Target | null; zone: Zone | null; world: boolean; nx: number; ny: number; nz: number; }

export class Game {
    private renderer: WebGLRenderer;
    private scene = new Scene();
    private camera = new PerspectiveCamera(75, 1, 0.05, 400);
    private world = new World();
    private fx: Effects;
    private vm = new ViewModel();
    private hud: Hud;
    private sfx = new Sfx();
    private input: Input;
    private r = rng(20261002);
    private muzzleLight = new PointLight(0xffb060, 0, 10, 2);
    private width = 1;
    private height = 1;

    private settings: Settings = { ...DEFAULT_SETTINGS };
    private records: Records = { ...EMPTY_RECORDS };
    private rows: WeaponRow[] = DEFAULT_ROSTER;
    private fromData = false;
    private loadouts: Loadouts = sanitizeLoadouts(null);
    /** Class being edited in the menu, -1 = none. */
    private editing = -1;

    private state: "menu" | "play" | "summary" = "menu";
    private mode: Mode = "range";
    private paused = false;
    private time = 0;
    private clock = 0;
    private roundTime = 0;
    private endAt = -1;
    private endTitle = "";
    private endSub = "";
    private stats = newStats();

    private pos = new Vector3();
    private hv = new Vector3();
    private velY = 0;
    private yaw = 0;
    /** Radians left to turn for the 180 degree quick turn. */
    private quickTurn = 0;
    private pitch = 0;
    private recoilP = 0;
    private recoilY = 0;
    private onGround = true;
    private crouch = 0;
    private ads = 0;
    private sprint = 0;
    // Slide: time left, cooldown, direction, speed, smoothed 0..1 pose, last cancel time, crouch key held through a cancel.
    private slideT = 0;
    private slideCd = 0;
    private slideX = 0;
    private slideZ = 0;
    private slideV = 0;
    private slideBlend = 0;
    private slideCancelAt = -99;
    private cancelHold = false;
    private health = 100;
    private lastHurt = -99;
    private alive = true;
    private diedAt = 0;
    private respawnAt = -1;
    private stepAcc = 0;

    private slots: Slot[] = [];
    private cur = 0;
    private draw = 1;
    private reloadT = -1;
    private cooldown = 0;
    private latch = false;
    private shotIndex = 0;
    private lastShotAt = -99;
    private bloom = 0;

    private bots: Bot[] = [];
    private targets: Target[] = [];
    private claimed = new Set<CoverPoint>();
    private duel = { you: 0, them: 0 };
    /** front = bearing (radians, from the player) most of the wave comes from. */
    private wave = { n: 0, queue: 0, breakT: 0, spawnT: 0, cap: 0, front: 0 };
    private spotCache: { world: World; list: Vec[] } | null = null;
    private nameIdx = 0;
    private botShots = 0;
    private botCtx: BotContext;

    private last = 0;
    private fpsT = 0;
    private fpsN = 0;
    private fps = 0;
    private boardT = 0;
    private probes: Record<string, string> = {};
    private lockProbed = false;
    private playerBox: Box = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
    private tr: Trace = { t: 0, bot: null, target: null, zone: null, world: false, nx: 0, ny: 0, nz: 0 };
    private vA = new Vector3();
    private vB = new Vector3();
    private vC = new Vector3();
    private vD = new Vector3();
    private vE = new Vector3();

    constructor(private root: HTMLElement, private hooks: GameHooks) {
        root.classList.add("sl-root");
        const r = this.renderer = new WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
        r.toneMapping = ACESFilmicToneMapping;
        r.toneMappingExposure = 1.05;
        r.shadowMap.type = PCFShadowMap;
        r.autoClear = false;
        r.info.autoReset = false;
        root.appendChild(r.domElement);

        this.scene.background = this.world.sky;
        this.scene.fog = new Fog(this.world.sky, 45, 170);
        this.scene.add(this.world.group, this.muzzleLight);
        this.fx = new Effects(this.scene, this.r);
        this.hud = new Hud(root);
        this.input = new Input(root, p => this.onGesture(p));
        this.botCtx = {
            world: this.world, r: this.r, now: 0, eye: new Vector3(), feet: this.pos, playerAlive: true, skill: 0.5, rush: 0.15,
            claimed: this.claimed, others: this.bots, shoot: (b, eye, muzzle, e) => this.botShoot(b, eye, muzzle, e),
        };
        window.addEventListener("blur", this.onBlur);

        this.buildSlots();
        this.vm.setEnvironment(r);
        this.vm.setWeapon(this.slots[0].w);
        this.applyQuality();
        this.probeStatic();
        this.setSettings(this.settings);
        this.renderMenu();
        r.setAnimationLoop(t => this.tick(t));
    }

    // ---------- Power BI facing API ----------

    resize(width: number, height: number): void {
        if (width <= 0 || height <= 0) return;
        this.width = width;
        this.height = height;
        this.renderer.setSize(width, height);
        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();
        this.vm.resize(width / height);
    }

    setSettings(s: Settings): void {
        const qualityChanged = s.quality !== this.settings.quality;
        this.settings = s;
        this.sfx.setVolume(s.volume / 100);
        this.input.captureMode = s.lookMode === "capture";
        if (!this.input.captureMode) this.input.release();
        this.hud.diag.style.display = s.diagnostics ? "" : "none";
        if (qualityChanged) this.applyQuality();
    }

    setRecords(r: Records): void {
        this.records = r;
        if (this.state === "menu") this.renderMenu();
    }

    /** New loadout from data (slicer / filters). Never restarts a round. */
    setLoadout(rows: WeaponRow[], fromData: boolean): void {
        this.rows = rows.length ? rows : DEFAULT_ROSTER;
        this.fromData = fromData && rows.length > 0;
        this.reslot();
    }

    /** Persisted classes (format objects). Never restarts a round. */
    setLoadouts(l: Loadouts): void {
        this.loadouts = sanitizeLoadouts(l);
        this.loadMap(this.loadouts.map);
        this.reslot();
    }

    /** primary = a class was picked or edited: start on its first weapon. */
    private reslot(primary = false): void {
        const prev = primary ? null : this.slots[this.cur]?.w.name;
        this.buildSlots();
        const idx = this.slots.findIndex(s => s.w.name === prev);
        this.cur = Math.max(0, idx);
        this.vm.setWeapon(this.slots[this.cur].w);
        if (idx < 0) {
            this.draw = 0;
            this.reloadT = -1;
            if (this.state === "play") this.hooks.equip(this.slots[this.cur].w.name);
        }
        if (this.state === "menu") this.renderMenu();
    }

    dispose(): void {
        this.renderer.setAnimationLoop(null);
        window.removeEventListener("blur", this.onBlur);
        this.input.dispose();
        this.clearActors();
        this.sfx.close();
        this.renderer.dispose();
        this.root.replaceChildren();
    }

    /** Compact state for the sandbox test harness and the diagnostics overlay. */
    snapshot(): Record<string, unknown> {
        const s = this.slot();
        return {
            state: this.state, mode: this.mode, map: this.world.map, spawns: [this.world.playerSpawns.length, this.world.botSpawns.length],
            rangeTargets: this.world.rangeSpots.length + this.world.rangeRails.length, engaged: this.input.engaged, paused: this.paused, time: +this.time.toFixed(2),
            pos: [this.pos.x, this.pos.y, this.pos.z].map(v => +v.toFixed(2)), yaw: +this.yaw.toFixed(3), pitch: +this.pitch.toFixed(3),
            health: Math.round(this.health), lastHurt: +this.lastHurt.toFixed(2), alive: this.alive, weapon: s.w.name, mag: s.mag, reserve: s.reserve, reloading: this.reloadT >= 0,
            ads: +this.ads.toFixed(2), sliding: this.slideT > 0, speed: +Math.hypot(this.hv.x, this.hv.z).toFixed(2), crouch: +this.crouch.toFixed(2), slots: this.slots.map(x => x.w.name), fromData: this.fromData, stats: { ...this.stats },
            bots: this.bots.filter(b => b.alive).length, botShots: this.botShots, botStates: this.bots.map(b => b.state), wave: this.wave.n, duel: { ...this.duel },
            roundTime: +this.roundTime.toFixed(1), fps: Math.round(this.fps), audio: this.sfx.state, records: { ...this.records },
            loadouts: this.loadouts, editing: this.editing, perk: this.perk(),
        };
    }

    // ---------- flow ----------

    private renderMenu(): void {
        if (this.editing >= 0) return this.renderEditor();
        const R = this.records, n = this.slots.length, L = this.loadouts;
        const classes = [{ label: "ALL WEAPONS", detail: "EVERY WEAPON OF THE TABLE ON 1-9", active: L.active === -1 },
            ...L.classes.map((c, i) => ({
                label: c.name, active: L.active === i,
                detail: `${this.classRows(c).map(r => r.name.toUpperCase()).join(" + ")}  ·  ${PERKS.find(p => p.id === c.perk).name}`,
            }))];
        this.hud.menu({
            classes, onClass: i => this.pickClass(i), onEdit: L.active >= 0 ? () => { this.editing = L.active; this.renderMenu(); } : null,
        }, [
            { key: "1", title: "AIM RANGE", desc: `${RANGE_TIME} SECONDS OF STATIC AND MOVING STEEL. EVERY MISS COUNTS.`, best: `BEST ${R.rangeKills} TARGETS` },
            { key: "2", title: "BOT DUEL", desc: `FIRST TO ${DUEL_SCORE}. THE BOT PEEKS, SHOOTS BACK AND TAKES COVER.`, best: `BEST ${R.duelKills} KILLS` },
            { key: "3", title: "SURVIVAL", desc: "ENDLESS WAVES OF HELMETED HOSTILES. HEALTH REGENERATES.", best: `BEST WAVE ${R.survivalWave}` },
        ], `LOADOUT: ${n} WEAPON${n > 1 ? "S" : ""}  ·  ${this.fromData ? "FROM THE WEAPONS TABLE (CLASS SLICER APPLIES)" : "DEFAULT ROSTER (NO DATA BOUND)"}`,
        `BEST ACCURACY ${R.accuracy.toFixed(0)}%  ·  BEST SPRAY SCORE ${R.spray.toFixed(0)}  ·  BEST TTK ${R.bestTtk ? R.bestTtk + " MS" : "—"}`,
        key => this.start(MODE_KEYS[key]),
        `[N] MAP: ${MAPS.find(m => m.id === this.world.map).name}  ·  ${MAPS.find(m => m.id === this.world.map).desc}`, () => this.nextMap(),
        `[D] BOTS: ${this.settings.difficulty.toUpperCase()}`, () => this.nextDifficulty());
    }

    private nextDifficulty(): void {
        const d = DIFFS[(DIFFS.indexOf(this.settings.difficulty) + 1) % DIFFS.length];
        this.settings = { ...this.settings, difficulty: d };
        this.hooks.difficulty(d);
        this.renderMenu();
    }

    /** -1 = all weapons, 0..4 = a class. */
    private pickClass(i: number): void {
        this.loadouts = { ...this.loadouts, active: i };
        this.hooks.loadouts(this.loadouts);
        this.reslot(true);
    }

    private renderEditor(): void {
        const c = this.loadouts.classes[this.editing], [a, b = a] = this.classRows(c), perk = PERKS.find(p => p.id === c.perk);
        const stat = (row: WeaponRow) => `${row.cls.toUpperCase()}  ·  ${row.damage} DMG  ·  ${row.rpm} RPM  ·  ${row.mag} ROUNDS`;
        this.hud.classEditor(c.name, name => this.renameClass(name), [
            { label: "PRIMARY", value: a.name.toUpperCase(), desc: stat(a) },
            { label: "SECONDARY", value: b.name.toUpperCase(), desc: stat(b) },
            { label: "PERK", value: perk.name, desc: perk.desc },
        ], (row, dir) => this.stepClass(row, dir), () => { this.editing = -1; this.renderMenu(); });
    }

    private renameClass(raw: string): void {
        const name = cleanName(raw);
        if (!name) return this.renderMenu();
        this.loadouts = { ...this.loadouts, classes: this.loadouts.classes.map((x, i) => (i === this.editing ? { ...x, name } : x)) };
        this.hooks.loadouts(this.loadouts);
        this.renderMenu();
    }

    /** Editor arrows: row 0 primary, 1 secondary, 2 perk. */
    private stepClass(row: number, dir: number): void {
        const c = { ...this.loadouts.classes[this.editing] };
        const cycle = <T>(list: readonly T[], i: number) => list[((Math.max(0, i) + dir) % list.length + list.length) % list.length];
        if (row === 2) c.perk = cycle(PERKS, PERKS.findIndex(p => p.id === c.perk)).id;
        else {
            const list = this.choices(row === 1), key = row === 1 ? "secondary" : "primary";
            c[key] = cycle(list, list.findIndex(r => r.name === c[key])).name;
        }
        this.loadouts = { ...this.loadouts, classes: this.loadouts.classes.map((x, i) => (i === this.editing ? c : x)) };
        this.hooks.loadouts(this.loadouts);
        this.reslot(true);
    }

    /** Menu only: next layout, saved with the classes. */
    private nextMap(): void {
        const map = MAPS[(MAPS.findIndex(m => m.id === this.world.map) + 1) % MAPS.length].id;
        this.loadouts = { ...this.loadouts, map };
        this.hooks.loadouts(this.loadouts);
        this.loadMap(map);
    }

    /** Rebuilds the arena (never during a round). */
    private loadMap(map: MapId): void {
        if (map === this.world.map || this.state === "play") return;
        this.scene.remove(this.world.group);
        this.world.dispose();
        this.world = this.botCtx.world = new World(map);
        this.scene.add(this.world.group);
        this.scene.background = this.world.sky;
        (this.scene.fog as Fog).color.copy(this.world.sky);
        this.applyQuality();
        this.renderMenu();
    }

    private toMenu(): void {
        this.state = "menu";
        this.paused = false;
        this.clearActors();
        this.hud.showPlay(false);
        this.hud.scoreboard(false);
        this.loadMap(this.loadouts.map);
        this.renderMenu();
        this.hooks.equip(null);
    }

    private start(mode: Mode): void {
        this.mode = mode;
        this.state = "play";
        this.paused = false;
        this.time = 0;
        this.endAt = -1;
        this.stats = newStats();
        this.clearActors();
        this.hud.hidePanel();
        this.hud.clearFeed();
        this.hud.showPlay(true);
        for (const s of this.slots) {
            s.mag = s.w.mag;
            s.reserve = Math.round(s.w.mag * (mode === "range" ? 8 : 4) * (this.perk() === "scavenger" ? 1.5 : 1));
        }
        this.draw = 0;
        this.reloadT = -1;
        this.recoilP = this.recoilY = this.bloom = 0;
        this.shotIndex = 0;
        this.health = 100;
        this.alive = true;
        this.respawnAt = -1;
        this.lastHurt = -99;
        this.place(mode === "range" ? this.world.rangeOrigin : this.world.playerSpawns[0]);
        if (mode === "range") this.yaw = 0; // straight downrange, even from an off-center firing position
        this.botCtx.skill = SKILL[this.settings.difficulty];
        this.botCtx.rush = RUSH[this.settings.difficulty];

        if (mode === "range") {
            this.roundTime = RANGE_TIME;
            this.world.rangeSpots.forEach((s, i) => this.addTarget(new Target(s, null, `T-${String(i + 1).padStart(2, "0")}`)));
            this.world.rangeRails.forEach((rail, i) => this.addTarget(new Target(rail[0], rail, `M-${i + 1}`)));
            this.hud.showBanner("AIM RANGE  ·  HIT THE STEEL");
        } else if (mode === "duel") {
            this.roundTime = DUEL_TIME;
            this.duel = { you: 0, them: 0 };
            const b = this.addBot();
            b.alive = false;
            b.group.visible = false;
            b.respawnAt = 1.5;
            this.hud.showBanner(`BOT DUEL  ·  FIRST TO ${DUEL_SCORE}`);
        } else {
            this.roundTime = 0;
            this.wave = { n: 0, queue: 0, breakT: 3, spawnT: 0, cap: 0, front: this.r() * Math.PI * 2 };
            this.hud.showBanner("SURVIVAL  ·  HOLD THE LINE");
        }
        this.hooks.equip(this.slot().w.name);
    }

    private finishLater(title: string, sub: string, delay: number): void {
        if (this.endAt >= 0) return;
        this.endAt = this.time + delay;
        this.endTitle = title;
        this.endSub = sub;
    }

    private endRound(): void {
        this.state = "summary";
        this.hud.showPlay(false);
        this.hud.scoreboard(false);
        const s = this.stats, acc = pct(s.hits, s.shots), hs = pct(s.heads, s.hits), spray = pct(s.sprayHits, s.sprayShots);
        const R = { ...this.records };
        let kBest = false, aBest = false, sBest = false, tBest = false;
        if (s.ttkN >= 3 && (R.bestTtk === 0 || s.ttkBest < R.bestTtk)) { R.bestTtk = s.ttkBest; tBest = true; }
        if (this.mode === "range" && s.kills > R.rangeKills) { R.rangeKills = s.kills; kBest = true; }
        if (this.mode === "duel" && s.kills > R.duelKills) { R.duelKills = s.kills; kBest = true; }
        if (this.mode === "survival" && this.wave.n > R.survivalWave) { R.survivalWave = this.wave.n; kBest = true; }
        if (s.shots >= RECORD_MIN_SHOTS && acc > R.accuracy) { R.accuracy = Math.round(acc * 10) / 10; aBest = true; }
        if (s.sprayShots >= RECORD_MIN_SHOTS && spray > R.spray) { R.spray = Math.round(spray * 10) / 10; sBest = true; }
        if (kBest || aBest || sBest || tBest) {
            this.records = R;
            this.hooks.records(R);
        }
        const common: Tile[] = [
            { label: "ACCURACY", value: `${acc.toFixed(0)}%`, best: aBest },
            { label: "HEADSHOT", value: `${hs.toFixed(0)}%` },
            { label: "SPRAY SCORE", value: s.sprayShots >= 5 ? spray.toFixed(0) : "—", best: sBest },
            { label: this.mode === "range" ? "AVG REACTION" : "AVG TTK", value: s.ttkN ? `${Math.round(s.ttkSum / s.ttkN)} ms` : "—" },
            { label: this.mode === "range" ? "BEST REACTION" : "BEST TTK", value: s.ttkBest ? `${s.ttkBest} ms` : "—", best: tBest },
        ];
        const tiles: Tile[] = this.mode === "range"
            ? [{ label: "TARGETS", value: String(s.kills), best: kBest }, ...common, { label: "MISSED", value: String(s.missed) }]
            : this.mode === "duel"
                ? [{ label: "SCORE", value: `${this.duel.you} – ${this.duel.them}` }, { label: "KILLS", value: String(s.kills), best: kBest },
                    { label: "DEATHS", value: String(s.deaths) }, ...common]
                : [{ label: "WAVE", value: String(this.wave.n), best: kBest }, { label: "KILLS", value: String(s.kills) },
                    { label: "TIME", value: fmtTime(this.roundTime) }, ...common];
        this.hud.summary(this.endTitle, this.endSub, tiles, () => this.start(this.mode), () => this.toMenu());
    }

    private place(p: Vec): void {
        this.pos.set(p.x, 0, p.z);
        this.hv.set(0, 0, 0);
        this.velY = 0;
        this.yaw = Math.atan2(p.x, p.z);
        this.pitch = 0;
    }

    private clearActors(): void {
        for (const b of this.bots) {
            this.scene.remove(b.group);
            b.dispose();
        }
        for (const t of this.targets) this.scene.remove(t.group);
        this.bots.length = 0;
        this.targets.length = 0;
        this.claimed.clear();
        this.fx.clear();
    }

    private addTarget(t: Target): void {
        this.targets.push(t);
        this.scene.add(t.group);
    }

    private addBot(): Bot {
        const b = new Bot(BOT_NAMES[this.nameIdx++ % BOT_NAMES.length]);
        this.bots.push(b);
        this.scene.add(b.group);
        return b;
    }

    /** Every place an actor may appear: the map's fixed spawns plus every cover spot (cached per arena). */
    private spawnSpots(): Vec[] {
        if (this.spotCache?.world !== this.world) {
            this.spotCache = { world: this.world, list: [...this.world.botSpawns, ...this.world.playerSpawns, ...this.world.cover.map(c => ({ x: c.x, y: 0, z: c.z }))] };
        }
        return this.spotCache.list;
    }

    /** Head (1.6 m) or chest (1.0 m) at (x, z) seen from eye. */
    private seenFrom(x: number, z: number, eye: Vec): boolean {
        return this.world.los({ x, y: 1.6, z }, eye) || this.world.los({ x, y: 1.0, z }, eye);
    }

    /**
     * Bot spawn: hidden from the player (head and chest), at least 12 m away (scaled to the map), 3 m from other bots,
     * close to an ideal distance so fights start fast, never close behind the player, and in Survival mostly from
     * the wave's front (it changes every wave). Falls back to the farthest fixed spawn when nothing qualifies.
     */
    private spawnBot(b: Bot): void {
        const eye = this.vA.set(this.pos.x, this.pos.y + EYE, this.pos.z);
        const k = this.world.bound / HALF, ideal = (this.mode === "duel" ? 18 : 24) * k, dMin = 12 * k;
        const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
        let best: Vec | null = null, bestScore = -Infinity;
        for (const s of this.spawnSpots()) {
            const dx = s.x - this.pos.x, dz = s.z - this.pos.z, d = Math.hypot(dx, dz);
            if (d < dMin || this.seenFrom(s.x, s.z, eye)) continue;
            if (this.bots.some(o => o !== b && o.alive && Math.hypot(o.pos.x - s.x, o.pos.z - s.z) < 3)) continue;
            let score = -Math.abs(d - ideal) + this.r() * 6;
            if ((dx * fx + dz * fz) / d < -0.5 && d < ideal) score -= 12;
            if (this.mode === "survival") score += Math.cos(Math.atan2(dx, dz) - this.wave.front) * 8;
            if (score > bestScore) { bestScore = score; best = s; }
        }
        if (!best) {
            let far = -1;
            for (const s of this.world.botSpawns) {
                const d = Math.hypot(s.x - this.pos.x, s.z - this.pos.z);
                if (d > far) { far = d; best = s; }
            }
        }
        b.spawn(best, Math.atan2(best.x - this.pos.x, best.z - this.pos.z));
    }

    private onBlur = (): void => {
        if (!this.settings.pauseOnBlur || this.state !== "play" || this.paused) return;
        this.paused = true;
        this.hud.pause(() => this.toMenu());
    };

    private onGesture(pointer: boolean): void {
        this.sfx.unlock();
        if (pointer && this.paused) {
            this.paused = false;
            this.hud.hidePanel();
        }
        if (pointer && this.settings.diagnostics && !this.lockProbed) this.probePointerLock();
    }

    // ---------- frame ----------

    private tick(t: number): void {
        const dt = Math.min(0.05, Math.max(0, (t - (this.last || t)) / 1000));
        this.last = t;
        this.clock += dt;
        const live = this.state === "play" && !this.paused;
        if (!live && this.input.engaged) this.input.release();
        this.root.classList.toggle("sl-engaged", this.input.engaged);
        if (live) {
            this.time += dt;
            this.step(dt);
        } else if (this.state === "menu") {
            this.pos.set(0, 1.4, 30);
            this.yaw = Math.sin(this.clock * 0.08) * 0.5;
            this.pitch = -0.06;
            this.alive = true;
        }
        this.handleKeys();
        this.fx.update(this.paused ? 0 : dt);
        this.updateCamera(dt);
        this.hud.update(dt, this.time);
        this.render();
        this.updateDiag(t, dt);
        this.input.endFrame();
    }

    private step(dt: number): void {
        this.updatePlayer(dt);
        this.updateWeapon(dt);
        const c = this.botCtx;
        c.now = this.time;
        c.eye.set(this.pos.x, this.pos.y + lerp(EYE, CROUCH_EYE, this.crouch), this.pos.z);
        c.playerAlive = this.alive;
        for (const b of this.bots) b.update(dt, c);
        if (this.mode === "range") this.updateRange(dt);
        else if (this.mode === "duel") this.updateDuel();
        else this.updateSurvival(dt);
        if (this.endAt >= 0 && this.time >= this.endAt) {
            this.endRound();
            return;
        }
        this.updatePlayHud();
    }

    private handleKeys(): void {
        const inp = this.input;
        if (this.state === "menu" && this.editing >= 0) {
            if (inp.pressed("Escape") || inp.pressed("Enter") || inp.pressed("KeyV")) {
                this.editing = -1;
                this.renderMenu();
            }
        } else if (this.state === "menu") {
            if (inp.pressed("KeyC")) return this.pickClass(this.loadouts.active + 1 < CLASS_COUNT ? this.loadouts.active + 1 : -1);
            if (inp.pressed("KeyV") && this.loadouts.active >= 0) {
                this.editing = this.loadouts.active;
                return this.renderMenu();
            }
            for (const k of Object.keys(MODE_KEYS)) if (inp.pressed(`Digit${k}`) || inp.pressed(`Numpad${k}`)) return this.start(MODE_KEYS[k]);
            if (inp.pressed("KeyN")) this.nextMap();
            if (inp.pressed("KeyD")) this.nextDifficulty();
        } else if (this.state === "summary") {
            if (inp.pressed("Enter") || inp.pressed("NumpadEnter")) this.start(this.mode);
            else if (inp.pressed("KeyM") || inp.pressed("Escape")) this.toMenu();
        } else if (inp.pressed("Escape") || inp.pressed("KeyP")) {
            this.togglePause();
        } else if (inp.pressed("KeyM")) {
            this.toMenu();
        } else {
            const show = inp.down.has("Tab") || inp.down.has("KeyB");
            if (show && (this.boardT -= 1) <= 0) {
                this.boardT = 15;
                this.renderBoard();
            } else if (!show && this.boardT !== 0) {
                this.boardT = 0;
                this.hud.scoreboard(false);
            }
        }
    }

    /** Esc / P: pause (releases the mouse capture) or resume. */
    private togglePause(): void {
        if (this.paused) {
            this.paused = false;
            this.hud.hidePanel();
        } else {
            this.paused = true;
            this.input.release();
            this.hud.pause(() => this.toMenu());
        }
    }

    // ---------- player ----------

    private slot(): Slot {
        return this.slots[this.cur];
    }

    private perk(): PerkId | null {
        return this.loadouts.active >= 0 ? this.loadouts.classes[this.loadouts.active].perk : null;
    }

    /** Weapons a class may use: primaries = everything but pistols, secondaries = pistols (any weapon when none fits). */
    private choices(secondary: boolean): WeaponRow[] {
        const fit = this.rows.filter(r => (kindOf(r.cls) === "pistol") === secondary);
        return fit.length ? fit : this.rows;
    }

    /** Current class resolved against the rows in the data (the slicer can remove a weapon). */
    private classRows(c: ClassDef): WeaponRow[] {
        const pick = (name: string, secondary: boolean) => {
            const list = this.choices(secondary);
            return list.find(r => r.name === name) ?? list[0];
        };
        const a = pick(c.primary, false), b = pick(c.secondary, true);
        return a && b && a.name !== b.name ? [a, b] : [a ?? b];
    }

    private buildSlots(): void {
        const seen = new Set<string>();
        const old = this.slots, perk = this.perk();
        const rows = this.loadouts.active >= 0 && this.rows.length ? this.classRows(this.loadouts.classes[this.loadouts.active]) : this.rows;
        this.slots = [];
        for (const row of rows) {
            const w = buildWeapon(row);
            if (seen.has(w.name) || this.slots.length >= 9) continue;
            seen.add(w.name);
            if (perk === "steady") w.hipSpread *= 0.65;
            if (perk === "quickhands") w.reload *= 0.7;
            if (perk === "quickdraw") w.adsTime *= 0.7;
            const prev = old.find(s => s.w.name === w.name);
            this.slots.push({ w, mag: prev ? Math.min(prev.mag, w.mag) : w.mag, reserve: prev ? prev.reserve : w.mag * 4 });
        }
    }

    private updatePlayer(dt: number): void {
        const inp = this.input, k = inp.down;
        this.health = this.alive && this.time - this.lastHurt > REGEN_DELAY ? Math.min(100, this.health + REGEN_RATE * dt) : this.health;
        if (!this.alive) {
            this.hv.set(0, 0, 0);
            if (this.respawnAt >= 0 && this.time >= this.respawnAt) this.respawn();
            return;
        }
        const w = this.slot().w;
        if (inp.pressed("KeyX") && this.quickTurn <= 0) this.quickTurn = Math.PI;
        if (this.quickTurn > 0) {
            const st = Math.min(this.quickTurn, dt * Math.PI / 0.18);
            this.yaw += st;
            this.quickTurn -= st;
        }
        const fovK = lerp(1, w.adsFov / 75, this.ads), inv = this.settings.invertY ? -1 : 1;
        if (this.settings.lookMode === "joystick") {
            // The cursor offset from the center steers the view: no button to hold, nothing lost when the cursor leaves.
            const dz = JOY_DEADZONE, curve = (v: number) => { const a = Math.abs(v); return a < dz ? 0 : Math.sign(v) * ((a - dz) / (1 - dz)) ** 2.2; };
            const rate = 2.8 * this.settings.sensitivity / 30 * fovK * lerp(1, 0.7, this.ads);
            this.yaw -= curve(inp.hoverX) * rate * dt;
            this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch - curve(inp.hoverY) * rate * 0.7 * dt * inv));
        } else {
            const sens = (0.0002 + this.settings.sensitivity / 100 * 0.006) * fovK;
            this.yaw -= inp.lookX * sens;
            this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch - inp.lookY * sens * inv));
            if (this.settings.lookMode === "capture" && inp.engaged) {
                // No pointer lock: a cursor parked on the border keeps turning, so it never gets stuck.
                const band = 0.85, edge = (v: number) => (Math.abs(v) > band ? Math.sign(v) * (Math.abs(v) - band) / (1 - band) : 0);
                const rate = 3.6 * this.settings.sensitivity / 45 * fovK;
                this.yaw -= edge(inp.hoverX) * rate * dt;
                this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch - edge(inp.hoverY) * rate * 0.7 * dt * inv));
            }
        }

        const f = (k.has("KeyW") || k.has("ArrowUp") ? 1 : 0) - (k.has("KeyS") || k.has("ArrowDown") ? 1 : 0);
        const s = (k.has("KeyD") || k.has("ArrowRight") ? 1 : 0) - (k.has("KeyA") || k.has("ArrowLeft") ? 1 : 0);
        const moving = f !== 0 || s !== 0;
        const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
        // Wish direction in world space (unit), from the movement keys.
        const len = Math.hypot(f, s) || 1, dx = (-sy * f + cy * s) / len, dz = (-cy * f - sy * s) / len;
        if (!k.has("KeyC")) this.cancelHold = false;
        const crouchKey = k.has("KeyC") && !this.cancelHold;
        const hs0 = Math.hypot(this.hv.x, this.hv.z);

        // Slide (C while running fast) and slide cancel (C again: stand up at once, keep the momentum).
        this.slideCd -= dt;
        if (inp.pressed("KeyC") && this.slideT > 0) {
            this.slideT = 0;
            this.slideCd = 0.25;
            this.slideCancelAt = this.time;
            this.cancelHold = true;
        } else if (inp.pressed("KeyC") && this.onGround && this.slideCd <= 0 && hs0 > SPEED.walk + 0.4) {
            this.slideT = SLIDE_TIME;
            this.slideCd = 0.7;
            this.slideX = this.hv.x / hs0;
            this.slideZ = this.hv.z / hs0;
            this.slideV = Math.max(hs0, SPEED.sprint) * SLIDE_BOOST;
            this.sfx.slide();
        }
        const sliding = this.slideT > 0;
        this.slideBlend += ((sliding ? 1 : 0) - this.slideBlend) * Math.min(1, dt * 10);
        const firing = this.time - this.lastShotAt < 0.3;
        // Omnidirectional sprint: any direction, a bit slower backwards.
        const sprinting = (k.has("ShiftLeft") || k.has("ShiftRight")) && moving && !sliding && !crouchKey && !inp.aim && !k.has("KeyE") && !firing &&
            !k.has("KeyF") && !inp.fireMouse && inp.taps === 0;
        this.sprint = sprinting ? this.sprint + (1 - this.sprint) * Math.min(1, dt * 8) : Math.max(0, this.sprint - dt * 8);
        this.crouch += ((crouchKey || sliding ? 1 : 0) - this.crouch) * Math.min(1, dt * 12);

        if (sliding) {
            this.slideT -= dt;
            this.slideV = Math.max(SPEED.crouch, this.slideV - SLIDE_FRICTION * dt);
            if (moving) {
                // The slide can be steered a little toward the keys (omnidirectional).
                const t = Math.min(1, dt * 2.5);
                this.slideX += (dx - this.slideX) * t;
                this.slideZ += (dz - this.slideZ) * t;
                const n = Math.hypot(this.slideX, this.slideZ) || 1;
                this.slideX /= n;
                this.slideZ /= n;
            }
            this.hv.set(this.slideX * this.slideV, 0, this.slideZ * this.slideV);
        } else {
            const speed = (crouchKey ? SPEED.crouch : sprinting ? SPEED.sprint * (f < 0 ? 0.85 : 1) : this.ads > 0.5 ? SPEED.ads : SPEED.walk) *
                (this.perk() === "light" ? 1.08 : 1);
            const wx = moving ? dx * speed : 0, wz = moving ? dz * speed : 0;
            // Right after a slide cancel the momentum bleeds off slowly.
            const grip = this.time - this.slideCancelAt < 0.45 ? 3 : 14;
            const accel = Math.min(1, dt * (this.onGround ? grip : 2.5));
            this.hv.x += (wx - this.hv.x) * accel;
            this.hv.z += (wz - this.hv.z) * accel;
        }
        this.world.move(this.pos, RADIUS, 1.8 - 0.6 * this.crouch, this.hv.x * dt, this.hv.z * dt);

        if (this.onGround && inp.pressed("Space")) {
            // Jumping out of a slide keeps its speed (the air keeps momentum).
            if (this.slideT > 0) {
                this.slideT = 0;
                this.slideCd = 0.25;
            }
            this.velY = JUMP;
            this.onGround = false;
        }
        this.velY -= GRAVITY * dt;
        this.pos.y += this.velY * dt;
        const g = this.world.groundAt(this.pos.x, this.pos.z, this.pos.y, RADIUS);
        if (this.pos.y <= g) {
            if (!this.onGround && this.velY < -5) this.sfx.step();
            this.pos.y = g;
            this.velY = 0;
            this.onGround = true;
        } else if (this.pos.y > g + 0.02) this.onGround = false;

        const hs = Math.hypot(this.hv.x, this.hv.z);
        if (this.onGround && hs > 1.2) {
            this.stepAcc += hs * dt;
            if (this.stepAcc > (sprinting ? 2.6 : 2.1)) {
                this.stepAcc = 0;
                if (this.crouch < 0.5) this.sfx.step();
            }
        }
    }

    /** Player respawn: out of every live bot's sight, about 24 m (scaled to the map) from the nearest one; else the farthest fixed spawn. */
    private respawn(): void {
        const live = this.bots.filter(x => x.alive), k = this.world.bound / HALF;
        const near = (s: Vec) => live.reduce((m, o) => Math.min(m, Math.hypot(s.x - o.pos.x, s.z - o.pos.z)), Infinity);
        let best: Vec | null = null, bestScore = -Infinity;
        for (const s of this.spawnSpots()) {
            const d = near(s);
            if (d < 14 * k || live.some(o => this.seenFrom(s.x, s.z, { x: o.pos.x, y: 1.55, z: o.pos.z }))) continue;
            const score = (live.length ? -Math.abs(d - 24 * k) : 0) + this.r() * 6;
            if (score > bestScore) { bestScore = score; best = s; }
        }
        if (!best) {
            let far = -1;
            for (const s of this.world.playerSpawns) if (near(s) > far) { far = near(s); best = s; }
        }
        this.place(best);
        this.alive = true;
        this.health = 100;
        this.respawnAt = -1;
        this.draw = 0;
        for (const s of this.slots) s.reserve = Math.max(s.reserve, s.w.mag * 3);
    }

    private hurtPlayer(dmg: number, bot: Bot): void {
        if (!this.alive) return;
        this.health -= dmg;
        this.lastHurt = this.time;
        const dx = bot.pos.x - this.pos.x, dz = bot.pos.z - this.pos.z;
        const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
        this.hud.damage(Math.atan2(dx * cy - dz * sy, -dx * sy - dz * cy));
        this.sfx.hurt();
        if (this.health > 0) return;
        this.health = 0;
        this.alive = false;
        this.diedAt = this.time;
        this.reloadT = -1;
        this.stats.deaths++;
        bot.kills++;
        this.hud.feed(this.time, bot.name, BOT_WEAPON, "YOU", false, false);
        if (this.mode === "duel") {
            this.duel.them++;
            if (this.duel.them >= DUEL_SCORE) this.finishLater("DEFEAT", `${bot.name} TOOK THE DUEL ${this.duel.them} – ${this.duel.you}`, 1.8);
            else this.respawnAt = this.time + 2.5;
        } else if (this.mode === "survival") {
            this.finishLater("KILLED IN ACTION", `YOU HELD UNTIL WAVE ${this.wave.n}`, 1.8);
        }
    }

    // ---------- weapons ----------

    private switchTo(i: number): void {
        if (i === this.cur || i < 0 || i >= this.slots.length) return;
        this.cur = i;
        this.draw = 0;
        this.reloadT = -1;
        this.shotIndex = 0;
        this.latch = true;
        this.vm.setWeapon(this.slots[i].w);
        this.hooks.equip(this.slots[i].w.name);
    }

    private startReload(): void {
        const s = this.slot();
        if (this.reloadT >= 0 || s.mag >= s.w.mag || s.reserve <= 0 || this.draw < 1 || !this.alive) return;
        this.reloadT = 0;
        this.sfx.reload(s.w.reload, s.w.perShell);
    }

    private updateWeapon(dt: number): void {
        const inp = this.input, s = this.slot(), w = s.w;
        for (let i = 0; i < 9; i++) if (inp.pressed(`Digit${i + 1}`) || inp.pressed(`Numpad${i + 1}`)) this.switchTo(i);
        if (inp.wheel) this.switchTo((this.cur + inp.wheel + this.slots.length) % this.slots.length);
        if (this.slot() !== s) return;

        this.draw = Math.min(1, this.draw + dt / 0.35);
        this.cooldown -= dt;
        this.bloom = Math.max(0, this.bloom - dt * (w.auto ? 2.5 : 1.6));
        if (this.time - this.lastShotAt > 0.12) {
            const k = Math.exp(-dt * 5);
            this.recoilP *= k;
            this.recoilY *= k;
        }
        if (this.time - this.lastShotAt > 60 / w.rpm * 2 + 0.05) this.shotIndex = 0;
        if (!this.alive) {
            this.ads = 0;
            return;
        }
        // Linear, per-weapon aim time (no slow exponential tail). Aiming also cuts a sprint at once.
        const canAds = this.draw >= 1 && this.reloadT < 0;
        const adsStep = dt / w.adsTime;
        this.ads = canAds && (inp.aim || inp.down.has("KeyE")) ? Math.min(1, this.ads + adsStep) : Math.max(0, this.ads - adsStep * 1.4);

        if (inp.pressed("KeyR")) this.startReload();
        if (this.reloadT >= 0) {
            this.reloadT += dt;
            if (w.perShell) {
                if (this.reloadT >= w.reload) {
                    s.mag++;
                    s.reserve--;
                    this.reloadT = s.mag >= w.mag || s.reserve <= 0 ? -1 : 0;
                    if (this.reloadT === 0) this.sfx.reload(w.reload, true);
                }
            } else if (this.reloadT >= w.reload) {
                const take = Math.min(w.mag - s.mag, s.reserve);
                s.mag += take;
                s.reserve -= take;
                this.reloadT = -1;
            }
        }

        const trigger = inp.down.has("KeyF") || inp.fireMouse;
        if (!trigger) this.latch = false;
        const wants = (trigger && (w.auto || !this.latch)) || inp.taps > 0;
        if (wants && w.perShell && this.reloadT >= 0 && s.mag > 0) this.reloadT = -1;
        if (!wants || this.draw < 1 || this.reloadT >= 0 || this.sprint > 0.2 || this.cooldown > 0) return;
        this.latch = true;
        if (s.mag <= 0) {
            this.sfx.dry();
            this.cooldown = 0.25;
            this.startReload();
            return;
        }
        this.cooldown = 60 / w.rpm;
        this.fire(s);
    }

    private spreadDeg(w: Weapon): number {
        const moving = Math.min(1.5, Math.hypot(this.hv.x, this.hv.z) / SPEED.walk);
        let s = lerp(w.hipSpread, w.adsSpread, this.ads);
        s += moving * (2.2 - 1.6 * this.ads) * (w.kind === "sniper" && this.ads > 0.5 ? 2.5 : 1);
        if (!this.onGround) s += 4;
        return s * (1 - 0.2 * this.crouch * (1 - this.slideBlend)) + this.bloom + this.slideBlend * 1.5 * (1 - this.ads);
    }

    /** Random direction inside a cone. uniform=false biases toward the center (bot aim error). */
    private cone(dir: Vector3, deg: number, out: Vector3, uniform: boolean): Vector3 {
        const u = this.r(), a = deg * Math.PI / 180 * (uniform ? Math.sqrt(u) : u), th = this.r() * Math.PI * 2;
        const ax = this.vD.crossVectors(dir, Math.abs(dir.y) < 0.99 ? UP : SIDE).normalize();
        const ay = this.vE.crossVectors(dir, ax);
        return out.copy(dir).multiplyScalar(Math.cos(a))
            .addScaledVector(ax, Math.sin(a) * Math.cos(th))
            .addScaledVector(ay, Math.sin(a) * Math.sin(th))
            .normalize();
    }

    /** Nearest hit among world boxes, live bots and raised targets. */
    private trace(o: Vector3, d: Vector3, maxT: number): Trace {
        const tr = this.tr, wh = this.world.raycast(o, d, maxT);
        tr.t = wh ? wh.t : maxT;
        tr.world = !!wh;
        tr.bot = tr.target = null;
        tr.zone = null;
        if (wh) { tr.nx = wh.nx; tr.ny = wh.ny; tr.nz = wh.nz; }
        for (const b of this.bots) {
            if (!b.alive) continue;
            for (const h of b.hitboxes()) {
                const t = rayBox(o.x, o.y, o.z, d.x, d.y, d.z, h.box);
                if (t < tr.t) { tr.t = t; tr.bot = b; tr.target = null; tr.zone = h.zone; tr.world = false; }
            }
        }
        for (const g of this.targets) {
            if (!g.hittable) continue;
            for (const h of g.hitboxes()) {
                const t = rayBox(o.x, o.y, o.z, d.x, d.y, d.z, h.box);
                if (t < tr.t) { tr.t = t; tr.target = g; tr.bot = null; tr.zone = h.zone; tr.world = false; }
            }
        }
        return tr;
    }

    private fire(s: Slot): void {
        const w = s.w;
        s.mag--;
        this.lastShotAt = this.time;
        this.stats.shots++;
        const spray = w.auto && this.shotIndex >= 4;
        if (spray) this.stats.sprayShots++;

        this.updateCamera(0);
        this.camera.updateMatrixWorld();
        const origin = this.camera.position, fwd = this.camera.getWorldDirection(this.vA);
        const right = this.vB.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
        const muzzle = this.vC.copy(origin).addScaledVector(fwd, 0.6).addScaledVector(right, 0.14 * (1 - this.ads)).addScaledVector(UP, -0.1 * (1 - this.ads));
        const spread = this.spreadDeg(w), dir = new Vector3(), end = new Vector3();
        let hit = false, head = false, kill = false;
        for (let p = 0; p < w.pellets; p++) {
            this.cone(fwd, spread, dir, true);
            const h = this.trace(origin, dir, 250);
            end.copy(origin).addScaledVector(dir, h.t);
            if (p < 4) this.fx.tracer(muzzle, end, [1, 0.8, 0.5]);
            if (h.bot) {
                hit = true;
                head ||= h.zone === "head";
                this.fx.impact(end, -dir.x, -dir.y, -dir.z, BLOOD, 5, false);
                if (h.bot.damage(hitDamage(w, h.zone, h.bot.armored, rangeMultiplier(w, h.t)), this.time, this.claimed)) {
                    kill = true;
                    this.onBotKilled(h.bot, h.zone === "head", w);
                }
            } else if (h.target) {
                hit = true;
                head ||= h.zone === "head";
                kill = true;
                this.fx.impact(end, -dir.x, -dir.y, -dir.z, SPARK, 8, false);
                h.target.drop(this.time);
                this.stats.kills++;
                this.hud.feed(this.time, "YOU", w.name, `TARGET ${h.target.label}`, h.zone === "head", true, `REACT ${this.recordTtk(this.time - h.target.raisedAt)}`);
            } else if (h.world) {
                this.fx.impact(end, h.nx, h.ny, h.nz, DUST, 7, true);
            }
        }
        if (hit) {
            this.stats.hits++;
            if (head) this.stats.heads++;
            if (spray) this.stats.sprayHits++;
            this.hud.hitmarker(head, kill);
            this.sfx.hit(head);
        }
        const [kp, ky] = w.pattern[Math.min(this.shotIndex, w.pattern.length - 1)];
        const m = (1 - 0.25 * this.ads) * (1 - 0.15 * this.crouch) * Math.PI / 180;
        this.recoilP += kp * m;
        this.recoilY += ky * m;
        this.shotIndex++;
        this.bloom = Math.min(4, this.bloom + (w.auto ? 0.1 : 0.45));
        this.vm.fire(w.recoil / 10, this.r());
        this.sfx.shot(w.kind);
        if (w.kind === "shotgun" || w.kind === "sniper") this.sfx.pump(w.kind === "sniper");
        this.muzzleLight.position.copy(muzzle);
        this.muzzleLight.intensity = 6;
    }

    private onBotKilled(bot: Bot, head: boolean, w: Weapon): void {
        this.stats.kills++;
        this.hud.feed(this.time, "YOU", w.name, bot.name, head, true, `TTK ${this.recordTtk(this.time - bot.firstHit)}`);
        this.sfx.kill();
        if (this.mode === "duel") {
            this.duel.you++;
            if (this.duel.you >= DUEL_SCORE) this.finishLater("VICTORY", `YOU WON THE DUEL ${this.duel.you} – ${this.duel.them}`, 1.2);
            else bot.respawnAt = this.time + 2.2;
        }
    }

    /** Records a time-to-kill in seconds and returns it formatted. A one-shot kill is 0 ms. */
    private recordTtk(sec: number): string {
        const ms = Math.max(0, Math.round(sec * 1000)), s = this.stats;
        s.ttkSum += ms;
        s.ttkN++;
        if (s.ttkBest === 0 || ms < s.ttkBest) s.ttkBest = Math.max(1, ms);
        return `${ms} MS`;
    }

    private botShoot(bot: Bot, from: Vector3, muzzle: Vector3, errorMult: number): void {
        this.botShots++;
        const eyeH = lerp(EYE, CROUCH_EYE, this.crouch);
        const aim = this.vA.set(this.pos.x, this.pos.y + eyeH - 0.45, this.pos.z);
        const base = this.vB.subVectors(aim, from).normalize();
        const moving = Math.hypot(this.hv.x, this.hv.z);
        const err = (4.6 - 4.1 * this.botCtx.skill) * errorMult * (1 + moving / 7) * (1 - 0.15 * this.crouch);
        const dir = this.cone(base, err, this.vC, false);
        const wh = this.world.raycast(from, dir, 150), wt = wh ? wh.t : 150;
        const pb = this.playerBox;
        pb.minX = this.pos.x - 0.35; pb.maxX = this.pos.x + 0.35; pb.minZ = this.pos.z - 0.35; pb.maxZ = this.pos.z + 0.35;
        pb.minY = this.pos.y; pb.maxY = this.pos.y + eyeH + 0.15;
        const pt = this.alive ? rayBox(from.x, from.y, from.z, dir.x, dir.y, dir.z, pb) : Infinity;
        const end = this.vD.copy(from).addScaledVector(dir, Math.min(pt, wt));
        this.fx.tracer(muzzle, end, [0.85, 0.45, 0.2]);
        const dx = from.x - this.pos.x, dz = from.z - this.pos.z, d = Math.hypot(dx, dz) || 1;
        this.sfx.shot("bot", d, (dx * Math.cos(this.yaw) - dz * Math.sin(this.yaw)) / d);
        if (pt < wt) {
            const scale = this.mode === "survival" ? 1 + 0.05 * Math.max(0, this.wave.n - 1) : 1;
            this.hurtPlayer(BOT_DAMAGE[this.settings.difficulty] * scale, bot);
        } else if (wh) this.fx.impact(end, wh.nx, wh.ny, wh.nz, DUST, 4, true);
    }

    // ---------- modes ----------

    private updateRange(dt: number): void {
        this.roundTime -= dt;
        const elapsed = RANGE_TIME - this.roundTime;
        let up = 0;
        for (const t of this.targets) {
            if (t.update(dt, this.time)) this.stats.missed++;
            if (t.raised) up++;
        }
        if (up < 2 + Math.floor(elapsed / 20)) {
            const ready = this.targets.filter(t => !t.raised && this.time - t.downAt > 1.5);
            if (ready.length) {
                const t = ready[Math.floor(this.r() * ready.length)];
                t.raise(lerp(3.4, 1.8, Math.min(1, elapsed / RANGE_TIME)));
                t.raisedAt = this.time;
            }
        }
        if (this.roundTime <= 0) {
            this.roundTime = 0;
            this.finishLater("RANGE COMPLETE", `${this.stats.kills} TARGETS DOWN  ·  ${this.stats.missed} MISSED`, 0);
        }
    }

    private updateDuel(): void {
        const b = this.bots[0];
        if (b && !b.alive && b.respawnAt >= 0 && this.time >= b.respawnAt && this.endAt < 0) this.spawnBot(b);
        if (DUEL_TIME - this.time <= 0 && this.endAt < 0) {
            const { you, them } = this.duel;
            this.finishLater(you > them ? "VICTORY" : you < them ? "DEFEAT" : "DRAW", `TIME  ·  ${you} – ${them}`, 0);
        }
        this.roundTime = Math.max(0, DUEL_TIME - this.time);
    }

    private updateSurvival(dt: number): void {
        const W = this.wave;
        if (this.alive) this.roundTime += dt;
        for (let i = this.bots.length - 1; i >= 0; i--) {
            const b = this.bots[i];
            if (!b.alive && !b.group.visible) {
                this.scene.remove(b.group);
                b.dispose();
                this.bots.splice(i, 1);
            }
        }
        if (this.endAt >= 0) return;
        if (W.breakT > 0) {
            W.breakT -= dt;
            if (W.breakT <= 0) {
                W.n++;
                W.queue = 2 + W.n * 2;
                W.cap = Math.min(8, 2 + W.n);
                W.spawnT = 0;
                // The next wave comes from another side (90 to 270 degrees away).
                if (W.n > 1) W.front += Math.PI * (0.5 + this.r());
                // Each wave aims better and pushes harder.
                this.botCtx.skill = Math.min(0.97, SKILL[this.settings.difficulty] + (W.n - 1) * 0.05);
                this.botCtx.rush = Math.min(0.7, RUSH[this.settings.difficulty] + (W.n - 1) * 0.05);
                this.hud.showBanner(`WAVE ${W.n}`);
                this.sfx.horn();
            }
            return;
        }
        const alive = this.bots.filter(b => b.alive).length;
        W.spawnT -= dt;
        if (W.queue > 0 && alive < W.cap && W.spawnT <= 0) {
            this.spawnBot(this.addBot());
            W.queue--;
            W.spawnT = 0.9;
        }
        if (W.queue === 0 && alive === 0) {
            this.hud.showBanner(`WAVE ${W.n} CLEARED  ·  RESUPPLIED`);
            W.breakT = 6;
            this.health = 100;
            for (const s of this.slots) s.reserve = Math.max(s.reserve, s.w.mag * 4);
        }
    }

    // ---------- presentation ----------

    private updateCamera(dt: number): void {
        const cam = this.camera;
        const dead = this.state === "play" && !this.alive;
        const deathK = dead ? Math.min(1, (this.time - this.diedAt) / 0.6) : 0;
        const eyeH = lerp(lerp(EYE, CROUCH_EYE, this.crouch), 0.35, deathK);
        cam.position.set(this.pos.x, this.pos.y + eyeH, this.pos.z);
        cam.rotation.set(this.pitch + this.recoilP, this.yaw + this.recoilY, deathK * 0.5 + this.slideBlend * 0.06, "YXZ");
        const w = this.slot().w;
        const fov = this.settings.fov * lerp(1, w.adsFov / 75, this.state === "play" ? this.ads : 0) * (1 + 0.1 * this.slideBlend);
        if (Math.abs(cam.fov - fov) > 0.01) {
            cam.fov = fov;
            cam.updateProjectionMatrix();
        }
        this.muzzleLight.intensity *= Math.exp(-dt * 30);
    }

    private render(): void {
        const r = this.renderer, w = this.slot().w;
        const scoped = this.state === "play" && this.alive && w.scope && this.ads > 0.92;
        this.vm.update(this.paused ? 0 : 1 / 60, {
            t: this.clock, move: this.onGround ? Math.min(1, Math.hypot(this.hv.x, this.hv.z) / SPEED.walk) : 0, ads: this.ads * this.ads * (3 - 2 * this.ads),
            sprint: this.sprint, slide: this.slideBlend, lookDX: this.input.lookX, lookDY: this.input.lookY,
            reload: this.reloadT >= 0 ? Math.min(1, this.reloadT / w.reload) : -1, draw: this.draw,
            hidden: this.state !== "play" || !this.alive || scoped,
        });
        r.info.reset();
        r.clear();
        r.render(this.scene, this.camera);
        r.clearDepth();
        r.render(this.vm.scene, this.vm.camera);
        if (this.state === "play") this.hud.scoped(scoped);
    }

    private updatePlayHud(): void {
        this.hud.joystick(this.settings.lookMode === "joystick" && this.alive);
        const h = this.hud, s = this.stats, slot = this.slot(), w = slot.w;
        h.stats(s.kills, pct(s.hits, s.shots), pct(s.heads, s.hits), this.mode === "range" ? "TARGETS" : "KILLS",
            s.ttkN ? `${Math.round(s.ttkSum / s.ttkN)} ms` : "—", this.mode === "range" ? "AVG REACT" : "AVG TTK");
        if (this.mode === "range") {
            h.timer("AIM RANGE", fmtTime(Math.max(0, this.roundTime)), `MISSED ${s.missed}`, this.roundTime < 10);
        } else if (this.mode === "duel") {
            const b = this.bots[0];
            h.timer("BOT DUEL", fmtTime(this.roundTime), `YOU ${this.duel.you}  —  ${this.duel.them} ${b ? b.name : ""}`, this.roundTime < 15);
        } else {
            const W = this.wave, left = W.queue + this.bots.filter(b => b.alive).length;
            h.timer(`SURVIVAL  ·  WAVE ${W.n}`, fmtTime(this.roundTime), W.breakT > 0 ? `NEXT WAVE IN ${Math.ceil(W.breakT)}` : `${left} HOSTILES LEFT`, false);
        }
        const spread = this.spreadDeg(w) * Math.PI / 180, half = this.camera.fov * Math.PI / 360;
        const showCross = this.alive && this.sprint < 0.5 && (this.ads < 0.6 || w.kind === "shotgun");
        h.crosshair(Math.tan(spread) / Math.tan(half) * this.height / 2, showCross);
        h.weaponBar(this.slots.map(x => x.w.name), this.cur);
        h.ammo(slot.mag, w.mag, slot.reserve, w.name, w.cls, this.reloadT >= 0 ? (w.perShell ? slot.mag / w.mag : this.reloadT / w.reload) : -1);
        h.health(this.health);
        h.setPrompt(!this.alive ? (this.respawnAt >= 0 ? "RESPAWNING" : "")
            : slot.mag === 0 && slot.reserve > 0 && this.reloadT < 0 ? "[R] RELOAD"
                : slot.mag === 0 && slot.reserve === 0 ? "OUT OF AMMO  ·  SWITCH WEAPON"
                    : this.settings.lookMode === "capture" && !this.input.engaged ? "CLICK TO CAPTURE THE MOUSE" : "");
        const pings: Ping[] = [];
        for (const b of this.bots) {
            if (!b.alive) continue;
            const since = this.time - b.lastShot;
            const near = Math.hypot(b.pos.x - this.pos.x, b.pos.z - this.pos.z) < 7;
            if (since < 2 || near) pings.push({ x: b.pos.x, z: b.pos.z, a: near ? 0.8 : 1 - since / 2, color: "#e2483a" });
        }
        for (const t of this.targets) if (t.raised) pings.push({ x: t.pos.x, z: t.pos.z, a: 0.9, color: "#ff7a1a" });
        h.minimap(this.world.minimap, 4, HALF, this.pos.x, this.pos.z, this.yaw, pings);
    }

    private renderBoard(): void {
        const s = this.stats, me = { cells: ["YOU", String(s.kills), String(s.deaths), `${pct(s.hits, s.shots).toFixed(0)}%`, `${pct(s.heads, s.hits).toFixed(0)}%`], me: true };
        if (this.mode === "range") {
            this.hud.scoreboard(true, ["PLAYER", "TARGETS", "MISSED", "ACCURACY", "HEADSHOT"],
                [{ cells: ["YOU", String(s.kills), String(s.missed), me.cells[3], me.cells[4]], me: true }]);
            return;
        }
        const rows = [me, ...this.bots.slice(0, 8).map(b => ({ cells: [b.name, String(b.kills), String(b.deaths), b.alive ? b.state.toUpperCase() : "DOWN", ""], me: false }))];
        this.hud.scoreboard(true, ["PLAYER", "KILLS", "DEATHS", "ACC / STATE", "HEADSHOT"], rows);
    }

    private applyQuality(): void {
        const high = this.settings.quality === "high";
        this.renderer.setPixelRatio(high ? Math.min(window.devicePixelRatio || 1, 1.5) : 1);
        this.renderer.shadowMap.enabled = high;
        this.world.sun.castShadow = high;
        this.scene.traverse(o => {
            const m = (o as Mesh).material;
            if (m) (Array.isArray(m) ? m : [m]).forEach(x => { x.needsUpdate = true; });
        });
        this.resize(this.width, this.height);
    }

    // ---------- diagnostics (sandbox probes run inside the real host) ----------

    private probeStatic(): void {
        this.probes.ORIGIN = window.origin;
        try {
            this.probes.STORAGE = window.localStorage ? "OK" : "NONE";
        } catch {
            this.probes.STORAGE = "BLOCKED";
        }
        const gl = this.renderer.getContext();
        const ext = gl.getExtension("WEBGL_debug_renderer_info");
        this.probes.GL = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER)).slice(0, 48);
        this.probes.POINTERLOCK = "CLICK TO TEST";
    }

    private probePointerLock(): void {
        this.lockProbed = true;
        const done = (v: string) => {
            this.probes.POINTERLOCK = v;
            if (document.pointerLockElement) document.exitPointerLock();
        };
        document.addEventListener("pointerlockchange", () => done("OK"), { once: true });
        document.addEventListener("pointerlockerror", () => done("BLOCKED"), { once: true });
        try {
            const p = this.renderer.domElement.requestPointerLock() as unknown as Promise<void> | undefined;
            p?.catch(() => done("BLOCKED"));
        } catch {
            done("BLOCKED");
        }
    }

    private updateDiag(t: number, dt: number): void {
        this.fpsN++;
        if (t - this.fpsT < 500) return;
        this.fps = this.fpsN * 1000 / (t - this.fpsT);
        this.fpsT = t;
        this.fpsN = 0;
        this.root.dataset.yaw = this.yaw.toFixed(3); // read by the host-side tests
        if (!this.settings.diagnostics) return;
        const info = this.renderer.info.render;
        this.probes.AUDIO = this.sfx.state.toUpperCase();
        this.hud.diag.textContent = [`FPS ${this.fps.toFixed(0)}`, `CALLS ${info.calls}`, `TRIS ${info.triangles}`, `DT ${(dt * 1000).toFixed(1)}`,
            ...Object.entries(this.probes).map(([k, v]) => `${k} ${v}`)].join("\n");
    }
}
