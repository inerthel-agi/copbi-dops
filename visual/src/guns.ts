// Procedural first-person weapon models. Parts are side profiles extruded across the gun (receivers,
// stocks, grips, curved magazines), bodies of revolution along the bore (barrels, muzzle devices,
// scopes), plates with holes (reflex sight frames) and capsule segments (gloved hands, sleeves).
// Coordinates: x = right, y = up, u = forward (stored as -z). Origin = the sight line, so ADS only
// needs to center the rig.
import {
    BoxGeometry, CapsuleGeometry, CylinderGeometry, ExtrudeGeometry, Group, LatheGeometry, Material, Mesh,
    MeshBasicMaterial, MeshPhysicalMaterial, MeshStandardMaterial, Object3D, Path, PlaneGeometry, Quaternion, Shape,
    SphereGeometry, Vector2, Vector3
} from "three";
import { Kind } from "./rules";

export type V3 = [number, number, number];
export interface GunModel { muzzle: V3; hip: V3; adsZ: number; pump?: Object3D; }
type P = [number, number]; // side view point: [u forward, y up]

const M = {
    alu: new MeshStandardMaterial({ color: 0x2a2c2b, metalness: 0.75, roughness: 0.38 }),
    steel: new MeshStandardMaterial({ color: 0x3c3d3d, metalness: 0.9, roughness: 0.28 }),
    dark: new MeshStandardMaterial({ color: 0x101111, metalness: 0.4, roughness: 0.55 }),
    polymer: new MeshStandardMaterial({ color: 0x1c1d1b, metalness: 0.05, roughness: 0.72 }),
    fde: new MeshStandardMaterial({ color: 0x75704f, metalness: 0.08, roughness: 0.6 }),
    olive: new MeshStandardMaterial({ color: 0x505636, metalness: 0.08, roughness: 0.64 }),
    rubber: new MeshStandardMaterial({ color: 0x131313, roughness: 0.95 }),
    accent: new MeshStandardMaterial({ color: 0xd9731f, roughness: 0.5, emissive: 0x2a1004 }),
    glove: new MeshStandardMaterial({ color: 0x2c2b27, roughness: 0.85 }),
    sleeve: new MeshStandardMaterial({ color: 0x555b3d, roughness: 0.93 }),
    glass: new MeshPhysicalMaterial({ color: 0x9ab8d0, roughness: 0.05, transparent: true, opacity: 0.14, depthWrite: false }),
    lens: new MeshPhysicalMaterial({ color: 0x0c1218, metalness: 0.2, roughness: 0.05, clearcoat: 1 }),
    dot: new MeshBasicMaterial({ color: 0xff3a1a }),
};

const add = (g: Object3D, m: Mesh): Mesh => { m.castShadow = false; g.add(m); return m; };

/** Side profile (u, y) extruded across the gun, centered on x. */
function prof(g: Object3D, mat: Material, pts: P[], thick: number, bevel = 0.003, holes: P[][] = [], x = 0): Mesh {
    const s = new Shape(pts.map(([u, y]) => new Vector2(u, y)));
    for (const h of holes) s.holes.push(new Path(h.map(([u, y]) => new Vector2(u, y))));
    const depth = Math.max(0.001, thick - 2 * bevel);
    const geo = new ExtrudeGeometry(s, { depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 10 });
    geo.rotateY(Math.PI / 2); // shape x (forward) -> -z, extrusion -> +x
    geo.translate(x - depth / 2, 0, 0);
    return add(g, new Mesh(geo, mat));
}

/** Body of revolution along the bore: pts = [radius, u] from rear to front, axis at height y. */
function rev(g: Object3D, mat: Material, pts: P[], y: number, seg = 24, x = 0, phi = 0): Mesh {
    const geo = new LatheGeometry(pts.map(([r, u]) => new Vector2(r, u)), seg, phi);
    geo.rotateX(-Math.PI / 2); // lathe +y -> forward (-z)
    geo.translate(x, y, 0);
    return add(g, new Mesh(geo, mat));
}

