// Pure game rules: no three.js, no DOM. Imported by the visual and by test/rules.test.ts (Node).
// The DAX columns of the "Arsenal" page mirror RULES, hitDamage and the shots-to-kill math below.

export type Rng = () => number;

// mulberry32: tiny seeded PRNG (Math.random is rejected by the Power BI linter).
export function rng(seed: number): Rng {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// FNV-1a string hash, used to seed per-weapon recoil patterns.
export function hash(s: string): number {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return h >>> 0;
}

export const RULES = {
    hp: 100,
    headMult: 2,
    legMult: 0.75,
    helmet: 0.5,   // share of head damage a helmet stops at 0 % armor pen
    vest: 0.35,    // share of torso damage a vest stops at 0 % armor pen
};

export type Zone = "head" | "torso" | "legs";

/** One row of the "Weapons" table. pen is 0..1. */
export interface WeaponRow {
    name: string;
    cls: string;
    damage: number;
    rpm: number;
    mag: number;
    pen: number;
    recoil: number;
}

export interface Weapon extends WeaponRow {
    kind: Kind;
    pellets: number;
    auto: boolean;
    reload: number;        // seconds (per shell when perShell)
    perShell: boolean;
    hipSpread: number;     // degrees
    adsSpread: number;
    adsFov: number;
    adsTime: number;       // seconds from hip to full aim
    scope: boolean;
    falloff: [number, number, number]; // full damage until [0] m, [2] multiplier from [1] m
    pattern: [number, number][];       // per-shot [pitch, yaw] kick in degrees
}

export const DEFAULT_ROSTER: WeaponRow[] = [
    { name: "R-7 Carbine", cls: "Assault", damage: 30, rpm: 720, mag: 30, pen: 0.45, recoil: 5 },
    { name: "Kestrel AR", cls: "Assault", damage: 34, rpm: 600, mag: 30, pen: 0.55, recoil: 7 },
    { name: "Hawk SMG", cls: "SMG", damage: 22, rpm: 900, mag: 32, pen: 0.25, recoil: 3 },
    { name: "Moth PDW", cls: "SMG", damage: 19, rpm: 1000, mag: 40, pen: 0.3, recoil: 4 },
    { name: "Longshot", cls: "Sniper", damage: 95, rpm: 45, mag: 5, pen: 0.9, recoil: 9 },
    { name: "Talon DMR", cls: "Marksman", damage: 58, rpm: 240, mag: 10, pen: 0.75, recoil: 6 },
    { name: "Ward-9", cls: "Pistol", damage: 26, rpm: 400, mag: 12, pen: 0.2, recoil: 2 },
    { name: "Brute", cls: "Shotgun", damage: 14, rpm: 70, mag: 6, pen: 0.1, recoil: 8 },
];

export type Kind = "assault" | "smg" | "sniper" | "marksman" | "pistol" | "shotgun";

type Profile = Pick<Weapon, "pellets" | "auto" | "reload" | "perShell" | "hipSpread" | "adsSpread" | "adsFov" | "adsTime" | "scope" | "falloff">;

const PROFILES: Record<Kind, Profile> = {
    assault: { pellets: 1, auto: true, reload: 2.2, perShell: false, hipSpread: 2.6, adsSpread: 0.3, adsFov: 52, adsTime: 0.16, scope: false, falloff: [30, 60, 0.8] },
    smg: { pellets: 1, auto: true, reload: 1.9, perShell: false, hipSpread: 2.2, adsSpread: 0.6, adsFov: 56, adsTime: 0.13, scope: false, falloff: [12, 30, 0.65] },
    sniper: { pellets: 1, auto: false, reload: 3.0, perShell: false, hipSpread: 7, adsSpread: 0, adsFov: 16, adsTime: 0.26, scope: true, falloff: [999, 1000, 1] },
    marksman: { pellets: 1, auto: false, reload: 2.4, perShell: false, hipSpread: 3.5, adsSpread: 0.12, adsFov: 34, adsTime: 0.2, scope: false, falloff: [60, 100, 0.9] },
    pistol: { pellets: 1, auto: false, reload: 1.4, perShell: false, hipSpread: 1.8, adsSpread: 0.45, adsFov: 60, adsTime: 0.11, scope: false, falloff: [15, 35, 0.7] },
    shotgun: { pellets: 9, auto: false, reload: 0.5, perShell: true, hipSpread: 4.5, adsSpread: 3.2, adsFov: 62, adsTime: 0.15, scope: false, falloff: [8, 20, 0.3] },
};

/** Maps a free-text Class value to a behaviour profile; unknown classes play like an assault rifle. */
export function kindOf(cls: string): Kind {
    const c = cls.toLowerCase();
    if (c.includes("sniper")) return "sniper";
    if (c.includes("smg") || c.includes("sub") || c.includes("pdw")) return "smg";
    if (c.includes("shot")) return "shotgun";
    if (c.includes("pistol") || c.includes("handgun") || c.includes("sidearm")) return "pistol";
    if (c.includes("marks") || c.includes("dmr")) return "marksman";
    return "assault";
}

/** Clamps a raw data row into playable ranges. pen accepts 0..1 or 0..100. */
export function sanitize(r: WeaponRow): WeaponRow {
    const n = (v: number, lo: number, hi: number, d: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
    const pen = Number.isFinite(r.pen) && r.pen > 1 ? r.pen / 100 : r.pen;
    return {
        name: (r.name || "Unnamed").slice(0, 24),
        cls: (r.cls || "Assault").slice(0, 16),
        damage: n(r.damage, 1, 500, 30),
        rpm: n(r.rpm, 20, 1500, 600),
        mag: Math.round(n(r.mag, 1, 200, 30)),
        pen: n(pen, 0, 1, 0.3),
        recoil: n(r.recoil, 0, 10, 5),
    };
}

export function buildWeapon(row: WeaponRow): Weapon {
    const r = sanitize(row);
    const kind = kindOf(r.cls);
    return { ...r, kind, ...PROFILES[kind], pattern: recoilPattern(r.name, r.recoil) };
}

/** Deterministic, learnable spray pattern: vertical climb first, then a seeded horizontal sway. */
export function recoilPattern(name: string, recoil: number): [number, number][] {
    const r = rng(hash(name));
    const base = 0.1 + recoil * 0.07;
    const phase = r() * Math.PI * 2;
    const sway = 0.5 + r() * 0.6;
    const drift = r() < 0.5 ? -1 : 1;
    const out: [number, number][] = [];
    for (let i = 0; i < 40; i++) {
        const climb = base * (i < 8 ? 0.7 + i * 0.06 : 0.9);
        const yaw = i < 6 ? base * drift * 0.2 * (r() - 0.3) : base * sway * Math.sin(i * 0.45 + phase);
        out.push([climb, yaw]);
    }
    return out;
}

export function rangeMultiplier(w: Weapon, dist: number): number {
    const [r0, r1, min] = w.falloff;
    if (dist <= r0) return 1;
    if (dist >= r1) return min;
    return 1 - (1 - min) * (dist - r0) / (r1 - r0);
}

/** Damage of ONE projectile (pellet) on a zone, after armor. */
export function hitDamage(w: Pick<WeaponRow, "damage" | "pen">, zone: Zone, armored: boolean, rangeMult = 1): number {
    const mult = zone === "head" ? RULES.headMult : zone === "legs" ? RULES.legMult : 1;
    const armor = !armored ? 0 : zone === "head" ? RULES.helmet : zone === "torso" ? RULES.vest : 0;
    return w.damage * mult * rangeMult * (1 - armor * (1 - w.pen));
}

/** Same numbers as the DAX columns: every pellet lands, no range falloff, armored target. */
export function arsenalStats(row: WeaponRow): { shotsToKill: number; ttkMs: number; dps: number; helmetOneShot: boolean } {
    const w = buildWeapon(row);
    const body = hitDamage(w, "torso", true) * w.pellets;
    const shotsToKill = Math.ceil(RULES.hp / body);
    return {
        shotsToKill,
        ttkMs: Math.round((shotsToKill - 1) * 60000 / w.rpm),
        dps: Math.round(w.damage * w.pellets * w.rpm / 60),
        helmetOneShot: hitDamage(w, "head", true) * w.pellets >= RULES.hp,
    };
}
