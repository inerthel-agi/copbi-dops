"use strict";

import powerbi from "powerbi-visuals-api";
import "./../style/visual.less";
import { DEFAULT_SETTINGS, Difficulty, EMPTY_RECORDS, Game, Loadouts, Records, sanitizeLoadouts, Settings } from "./game";
import { sanitize, WeaponRow } from "./rules";

import IVisual = powerbi.extensibility.visual.IVisual;
import IVisualHost = powerbi.extensibility.visual.IVisualHost;
import VisualConstructorOptions = powerbi.extensibility.visual.VisualConstructorOptions;
import VisualUpdateOptions = powerbi.extensibility.visual.VisualUpdateOptions;
import ISelectionManager = powerbi.extensibility.ISelectionManager;
import ISelectionId = powerbi.visuals.ISelectionId;
import DataView = powerbi.DataView;
import DataViewObjects = powerbi.DataViewObjects;
import FormattingModel = powerbi.visuals.FormattingModel;
import FormattingSlice = powerbi.visuals.FormattingSlice;
import IEnumMember = powerbi.IEnumMember;

const DIFFICULTIES: IEnumMember[] = [{ value: "easy", displayName: "Easy" }, { value: "normal", displayName: "Normal" }, { value: "hard", displayName: "Hard" }, { value: "veteran", displayName: "Veteran" }];
const LOOK_MODES: IEnumMember[] = [{ value: "capture", displayName: "Capture (click, cursor hidden)" }, { value: "drag", displayName: "Drag (hold left button)" }, { value: "joystick", displayName: "Joystick (cursor offset, no button)" }];
const QUALITIES: IEnumMember[] = [{ value: "high", displayName: "High (shadows)" }, { value: "low", displayName: "Low (no shadows)" }];
const RECORD_FIELDS: [keyof Records, string][] = [
    ["rangeKills", "Aim Range targets"], ["duelKills", "Domination kills"], ["survivalWave", "Zombies round"],
    ["accuracy", "Accuracy %"], ["spray", "Spray score"], ["bestTtk", "Best TTK (ms)"],
];

function prop(o: DataViewObjects | undefined, obj: string, name: string): unknown {
    return o?.[obj]?.[name];
}

function num(o: DataViewObjects | undefined, obj: string, name: string, def: number, lo: number, hi: number): number {
    const v = Number(prop(o, obj, name) ?? def);
    return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def;
}

function readSettings(o: DataViewObjects | undefined): Settings {
    const d = DEFAULT_SETTINGS;
    const diff = String(prop(o, "gameplay", "difficulty") ?? d.difficulty);
    return {
        sensitivity: num(o, "gameplay", "sensitivity", d.sensitivity, 1, 100),
        invertY: Boolean(prop(o, "gameplay", "invertY") ?? d.invertY),
        fov: num(o, "gameplay", "fov", d.fov, 60, 100),
        difficulty: (DIFFICULTIES.some(e => e.value === diff) ? diff : d.difficulty) as Difficulty,
        volume: num(o, "gameplay", "volume", d.volume, 0, 100),
        lookMode: ["drag", "joystick"].includes(String(prop(o, "gameplay", "lookMode"))) ? (prop(o, "gameplay", "lookMode") as "drag" | "joystick") : "capture",
        pauseOnBlur: Boolean(prop(o, "gameplay", "pauseOnBlur") ?? d.pauseOnBlur),
        quality: prop(o, "display", "quality") === "low" ? "low" : "high",
        diagnostics: Boolean(prop(o, "display", "diagnostics") ?? d.diagnostics),
    };
}

function readRecords(o: DataViewObjects | undefined): Records {
    const r = { ...EMPTY_RECORDS };
    for (const [k] of RECORD_FIELDS) r[k] = num(o, "records", k, 0, 0, 1e6);
    return r;
}

function readLoadouts(o: DataViewObjects | undefined): Loadouts {
    try {
        return sanitizeLoadouts(JSON.parse(String(prop(o, "loadouts", "data") ?? "null")));
    } catch {
        return sanitizeLoadouts(null);
    }
}

export class Visual implements IVisual {
    private host: IVisualHost;
    private selection: ISelectionManager;
    private game: Game;
    private ids = new Map<string, ISelectionId>();
    private loadoutSig = "";
    private recordsSig = "";
    private loadoutsSig = "";
    private settings: Settings = { ...DEFAULT_SETTINGS };
    private records: Records = { ...EMPTY_RECORDS };

    constructor(options: VisualConstructorOptions) {
        this.host = options.host;
        this.selection = this.host.createSelectionManager();
        this.game = new Game(options.element, {
            equip: name => this.equip(name),
            records: r => this.persist(r),
            difficulty: d => this.host.persistProperties({ merge: [{ objectName: "gameplay", selector: null, properties: { difficulty: d } }] }),
            loadouts: l => {
                // Remember our own write so its echo through update() is ignored.
                this.loadoutsSig = JSON.stringify(l);
                this.host.persistProperties({ merge: [{ objectName: "loadouts", selector: null, properties: { data: this.loadoutsSig } }] });
            },
        });
    }