/** Solid cylinder along the bore. */
const rod = (g: Object3D, mat: Material, r: number, u0: number, u1: number, y: number, x = 0, seg = 20) =>
    rev(g, mat, [[0, u0], [r, u0], [r, u1], [0, u1]], y, seg, x);

/** Box centered at (x, y, u). */
function blk(g: Object3D, mat: Material, [w, h, d]: V3, [x, y, u]: V3, rx = 0): Mesh {
    const m = add(g, new Mesh(new BoxGeometry(w, h, d), mat));
    m.position.set(x, y, -u);
    m.rotation.x = rx;
    return m;
}

/** Plate across the bore (in the x-y plane) with a centered rectangular window. */
function frame(g: Object3D, mat: Material, w: number, h: number, hw: number, hh: number, thick: number, y: number, u: number): Mesh {
    const s = new Shape([new Vector2(-w / 2, -h / 2), new Vector2(w / 2, -h / 2), new Vector2(w / 2, h / 2), new Vector2(-w / 2, h / 2)]);
    s.holes.push(new Path([new Vector2(-hw / 2, -hh / 2), new Vector2(-hw / 2, hh / 2), new Vector2(hw / 2, hh / 2), new Vector2(hw / 2, -hh / 2)]));
    const geo = new ExtrudeGeometry(s, { depth: thick, bevelEnabled: true, bevelThickness: 0.001, bevelSize: 0.001, bevelSegments: 1 });
    geo.translate(0, y, -u - thick / 2);
    return add(g, new Mesh(geo, mat));
}

const UP = new Vector3(0, 1, 0);
/** Capsule (finger, palm) or tapered cylinder (forearm) between two points given as [x, y, u]. */
function seg(g: Object3D, mat: Material, a: V3, b: V3, r: number, r1 = 0): Mesh {
    const pa = new Vector3(a[0], a[1], -a[2]), pb = new Vector3(b[0], b[1], -b[2]);
    const dir = pb.clone().sub(pa), len = dir.length();
    const geo = r1 ? new CylinderGeometry(r1, r, len, 14) : new CapsuleGeometry(r, len, 4, 10);
    const m = add(g, new Mesh(geo, mat));
    m.position.copy(pa).add(pb).multiplyScalar(0.5);
    m.quaternion.copy(new Quaternion().setFromUnitVectors(UP, dir.normalize()));
    return m;
}

/** Quadratic curve sampled as points (for curved magazines and stocks). */
function quad(a: P, c: P, b: P, n = 8): P[] {
    const out: P[] = [];
    for (let i = 0; i <= n; i++) {
        const t = i / n, k = 1 - t;
        out.push([k * k * a[0] + 2 * k * t * c[0] + t * t * b[0], k * k * a[1] + 2 * k * t * c[1] + t * t * b[1]]);
    }
    return out;
}

/** Picatinny rail: base strip plus cross teeth, top surface at yTop. */
function rail(g: Object3D, u0: number, u1: number, yTop: number): void {
    blk(g, M.alu, [0.021, 0.006, u1 - u0], [0, yTop - 0.007, (u0 + u1) / 2]);
    for (let u = u0 + 0.004; u < u1 - 0.003; u += 0.01) blk(g, M.alu, [0.021, 0.004, 0.005], [0, yTop - 0.002, u]);
}

/** Open holographic sight sitting on a rail whose top is at yRail. Window centered on the sight line. */
function reflex(g: Object3D, u: number, yRail: number, small = false): void {
    const w = small ? 0.044 : 0.05, h = small ? 0.038 : 0.044, hw = w - 0.01, hh = h - 0.012, len = small ? 0.04 : 0.05;
    blk(g, M.polymer, [w - 0.012, -yRail - h / 2 + 0.003, len + 0.01], [0, (yRail - h / 2) / 2, u + len / 2]);
    frame(g, M.polymer, w, h, hw, hh, 0.006, 0, u);
    frame(g, M.polymer, w, h, hw, hh, 0.006, 0, u + len);
    for (const x of [-(w - 0.005) / 2, (w - 0.005) / 2]) blk(g, M.polymer, [0.005, h, len], [x, 0, u + len / 2]);
    blk(g, M.polymer, [w, 0.005, len], [0, h / 2 - 0.0025, u + len / 2]);
    rod(g, M.alu, 0.007, u + 0.012, u + 0.03, -0.006, w / 2 + 0.004);
    const lens = add(g, new Mesh(new PlaneGeometry(hw, hh), M.glass));
    lens.position.set(0, 0, -(u + len - 0.002));
    add(g, new Mesh(new SphereGeometry(0.0011, 8, 6), M.dot)).position.set(0, 0, -(u + len - 0.003));
}

/** Right hand on a pistol grip whose front edge goes from top (u0, y0) to bottom (u1, y1). */
function rightHand(g: Object3D, top: P, bot: P, elbow: V3): void {
    const at = (y: number): number => top[0] + (y - top[1]) * (bot[0] - top[0]) / (bot[1] - top[1]);
    const yA = top[1] - 0.012, yB = bot[1] + 0.02;
    seg(g, M.glove, [0.013, yA, at(yA) - 0.03], [0.013, yB, at(yB) - 0.03], 0.021);
    for (const y of [yA - 0.016, yA - 0.036, yA - 0.056]) seg(g, M.glove, [0.016, y, at(y) + 0.002], [-0.016, y - 0.004, at(y) + 0.006], 0.0092);
    seg(g, M.glove, [-0.017, top[1] + 0.004, at(top[1]) - 0.03], [-0.02, top[1] + 0.01, at(top[1]) + 0.004], 0.0085);
    seg(g, M.glove, [0.013, top[1] - 0.006, at(top[1]) - 0.004], [0.003, top[1] - 0.012, at(top[1]) + 0.03], 0.0085);
    const wrist: V3 = [0.014, yB - 0.006, at(yB) - 0.045];
    seg(g, M.sleeve, wrist, elbow, 0.034, 0.044);
}

/** Left hand under a fore-end centered at (u, yAxis), fingers curled up the left side. */
function leftHand(g: Object3D, u: number, yAxis: number, radius: number, elbow: V3): void {
    const yb = yAxis - radius - 0.012;
    seg(g, M.glove, [0, yb, u - 0.03], [0, yb, u + 0.035], 0.021);
    for (let i = 0; i < 4; i++) {
        const fu = u - 0.024 + i * 0.016;
        seg(g, M.glove, [-radius + 0.002, yb + 0.004, fu], [-radius - 0.006, yAxis + radius * 0.4, fu + 0.004], 0.0082);
    }
    seg(g, M.glove, [radius - 0.004, yb + 0.006, u - 0.02], [radius + 0.004, yAxis + radius * 0.2, u + 0.02], 0.0085);
    seg(g, M.sleeve, [0, yb - 0.006, u - 0.045], elbow, 0.034, 0.044);
}

interface ArOpts {
    guard: number;
    barrel: number;
    mag: "curved" | "straight" | "short";
    stock: "carbine" | "precision" | "wire";
    furniture: Material;
    small?: boolean;
}