    public update(options: VisualUpdateOptions): void {
        const dv = options.dataViews?.[0];
        const objects = dv?.metadata?.objects;
        this.settings = readSettings(objects);
        this.game.setSettings(this.settings);

        // Only forward records the host actually changed (format pane edit, first load). Echoes of
        // our own persistProperties call arrive later and must not roll back a fresher best score.
        const rec = readRecords(objects), recSig = JSON.stringify(rec);
        if (recSig !== this.recordsSig) {
            this.recordsSig = recSig;
            this.records = rec;
            this.game.setRecords(rec);
        }

        const lo = readLoadouts(objects), loSig = JSON.stringify(lo);
        if (loSig !== this.loadoutsSig) {
            this.loadoutsSig = loSig;
            this.game.setLoadouts(lo);
        }

        const { rows, bound } = this.readRows(dv);
        const sig = JSON.stringify([bound, rows]);
        if (sig !== this.loadoutSig) {
            this.loadoutSig = sig;
            this.game.setLoadout(rows, bound);
        }
        this.game.resize(options.viewport.width, options.viewport.height);
    }

    public destroy(): void {
        this.game.dispose();
    }

    /** Weapons table rows; selection IDs come from the Weapon category so other visuals cross-filter. */
    private readRows(dv: DataView | undefined): { rows: WeaponRow[]; bound: boolean } {
        this.ids.clear();
        const cat = dv?.categorical, cats = cat?.categories ?? [];
        const weaponCol = cats.find(c => c.source.roles?.weapon);
        if (!weaponCol) return { rows: [], bound: false };
        const clsCol = cats.find(c => c.source.roles?.cls);
        const values: powerbi.DataViewValueColumn[] = cat.values ?? [];
        const measure = (role: string, i: number) => {
            const v = values.find(c => c.source.roles?.[role])?.values[i];
            return v === null || v === undefined ? NaN : Number(v);
        };
        const rows: WeaponRow[] = [];
        weaponCol.values.forEach((v, i) => {
            if (v === null || v === undefined) return;
            const row = sanitize({
                name: String(v), cls: clsCol ? String(clsCol.values[i] ?? "") : "Assault",
                damage: measure("damage", i), rpm: measure("rpm", i), mag: measure("mag", i), pen: measure("pen", i), recoil: measure("recoil", i),
            });
            rows.push(row);
            this.ids.set(row.name, this.host.createSelectionIdBuilder().withCategory(weaponCol, i).createSelectionId());
        });
        return { rows, bound: true };
    }

    private equip(name: string | null): void {
        if (this.host.hostCapabilities?.allowInteractions === false) return;
        const id = name ? this.ids.get(name) : undefined;
        if (id) void this.selection.select(id);
        else if (this.selection.hasSelection()) void this.selection.clear();
    }

    private persist(r: Records): void {
        this.records = r;
        this.host.persistProperties({ merge: [{ objectName: "records", selector: null, properties: { ...r } }] });
    }

    public getFormattingModel(): FormattingModel {
        const s = this.settings;
        const range = (obj: string, name: string, displayName: string, value: number, min: number, max: number): FormattingSlice => ({
            uid: `${obj}_${name}`, displayName,
            control: {
                type: "Slider", properties: {
                    descriptor: { objectName: obj, propertyName: name }, value,
                    options: { minValue: { type: powerbi.visuals.ValidatorType.Min, value: min }, maxValue: { type: powerbi.visuals.ValidatorType.Max, value: max } },
                },
            },
        });
        const toggle = (obj: string, name: string, displayName: string, value: boolean): FormattingSlice => ({
            uid: `${obj}_${name}`, displayName,
            control: { type: "ToggleSwitch", properties: { descriptor: { objectName: obj, propertyName: name }, value } },
        });
        const pick = (obj: string, name: string, displayName: string, items: IEnumMember[], value: string): FormattingSlice => ({
            uid: `${obj}_${name}`, displayName,
            control: { type: "Dropdown", properties: { descriptor: { objectName: obj, propertyName: name }, items, value: items.find(i => i.value === value) ?? items[0] } },
        });
        const number = (name: keyof Records, displayName: string): FormattingSlice => ({
            uid: `records_${name}`, displayName,
            control: { type: "NumUpDown", properties: { descriptor: { objectName: "records", propertyName: name }, value: this.records[name] } },
        });
        return {
            cards: [
                {
                    uid: "gameplay_card", displayName: "Gameplay",
                    groups: [{
                        uid: "gameplay_group", displayName: "Gameplay", slices: [
                            range("gameplay", "sensitivity", "Look sensitivity", s.sensitivity, 1, 100),
                            toggle("gameplay", "invertY", "Invert vertical look", s.invertY),
                            range("gameplay", "fov", "Field of view", s.fov, 60, 100),
                            pick("gameplay", "difficulty", "Bot difficulty", DIFFICULTIES, s.difficulty),
                            pick("gameplay", "lookMode", "Look mode", LOOK_MODES, s.lookMode),
                            toggle("gameplay", "pauseOnBlur", "Pause when the visual loses focus", s.pauseOnBlur),
                            range("gameplay", "volume", "Volume", s.volume, 0, 100),
                        ],
                    }],
                },
                {
                    uid: "display_card", displayName: "Display",
                    groups: [{
                        uid: "display_group", displayName: "Display", slices: [
                            pick("display", "quality", "Graphics quality", QUALITIES, s.quality),
                            toggle("display", "diagnostics", "Diagnostics overlay", s.diagnostics),
                        ],
                    }],
                },
                {
                    uid: "records_card", displayName: "Best scores",
                    groups: [{ uid: "records_group", displayName: "Best scores (set to 0 to reset)", slices: RECORD_FIELDS.map(([k, n]) => number(k, n)) }],
                },
            ],
        };
    }
}