/** Modern rifle platform shared by the assault rifle, the marksman rifle and the SMG. */
function rifle(g: Group, o: ArOpts): GunModel {
    const AX = -0.056; // bore axis
    // Upper and lower receivers.
    prof(g, M.alu, [[-0.11, -0.04], [0.17, -0.04], [0.17, -0.066], [0.155, -0.071], [-0.11, -0.071]], 0.044);
    prof(g, M.alu, [[-0.095, -0.071], [0.095, -0.071], [0.095, -0.091], [0.062, -0.1], [0.024, -0.1], [0.014, -0.091], [-0.06, -0.091], [-0.095, -0.083]], 0.04);
    rail(g, -0.1, 0.165, -0.034);
    blk(g, M.dark, [0.002, 0.016, 0.045], [0.0225, -0.055, 0.035]);
    blk(g, M.alu, [0.036, 0.007, 0.012], [0, -0.044, -0.104]);
    rod(g, M.alu, 0.0055, -0.03, -0.008, -0.05, 0.024, 12);
    blk(g, M.accent, [0.0405, 0.004, 0.016], [0, -0.081, 0.0]);
    // Trigger guard (plate with a hole), trigger, grip.
    prof(g, M.polymer, [[-0.035, -0.09], [0.04, -0.09], [0.04, -0.117], [-0.028, -0.117], [-0.035, -0.11]], 0.012, 0.002,
        [[[-0.026, -0.095], [-0.026, -0.111], [0.032, -0.111], [0.032, -0.095]]]);
    blk(g, M.steel, [0.004, 0.02, 0.005], [0, -0.1, 0.006], -0.25);
    prof(g, M.polymer, [[-0.018, -0.09], [-0.052, -0.09], [-0.098, -0.2], [-0.09, -0.209], [-0.06, -0.206], [-0.05, -0.193], [-0.014, -0.1]], 0.032, 0.006);
    // Magazine.
    if (o.mag === "curved") {
        prof(g, M.polymer, [...quad([0.03, -0.095], [0.04, -0.2], [0.088, -0.26]), [0.15, -0.254], ...quad([0.15, -0.254], [0.106, -0.19], [0.09, -0.095])], 0.025, 0.003);
        prof(g, M.rubber, [[0.084, -0.256], [0.154, -0.25], [0.156, -0.262], [0.086, -0.27]], 0.03, 0.003);
    } else if (o.mag === "straight") {
        prof(g, M.polymer, [[0.034, -0.095], [0.05, -0.29], [0.09, -0.29], [0.074, -0.095]], 0.024, 0.003);
        prof(g, M.rubber, [[0.048, -0.29], [0.094, -0.29], [0.094, -0.302], [0.046, -0.302]], 0.028, 0.003);
    } else {
        prof(g, M.polymer, [[0.032, -0.095], [0.045, -0.17], [0.105, -0.17], [0.092, -0.095]], 0.026, 0.003);
    }
    // Handguard (octagonal), slots, rail, barrel, gas block, muzzle device.
    const u0 = 0.17, u1 = u0 + o.guard, r = o.small ? 0.022 : 0.027;
    rev(g, o.furniture, [[0, u0], [r, u0], [r, u1], [0, u1]], AX, 8, 0, Math.PI / 8);
    for (let u = u0 + 0.03; u < u1 - 0.02; u += 0.045) for (const x of [-r, r]) blk(g, M.dark, [0.003, 0.008, 0.024], [x, AX, u]);
    rail(g, u0 + 0.004, u1 - 0.006, AX + r * 0.924 + 0.008);
    const b1 = u1 + o.barrel;
    rev(g, M.steel, [[0, u1 - 0.01], [0.0088, u1 - 0.01], [0.0085, b1], [0, b1]], AX);
    if (o.barrel > 0.06) blk(g, M.steel, [0.02, 0.022, 0.02], [0, AX + 0.006, u1 + 0.03]);
    rev(g, M.dark, [[0.0055, b1], [0.0135, b1], [0.0135, b1 + 0.048], [0.011, b1 + 0.055], [0.0055, b1 + 0.055]], AX);
    for (const a of [0, 2.1, 4.2]) blk(g, M.alu, [0.004, 0.004, 0.03], [Math.cos(a) * 0.0135, AX + Math.sin(a) * 0.0135, b1 + 0.03]);
    // Stock.
    if (o.stock === "carbine") {
        rod(g, M.alu, 0.0155, -0.31, -0.1, -0.053);
        prof(g, o.furniture, [[-0.17, -0.034], [-0.335, -0.03], [-0.345, -0.04], [-0.345, -0.15], [-0.325, -0.152], [-0.23, -0.105], [-0.17, -0.09]], 0.046, 0.007);
        prof(g, M.rubber, [[-0.345, -0.032], [-0.358, -0.032], [-0.358, -0.152], [-0.345, -0.152]], 0.048, 0.004);
    } else if (o.stock === "precision") {
        prof(g, o.furniture, [[-0.11, -0.04], [-0.37, -0.02], [-0.385, -0.032], [-0.385, -0.165], [-0.35, -0.167], [-0.27, -0.128], [-0.2, -0.122], [-0.15, -0.1], [-0.11, -0.09]], 0.044, 0.007,
            [[[-0.32, -0.07], [-0.32, -0.12], [-0.26, -0.105], [-0.24, -0.075]]]);
        prof(g, M.rubber, [[-0.385, -0.022], [-0.398, -0.022], [-0.398, -0.167], [-0.385, -0.167]], 0.046, 0.004);
    } else {
        for (const x of [-0.016, 0.016]) rod(g, M.steel, 0.0045, -0.3, -0.09, -0.05, x, 10);
        prof(g, M.polymer, [[-0.29, -0.03], [-0.305, -0.03], [-0.305, -0.13], [-0.29, -0.13]], 0.044, 0.004);
    }
    reflex(g, 0.005, -0.03, o.small);
    rightHand(g, [-0.016, -0.1], [-0.05, -0.192], [0.09, -0.3, -0.42]);
    leftHand(g, u0 + o.guard * 0.55, AX, r, [-0.12, -0.27, u0 + o.guard * 0.55 - 0.42]);
    return { muzzle: [0, AX, -(b1 + 0.055)], hip: [0.17, -0.13, -0.32], adsZ: -0.3 };
}

function sniper(g: Group): GunModel {
    const AX = -0.052;
    rev(g, M.alu, [[0, -0.12], [0.021, -0.12], [0.021, 0.14], [0, 0.14]], AX);
    rail(g, -0.1, 0.13, -0.028);
    seg(g, M.steel, [0.02, AX, -0.06], [0.055, AX - 0.012, -0.07], 0.004);
    add(g, new Mesh(new SphereGeometry(0.009, 12, 8), M.polymer)).position.set(0.058, AX - 0.014, 0.07);
    rev(g, M.steel, [[0, 0.13], [0.0125, 0.13], [0.0095, 0.64], [0, 0.64]], AX);
    rev(g, M.dark, [[0.005, 0.64], [0.016, 0.64], [0.016, 0.705], [0.005, 0.705]], AX);
    for (const u of [0.66, 0.675, 0.69]) for (const x of [-0.016, 0.016]) blk(g, M.alu, [0.003, 0.01, 0.006], [x, AX, u]);
    // Scope: eyepiece, tube, turrets, objective bell, rings.
    rev(g, M.polymer, [[0, -0.12], [0.02, -0.12], [0.022, -0.08], [0.015, -0.06], [0.015, 0.16], [0.025, 0.2], [0.025, 0.26], [0, 0.26]], 0);
    add(g, new Mesh(new CylinderGeometry(0.01, 0.01, 0.018, 16), M.alu)).position.set(0, 0.022, -0.05);
    const side = add(g, new Mesh(new CylinderGeometry(0.009, 0.009, 0.016, 16), M.alu));
    side.rotation.z = Math.PI / 2;
    side.position.set(0.022, 0, -0.05);
    for (const u of [-0.03, 0.11]) frame(g, M.alu, 0.036, 0.05, 0.03, 0.03, 0.012, -0.008, u);
    const front = add(g, new Mesh(new CylinderGeometry(0.023, 0.023, 0.001, 24), M.lens));
    front.rotation.x = Math.PI / 2;
    front.position.set(0, 0, -0.261);
    // Chassis stock with thumb hole, grip, magazine, fore-end.
    prof(g, M.olive, [[-0.11, -0.065], [0.4, -0.065], [0.4, -0.098], [0.1, -0.1], [-0.11, -0.1]], 0.05, 0.005);
    prof(g, M.olive, [[-0.11, -0.045], [-0.4, -0.03], [-0.415, -0.045], [-0.415, -0.175], [-0.38, -0.178], [-0.28, -0.14], [-0.15, -0.14], [-0.11, -0.1]], 0.046, 0.007,
        [[[-0.33, -0.085], [-0.33, -0.13], [-0.25, -0.12], [-0.22, -0.085]]]);
    prof(g, M.rubber, [[-0.415, -0.032], [-0.428, -0.032], [-0.428, -0.178], [-0.415, -0.178]], 0.048, 0.004);
    prof(g, M.polymer, [[-0.035, -0.1], [-0.062, -0.1], [-0.105, -0.205], [-0.075, -0.212], [-0.02, -0.11]], 0.032, 0.006);
    prof(g, M.polymer, [[0.03, -0.098], [0.035, -0.15], [0.105, -0.15], [0.1, -0.098]], 0.03, 0.003);
    prof(g, M.polymer, [[-0.035, -0.098], [0.025, -0.098], [0.025, -0.122], [-0.03, -0.122]], 0.012, 0.002, [[[-0.025, -0.102], [-0.025, -0.116], [0.018, -0.116], [0.018, -0.102]]]);
    blk(g, M.accent, [0.051, 0.004, 0.03], [0, -0.08, 0.25]);
    rightHand(g, [-0.022, -0.1], [-0.07, -0.205], [0.09, -0.31, -0.44]);
    leftHand(g, 0.26, -0.082, 0.022, [-0.12, -0.28, -0.16]);
    return { muzzle: [0, AX, -0.705], hip: [0.17, -0.12, -0.36], adsZ: -0.3 };
}

function pistol(g: Group): GunModel {
    // Slide with front chamfer, serrations, ejection port; frame with rail; grip; guard.
    prof(g, M.alu, [[-0.035, -0.012], [0.15, -0.012], [0.165, -0.018], [0.165, -0.036], [-0.035, -0.036]], 0.03, 0.003);
    for (let u = -0.03; u < -0.0; u += 0.007) for (const x of [-0.0152, 0.0152]) blk(g, M.dark, [0.002, 0.018, 0.0025], [x, -0.024, u]);
    blk(g, M.dark, [0.002, 0.012, 0.035], [0.0152, -0.02, 0.06]);
    prof(g, M.polymer, [[-0.03, -0.036], [0.16, -0.036], [0.16, -0.052], [0.06, -0.054], [-0.03, -0.054]], 0.028, 0.003);
    prof(g, M.polymer, [[-0.005, -0.052], [0.06, -0.052], [0.065, -0.078], [-0.002, -0.08]], 0.012, 0.002, [[[0.003, -0.056], [0.003, -0.074], [0.056, -0.074], [0.056, -0.056]]]);
    blk(g, M.steel, [0.004, 0.016, 0.004], [0, -0.063, 0.02], -0.3);
    prof(g, M.polymer, [[-0.03, -0.052], [0.005, -0.054], [-0.02, -0.15], [-0.03, -0.16], [-0.062, -0.158], [-0.066, -0.148], [-0.04, -0.06]], 0.03, 0.006);
    prof(g, M.rubber, [[-0.028, -0.155], [-0.068, -0.153], [-0.068, -0.163], [-0.03, -0.165]], 0.032, 0.002);
    rev(g, M.dark, [[0.0035, 0.164], [0.0055, 0.164], [0.0055, 0.166], [0.0035, 0.166]], -0.026);
    for (const x of [-0.006, 0.006]) blk(g, M.steel, [0.004, 0.012, 0.007], [x, -0.006, -0.025]);
    blk(g, M.steel, [0.003, 0.012, 0.005], [0, -0.006, 0.155]);
    add(g, new Mesh(new SphereGeometry(0.0012, 6, 4), M.accent)).position.set(0, 0.0, -0.155);
    blk(g, M.accent, [0.0285, 0.003, 0.02], [0, -0.045, 0.12]);
    rightHand(g, [0.0, -0.06], [-0.022, -0.15], [0.09, -0.27, -0.4]);
    // Support hand wraps the firing hand from the left.
    seg(g, M.glove, [-0.022, -0.07, -0.0], [-0.024, -0.13, -0.02], 0.02);
    for (const y of [-0.08, -0.1, -0.12]) seg(g, M.glove, [-0.024, y, 0.012], [0.012, y - 0.004, 0.016], 0.0088);
    seg(g, M.sleeve, [-0.026, -0.145, -0.035], [-0.1, -0.27, -0.4], 0.034, 0.044);
    return { muzzle: [0, -0.026, -0.17], hip: [0.15, -0.12, -0.4], adsZ: -0.42 };
}

function shotgun(g: Group): GunModel {
    const AX = -0.024;
    prof(g, M.alu, [[-0.1, -0.008], [0.16, -0.008], [0.16, -0.075], [-0.1, -0.075]], 0.046, 0.005);
    blk(g, M.dark, [0.002, 0.018, 0.06], [0.0235, -0.03, 0.06]);
    blk(g, M.accent, [0.047, 0.004, 0.03], [0, -0.06, -0.04]);
    rev(g, M.steel, [[0, 0.15], [0.0118, 0.15], [0.0112, 0.62], [0, 0.62]], AX);
    rev(g, M.dark, [[0.008, 0.62], [0.013, 0.62], [0.013, 0.64], [0.008, 0.64]], AX);
    blk(g, M.alu, [0.008, 0.004, 0.46], [0, -0.01, 0.39]);
    add(g, new Mesh(new SphereGeometry(0.0025, 8, 6), M.steel)).position.set(0, -0.006, -0.635);
    rod(g, M.steel, 0.012, 0.15, 0.56, -0.058);
    prof(g, M.polymer, [[-0.02, -0.075], [0.05, -0.075], [0.05, -0.1], [-0.015, -0.1]], 0.012, 0.002, [[[-0.012, -0.079], [-0.012, -0.096], [0.044, -0.096], [0.044, -0.079]]]);
    blk(g, M.steel, [0.004, 0.018, 0.004], [0, -0.085, 0.02], -0.2);
    // Stock with a pistol-grip wrist.
    prof(g, M.olive, [[-0.1, -0.012], [-0.42, -0.024], [-0.435, -0.034], [-0.435, -0.16], [-0.4, -0.162], [-0.2, -0.12], [-0.12, -0.165], [-0.085, -0.16], [-0.06, -0.075]], 0.046, 0.008);
    prof(g, M.rubber, [[-0.435, -0.026], [-0.45, -0.026], [-0.45, -0.162], [-0.435, -0.162]], 0.048, 0.004);
    rightHand(g, [-0.066, -0.085], [-0.105, -0.16], [0.09, -0.29, -0.44]);
    // Pump (with the support hand) slides back on each shot.
    const pump = new Group();
    rev(pump, M.olive, [[0, 0.25], [0.02, 0.25], [0.021, 0.27], [0.021, 0.39], [0.02, 0.41], [0, 0.41]], -0.058, 20);
    for (let u = 0.28; u < 0.39; u += 0.016) rev(pump, M.polymer, [[0, u], [0.0222, u], [0.0222, u + 0.006], [0, u + 0.006]], -0.058, 20);
    leftHand(pump, 0.33, -0.058, 0.021, [-0.12, -0.27, -0.1]);
    g.add(pump);
    return { muzzle: [0, AX, -0.64], hip: [0.17, -0.12, -0.32], adsZ: -0.32, pump };
}

export const GUNS: Record<Kind, (g: Group) => GunModel> = {
    assault: g => rifle(g, { guard: 0.26, barrel: 0.15, mag: "curved", stock: "carbine", furniture: M.fde }),
    marksman: g => rifle(g, { guard: 0.32, barrel: 0.25, mag: "short", stock: "precision", furniture: M.olive }),
    smg: g => rifle(g, { guard: 0.11, barrel: 0.04, mag: "straight", stock: "wire", furniture: M.polymer, small: true }),
    sniper,
    pistol,
    shotgun,
};
