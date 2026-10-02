import {
    BackSide, BoxGeometry, BufferGeometry, Color, DirectionalLight, Float32BufferAttribute, Group, HemisphereLight,
    Mesh, MeshBasicMaterial, MeshStandardMaterial, PlaneGeometry, SphereGeometry, Texture
} from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { rng } from "./rules";
import * as T from "./textures";

export interface Vec { x: number; y: number; z: number; }
export interface Box { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number; }
export interface CoverPoint { x: number; z: number; top: number; tx: number; tz: number; }
export interface RayHit { t: number; nx: number; ny: number; nz: number; }

export const HALF = 32;          // arena half size in meters
export const STEP = 0.45;        // max ledge height actors walk up
const GRID = HALF * 2;           // nav grid: 1 m cells
const NAV_RADIUS = 0.45;

type MatKey = "concrete" | "plaster" | "crate" | "olive" | "rust" | "sand" | "barrier";

export const MAPS = [
    { id: "yard", name: "YARD", desc: "MIXED RANGES AROUND A CENTRAL BUNKER" },
    { id: "quarry", name: "QUARRY", desc: "OPEN GROUND, ROCKS AND A RAISED FIRING DECK. LONG SIGHT LINES" },
    { id: "blocks", name: "BLOCKS", desc: "NARROW STREETS AND OPEN BUILDINGS. CLOSE QUARTERS" },
    { id: "cargo", name: "CARGO", desc: "A TINY CONTAINER YARD. NON-STOP CLOSE FIGHTS" },
    { id: "derrick", name: "DERRICK", desc: "DESERT PIT AROUND A CLIMBABLE DRILLING TOWER" },
] as const;
export type MapId = typeof MAPS[number]["id"];

// Sky (horizon, zenith) and sun per map.
const LOOK: Record<MapId, { sky: number; zenith: number; sun: number; sunI: number; sunPos: [number, number, number] }> = {
    yard: { sky: 0x9a9d92, zenith: 0x6f7c86, sun: 0xffe6c4, sunI: 2.4, sunPos: [-26, 44, 18] },
    quarry: { sky: 0xb8ab8c, zenith: 0x7d8a96, sun: 0xfff0d2, sunI: 2.8, sunPos: [20, 52, -10] },
    blocks: { sky: 0x8d8780, zenith: 0x4f5a6a, sun: 0xffb27a, sunI: 2.0, sunPos: [-40, 22, -26] },
    cargo: { sky: 0x9aa3a8, zenith: 0x5d6b78, sun: 0xfff1dc, sunI: 2.2, sunPos: [30, 40, 20] },
    derrick: { sky: 0xd2b48a, zenith: 0x7c8fa3, sun: 0xffd9a0, sunI: 3.0, sunPos: [-30, 30, 30] },
};

// Small maps sit inside their own ring wall, so they bring their own spawns and firing position.
const SMALL: Partial<Record<MapId, { half: number; wall: number; player: number[][]; bots: number[][]; range: [number, number] }>> = {
    cargo: {
        half: 18, wall: 4.5, range: [0, 16],
        player: [[0, 15], [-15, 15], [15, 15], [-15, 0], [15, 0]],
        bots: [[0, -15], [-15, -15], [15, -15], [-15, -4], [15, 4], [8, -15], [-8, 15]],
    },
    derrick: {
        half: 24, wall: 3, range: [0, 21],
        player: [[0, 21], [-21, 21], [21, 21], [-21, 4], [21, 6]],
        bots: [[0, -21], [-22, -22], [21, -21], [-21, -8], [21, -8], [8, -21], [-8, -21]],
    },
};

/** Slab test. Returns the entry distance (0 if the origin is inside) or Infinity; writes the face normal into n. */
export function rayBox(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, b: Box, n?: RayHit): number {
    // Unrolled per axis: this runs thousands of times per frame (bot line-of-sight), so no allocations.
    let tmin = -Infinity, tmax = Infinity, axis = 0, sign = 0, t1: number, t2: number, s: number, k: number;
    if (dx > -1e-9 && dx < 1e-9) {
        if (ox < b.minX || ox > b.maxX) return Infinity;
    } else {
        t1 = (b.minX - ox) / dx; t2 = (b.maxX - ox) / dx; s = -1;
        if (t1 > t2) { k = t1; t1 = t2; t2 = k; s = 1; }
        tmin = t1; sign = s; tmax = t2;
    }
    if (dy > -1e-9 && dy < 1e-9) {
        if (oy < b.minY || oy > b.maxY) return Infinity;
    } else {
        t1 = (b.minY - oy) / dy; t2 = (b.maxY - oy) / dy; s = -1;
        if (t1 > t2) { k = t1; t1 = t2; t2 = k; s = 1; }
        if (t1 > tmin) { tmin = t1; axis = 1; sign = s; }
        if (t2 < tmax) tmax = t2;
        if (tmax < tmin) return Infinity;
    }
    if (dz > -1e-9 && dz < 1e-9) {
        if (oz < b.minZ || oz > b.maxZ) return Infinity;
    } else {
        t1 = (b.minZ - oz) / dz; t2 = (b.maxZ - oz) / dz; s = -1;
        if (t1 > t2) { k = t1; t1 = t2; t2 = k; s = 1; }
        if (t1 > tmin) { tmin = t1; axis = 2; sign = s; }
        if (t2 < tmax) tmax = t2;
        if (tmax < tmin) return Infinity;
    }
    if (tmax < 0) return Infinity;
    if (n) { n.nx = axis === 0 ? sign : 0; n.ny = axis === 1 ? sign : 0; n.nz = axis === 2 ? sign : 0; }
    return Math.max(tmin, 0);
}

export class World {
    readonly group = new Group();
    readonly boxes: Box[] = [];
    readonly cover: CoverPoint[] = [];
    readonly minimap: HTMLCanvasElement;
    readonly sun: DirectionalLight;
    readonly sky: Color;
    readonly playerSpawns: Vec[] = [[0, 29], [-28, 28], [28, 28], [-29, 2], [29, 2]].map(([x, z]) => ({ x, y: 0, z }));
    readonly botSpawns: Vec[] = [[0, -29], [-29, -29], [29, -29], [-20, -21], [20, -20], [20, 20], [-29, -10], [29, -12], [-12, -29]]
        .map(([x, z]) => ({ x, y: 0, z }));
    /** Aim Range firing position. Blocks: in the east street, the central block hides the middle. */
    rangeOrigin: Vec;
    readonly rangeSpots: Vec[] = [];
    readonly rangeRails: [Vec, Vec][] = [];
    private nav = new Uint8Array(GRID * GRID);
    /** Half size of the playable square (small maps have an inner ring wall). */
    bound = HALF;
    private parts = new Map<MatKey, BufferGeometry[]>();
    private hit: RayHit = { t: 0, nx: 0, ny: 0, nz: 0 };

    constructor(readonly map: MapId = "yard") {
        const look = LOOK[map];
        this.sky = new Color(look.sky);
        this.rangeOrigin = { x: map === "blocks" ? 7.5 : 0, y: 0, z: 29 };
        const small = SMALL[map];
        if (small) {
            const v = ([x, z]: number[]) => ({ x, y: 0, z });
            this.playerSpawns.splice(0, Infinity, ...small.player.map(v));
            this.botSpawns.splice(0, Infinity, ...small.bots.map(v));
            this.rangeOrigin = v(small.range);
            const h = this.bound = small.half;
            this.add("concrete", -h - 1, 0, -h - 1, h + 1, small.wall, -h);
            this.add("concrete", -h - 1, 0, h, h + 1, small.wall, h + 1);
            this.add("concrete", -h - 1, 0, -h, -h, small.wall, h);
            this.add("concrete", h, 0, -h, h + 1, small.wall, h);
        }
        this.layout();
        this.buildMeshes();
        this.buildNav();
        // Spawns are shared by every map: drop the ones a layout covers.
        for (const list of [this.playerSpawns, this.botSpawns]) {
            for (let i = list.length - 1; i >= 0; i--) if (!this.walkable(list[i].x, list[i].z)) list.splice(i, 1);
        }
        this.buildCover();
        this.buildRange();
        this.minimap = this.drawMinimap();

        const sky = new SphereGeometry(220, 24, 12);
        const pos = sky.getAttribute("position");
        const colors: number[] = [];
        const zenith = new Color(look.zenith), c = new Color();
        for (let i = 0; i < pos.count; i++) {
            c.copy(this.sky).lerp(zenith, Math.max(0, pos.getY(i) / 220) ** 0.6);
            colors.push(c.r, c.g, c.b);
        }
        sky.setAttribute("color", new Float32BufferAttribute(colors, 3));
        this.group.add(new Mesh(sky, new MeshBasicMaterial({ vertexColors: true, side: BackSide, fog: false, depthWrite: false })));

        const groundTex = T.groundTexture();
        groundTex.repeat.set(10, 10);
        const ground = new Mesh(new PlaneGeometry(70, 70), new MeshStandardMaterial({ map: groundTex, roughness: 1 }));
        ground.rotation.x = -Math.PI / 2;
        ground.receiveShadow = true;
        this.group.add(ground);

        this.group.add(new HemisphereLight(0xc8ccc0, 0x4a4636, 1.05));
        const sun = this.sun = new DirectionalLight(look.sun, look.sunI);
        sun.position.set(...look.sunPos);
        sun.shadow.mapSize.set(2048, 2048);
        sun.shadow.bias = -0.0004;
        sun.shadow.normalBias = 0.03;
        const sc = sun.shadow.camera;
        sc.left = sc.bottom = -38;
        sc.right = sc.top = 38;
        sc.near = 1;
        sc.far = 120;
        this.group.add(sun);
    }

    // ---------- layout ----------

    private layout(): void {
        this.add("concrete", -33, 0, -33, 33, 4.5, -32);
        this.add("concrete", -33, 0, 32, 33, 4.5, 33);
        this.add("concrete", -33, 0, -32, -32, 4.5, 32);
        this.add("concrete", 32, 0, -32, 33, 4.5, 32);
        if (this.map === "quarry") this.layoutQuarry();
        else if (this.map === "blocks") this.layoutBlocks();
        else if (this.map === "cargo") this.layoutCargo();
        else if (this.map === "derrick") this.layoutDerrick();
        else this.layoutYard();
    }

    private crates(list: number[][]): void {
        for (const [x, z, n] of list) {
            for (let i = 0; i < n; i++) this.add("crate", x - 0.6, i * 1.2, z - 0.6, x + 0.6, (i + 1) * 1.2, z + 0.6);
        }
    }

    /**
     * 36 x 36 m container yard, point-symmetric so both spawn sides play the same: a staggered container row on the
     * north and on the south (one 2-high stack each), a container on each flank, one per corner, a crate pile in the middle.
     */
    private layoutCargo(): void {
        for (const [key, x, z, alongX, y] of [
            ["olive", -11, -8, true, 0], ["rust", 4, -8, true, 0], ["sand", 4, -8, true, 2.6],
            ["rust", 11, 8, true, 0], ["olive", -4, 8, true, 0], ["sand", -4, 8, true, 2.6],
            ["olive", 9, -1, false, 0], ["rust", -9, 1, false, 0],
            ["sand", -15.5, -10, false, 0], ["olive", 15.5, 10, false, 0], ["rust", 15.5, -10, false, 0], ["rust", -15.5, 10, false, 0],
        ] as [MatKey, number, number, boolean, number][]) {
            this.container(key, x, z, alongX, y);
        }
        this.crates([[0, 0, 2], [1.2, 0, 1], [0, 1.2, 1], [-1.2, -0.6, 1], [-13, 3, 1], [13, -3, 1], [6, 13, 2], [-6, -13, 2]]);
    }

    /**
     * 48 x 48 m desert pit. The drilling tower stands off-center (north-east) with three levels: deck (1.6 m),
     * platform (3.2 m) and a crow's nest (4.8 m), all reached by stairs. Pipelines run to it from three sides;
     * two sheds with windows, a tank, a container and pipe stacks fill the edges.
     */
    private layoutDerrick(): void {
        const ox = 3, oz = -3;
        const D = (k: MatKey, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => this.add(k, ox + x0, y0, oz + z0, ox + x1, y1, oz + z1);
        D("concrete", -4, 0, -4, 4, 1.6, 4);
        for (let i = 0; i < 3; i++) D("concrete", -1.2, 0, 4 + i, 1.2, 1.2 - i * 0.4, 5 + i);
        D("concrete", -3, 1.6, -4, 3, 3.2, 0.5);
        for (let i = 0; i < 3; i++) D("concrete", -1, 1.6, 0.5 + i, 1, 2.8 - i * 0.4, 1.5 + i);
        D("concrete", 0, 3.2, -4, 3, 4.8, -2.2);
        for (let i = 0; i < 3; i++) D("concrete", 1, 3.2, -2.2 + i * 0.8, 2.4, 4.4 - i * 0.4, -1.4 + i * 0.8);
        D("barrier", 0, 4.8, -4, 3, 5.5, -3.8);
        D("barrier", -3, 3.2, -4, -2.8, 3.9, 0.5);
        // Mast: four legs and a crown, a landmark seen from everywhere.
        for (const [x, z] of [[-3.7, -3.7], [3.7, -3.7], [-3.7, 3.7], [3.7, 3.7]]) D("rust", x - 0.15, 1.6, z - 0.15, x + 0.15, 12, z + 0.15);
        D("rust", -3.9, 12, -3.9, 3.9, 12.4, 3.9);
        // Pipelines from the west, the north and the south-east (vault over or crouch behind).
        this.add("rust", -22, 0, -2.4, -3, 0.9, -1.6);
        this.add("rust", 2, 0, -22, 2.8, 0.9, -9);
        this.add("rust", 8, 0, 6, 8.8, 0.9, 22);
        this.add("rust", -14, 0, 12, -10, 0.6, 13.5);
        this.add("rust", -13.5, 0.6, 12.2, -10.5, 1.2, 13.3);
        // Sheds with windows (north-west and east), tank, container, crates.
        this.rect("plaster", -21, -21, -13, -15, 3, { s: [-17] }, { s: [-19.5], e: [-18] });
        this.rect("plaster", 15, -6, 21, 1, 3, { w: [-2.5] }, { n: [18], w: [-0.2] });
        this.add("sand", -20, 0, 15, -16, 3, 19);
        this.container("rust", -8, 16, true);
        this.container("sand", 16, -16, false);
        this.crates([[-6, -10, 2], [10, 5, 1], [-17, 2, 1], [16, 14, 2], [-3, 13, 1], [-2, -17, 1], [20, -12, 1]]);
    }

    /** Every map keeps the shared spawns (edges) and the range origin (0, 29) clear. */
    private layoutQuarry(): void {
        // Boulders that break the long lines: [x, z, width, depth, height].
        for (const [x, z, w, d, h] of [[-18, -8, 5, 4, 3.2], [14, -14, 4, 5, 3.6], [-8, 12, 4, 3, 2.8], [21, 6, 3, 4, 3],
            [-22, 18, 4, 4, 3.4], [8, 18, 3, 3, 2.4], [-4, -20, 5, 3, 3]]) {
            this.add("concrete", x - w / 2, 0, z - d / 2, x + w / 2, h, z + d / 2);
        }
        // Raised firing deck in the middle, stairs on the south side, low parapet facing north.
        this.add("concrete", -3, 0, -3, 3, 1.6, 3);
        for (let i = 0; i < 3; i++) this.add("concrete", -1.2, 0, 3 + i, 1.2, 1.2 - i * 0.4, 4 + i);
        this.add("barrier", -3, 1.6, -3, 3, 2.5, -2.7);
        for (const [x0, z0, x1, z1] of [[-14, -2, -9, -1.5], [9, -3, 14, -2.5], [-12, 6, -7, 6.5], [6, 8, 11, 8.5],
            [-26, -18, -21, -17.5], [21, -6, 26, -5.5], [-4, 22, 1, 22.5], [14, 26, 18, 26.5]]) {
            this.add("barrier", x0, 0, z0, x1, 1.05, z1);
        }
        this.container("sand", -14, -24, true);
        this.container("sand", 24, 16, false);
        this.container("rust", 10, -26, true);
        for (const [x, z, n] of [[-10, -14, 1], [17, 12, 2], [-26, 6, 1], [4, -10, 1], [26, -22, 2], [-16, 26, 1]]) {
            for (let i = 0; i < n; i++) this.add("crate", x - 0.6, i * 1.2, z - 0.6, x + 0.6, (i + 1) * 1.2, z + 0.6);
        }
    }

    private layoutBlocks(): void {
        // 3 x 3 city blocks (10 x 9 m) separated by 4-5 m streets: some solid and tall, some open with doors.
        for (const [x, z, open, key, h] of [[-15, -13, false, "plaster", 6], [0, -13, true, "concrete", 3.4], [15, -13, true, "plaster", 3.4],
            [-15, 0, false, "concrete", 6.5], [0, 0, true, "concrete", 3.4], [15, 0, true, "plaster", 3.4],
            [-15, 13, true, "plaster", 3.4], [0, 13, false, "plaster", 6], [15, 13, false, "concrete", 7.5]] as [number, number, boolean, MatKey, number][]) {
            if (open) this.rect(key, x - 5, z - 4.5, x + 5, z + 4.5, h, { n: [x - 2], s: [x + 2], w: [z], e: [z - 1] });
            else this.add(key, x - 5, 0, z - 4.5, x + 5, h, z + 4.5);
        }
        this.wall("concrete", 0, -4.5, 0, 4.5, 3.4, 0.3, [1]);
        this.container("olive", -25, -1, false);
        this.container("rust", 25, -2, false);
        this.container("olive", 0, -23, true);
        this.container("sand", -8, 24, true);
        for (const [x0, z0, x1, z1] of [[-8, -7, -7.5, -5], [7.5, 5, 8, 7], [-3, 6.5, -1, 7], [2, -7, 4, -6.5], [-24, 12, -22, 12.5], [22, -10, 24, -9.5]]) {
            this.add("barrier", x0, 0, z0, x1, 1.05, z1);
        }
        for (const [x, z, n] of [[-7.5, 2, 1], [7.5, -3, 2], [-2, -6.5, 1], [22, 20, 1], [-22, -20, 2], [26, 10, 1], [-26, 22, 1], [12, -22, 1]]) {
            for (let i = 0; i < n; i++) this.add("crate", x - 0.6, i * 1.2, z - 0.6, x + 0.6, (i + 1) * 1.2, z + 0.6);
        }
    }

    private layoutYard(): void {
        this.rect("plaster", -27, -27, -13, -15, 3, { e: [-21], s: [-20] });
        this.rect("plaster", 13, -27, 27, -15, 3, { w: [-21], s: [20] });
        this.rect("plaster", 13, 14, 27, 26, 3, { n: [17], w: [22] });
        this.rect("concrete", -6, -5, 6, 5, 3.4, { n: [-3], s: [3], w: [1], e: [-2] });
        this.wall("concrete", 0, -5, 0, 5, 3.4, 0.3, [0]);

        this.container("olive", -21, 4.2, true);
        this.container("rust", -0.8, 16, false);
        this.container("sand", 23.2, -3, false);
        this.container("olive", -7, 23.2, true);
        this.container("rust", -6, 23.2, true, 2.6);

        for (const [x0, z0, x1, z1] of [[-12, 8, -8, 8.5], [8, -10, 12, -9.5], [-16, -6, -15.5, -2], [15.5, 3, 16, 7],
            [-4, -12, 0, -11.5], [2, 10, 6, 10.5], [-26, 16, -22, 16.5], [22, 8, 26, 8.5], [-3, 25.5, 3, 26]]) {
            this.add("barrier", x0, 0, z0, x1, 1.05, z1);
        }
        for (const [x, z, n] of [[-10, -10, 2], [-8.8, -10, 1], [9, 4, 1], [9, 5.2, 2], [10.2, 4, 1], [-18, 12, 2], [-18, 13.2, 1],
            [18, -8, 1], [-22, -21, 2], [-16, -24, 1], [20, -24, 1], [21.2, -24, 2], [24, 18, 1], [16, 24, 2], [0, -20, 2],
            [1.2, -20, 1], [-28, -6, 1], [28, 14, 2], [6, 27, 1], [-14, 28, 2], [12, -2, 1], [-24, 24, 1], [27, -29, 1],
            [-9, -28, 1], [8, -17, 2]]) {
            for (let i = 0; i < n; i++) this.add("crate", x - 0.6, i * 1.2, z - 0.6, x + 0.6, (i + 1) * 1.2, z + 0.6);
        }
    }

    private add(key: MatKey, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
        const b: Box = { minX: Math.min(x0, x1), minY: y0, minZ: Math.min(z0, z1), maxX: Math.max(x0, x1), maxY: y1, maxZ: Math.max(z0, z1) };
        const w = b.maxX - b.minX, h = b.maxY - b.minY, d = b.maxZ - b.minZ;
        if (w <= 0.01 || h <= 0.01 || d <= 0.01) return;
        this.boxes.push(b);
        const g = new BoxGeometry(w, h, d);
        const tile: Record<MatKey, [number, number]> = {
            concrete: [4, 4], plaster: [3, 3], crate: [0, 0], olive: [2.6, 0], rust: [2.6, 0], sand: [2.6, 0], barrier: [2, 0],
        };
        const [tu, tv] = tile[key];
        // Faces: +x, -x, +y, -y, +z, -z (4 vertices each). Scale UVs to world meters so texels stay square.
        const dims: [number, number][] = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
        const uv = g.getAttribute("uv");
        for (let f = 0; f < 6; f++) {
            const [fu, fv] = dims[f];
            for (let v = f * 4; v < f * 4 + 4; v++) {
                if (tu) uv.setX(v, uv.getX(v) * fu / tu);
                if (tv) uv.setY(v, uv.getY(v) * fv / tv);
            }
        }
        g.translate((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (b.minZ + b.maxZ) / 2);
        if (!this.parts.has(key)) this.parts.set(key, []);
        this.parts.get(key).push(g);
    }

    /** Axis-aligned wall from (x0,z0) to (x1,z1) with door gaps and window openings centered on the given coordinates. */
    private wall(key: MatKey, x0: number, z0: number, x1: number, z1: number, h: number, t: number, doors: number[], wins: number[] = []): void {
        // 2 m doors: with the 0.45 m nav margin on each side, a 1 m nav cell still fits through (1.4 m sealed every room).
        // Windows: 1.4 m wide, sill at 1.1 m, top at 2.1 m (shoot through, crouch under).
        const alongX = z0 === z1, DW = 2, DH = 2.3, WW = 1.4;
        const seg = (s: number, e: number, y0: number, y1 = h) => alongX
            ? this.add(key, s, y0, z0 - t / 2, e, y1, z0 + t / 2)
            : this.add(key, x0 - t / 2, y0, s, x0 + t / 2, y1, e);
        const open = [...doors.map(c => ({ c, w: DW, door: true })), ...wins.map(c => ({ c, w: WW, door: false }))].sort((p, q) => p.c - q.c);
        let cur = alongX ? x0 : z0;
        for (const o of open) {
            seg(cur, o.c - o.w / 2, 0);
            if (o.door) seg(o.c - o.w / 2, o.c + o.w / 2, DH);
            else {
                seg(o.c - o.w / 2, o.c + o.w / 2, 0, 1.1);
                seg(o.c - o.w / 2, o.c + o.w / 2, 2.1);
            }
            cur = o.c + o.w / 2;
        }
        seg(cur, alongX ? x1 : z1, 0);
    }

    private rect(key: MatKey, x0: number, z0: number, x1: number, z1: number, h: number,
        doors: { n?: number[]; s?: number[]; w?: number[]; e?: number[] }, wins: { n?: number[]; s?: number[]; w?: number[]; e?: number[] } = {}): void {
        this.wall(key, x0, z0, x1, z0, h, 0.3, doors.n ?? [], wins.n);
        this.wall(key, x0, z1, x1, z1, h, 0.3, doors.s ?? [], wins.s);
        this.wall(key, x0, z0, x0, z1, h, 0.3, doors.w ?? [], wins.w);
        this.wall(key, x1, z0, x1, z1, h, 0.3, doors.e ?? [], wins.e);
    }

    private container(key: MatKey, x: number, z: number, alongX: boolean, y = 0): void {
        const L = 6, W = 2.4, H = 2.6;
        if (alongX) this.add(key, x - L / 2, y, z - W / 2, x + L / 2, y + H, z + W / 2);
        else this.add(key, x - W / 2, y, z - L / 2, x + W / 2, y + H, z + L / 2);
    }

    private buildMeshes(): void {
        const maps: Record<MatKey, () => Texture> = {
            concrete: T.concreteTexture, plaster: T.plasterTexture, crate: T.crateTexture, barrier: T.barrierTexture,
            olive: T.containerTexture, rust: T.containerTexture, sand: T.containerTexture,
        };
        const tint: Partial<Record<MatKey, number>> = { olive: 0x8f9a68, rust: 0xb58e6c, sand: 0xc2b48e };
        let containerMap: Texture | null = null;
        for (const [key, geos] of this.parts) {
            const isContainer = key in tint;
            const map = isContainer ? (containerMap ??= maps[key]()) : maps[key]();
            const mat = new MeshStandardMaterial({ map, color: tint[key] ?? 0xffffff, roughness: isContainer ? 0.7 : 0.95, metalness: isContainer ? 0.25 : 0 });
            const mesh = new Mesh(mergeGeometries(geos), mat);
            mesh.castShadow = mesh.receiveShadow = true;
            this.group.add(mesh);
            geos.forEach(g => g.dispose());
        }
        this.parts.clear();
    }

    /** Frees the GPU buffers and textures (map change). */
    dispose(): void {
        this.group.traverse(o => {
            const m = o as Mesh;
            if (!m.isMesh) return;
            m.geometry.dispose();
            for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
                (mat as MeshStandardMaterial).map?.dispose();
                mat.dispose();
            }
        });
        this.sun.shadow.map?.dispose();
    }

    // ---------- queries ----------

    /** First solid hit along a ray (dir normalized), or null. */
    raycast(o: Vec, d: Vec, maxT: number): RayHit | null {
        let best = maxT, found = false;
        const n: RayHit = { t: 0, nx: 0, ny: 0, nz: 0 };
        for (const b of this.boxes) {
            const t = rayBox(o.x, o.y, o.z, d.x, d.y, d.z, b, this.hit);
            if (t < best) {
                best = t;
                found = true;
                n.nx = this.hit.nx; n.ny = this.hit.ny; n.nz = this.hit.nz;
            }
        }
        if (d.y < -1e-6) {
            const tg = -o.y / d.y;
            if (tg < best) { best = tg; found = true; n.nx = 0; n.ny = 1; n.nz = 0; }
        }
        if (!found) return null;
        n.t = best;
        return n;
    }

    /** True when nothing solid blocks the segment a-b. */
    los(a: Vec, b: Vec): boolean {
        const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
        for (const box of this.boxes) {
            if (rayBox(a.x, a.y, a.z, dx, dy, dz, box) < 1) return false;
        }
        return true;
    }

    /** Moves a vertical cylinder (feet at p.y) by (dx, dz), sliding along boxes. */
    move(p: Vec, radius: number, height: number, dx: number, dz: number): void {
        p.x += dx;
        this.resolve(p, radius, height, 0, dx);
        p.z += dz;
        this.resolve(p, radius, height, 2, dz);
    }

    private resolve(p: Vec, r: number, h: number, axis: 0 | 2, delta: number): void {
        for (const b of this.boxes) {
            if (b.maxY <= p.y + STEP || b.minY >= p.y + h) continue;
            if (p.x + r <= b.minX || p.x - r >= b.maxX || p.z + r <= b.minZ || p.z - r >= b.maxZ) continue;
            if (axis === 0) {
                const toMin = delta > 0 || (delta === 0 && p.x < (b.minX + b.maxX) / 2);
                p.x = toMin ? b.minX - r : b.maxX + r;
            } else {
                const toMin = delta > 0 || (delta === 0 && p.z < (b.minZ + b.maxZ) / 2);
                p.z = toMin ? b.minZ - r : b.maxZ + r;
            }
        }
    }

    /** Highest walkable surface under (x, z) reachable from height y. */
    groundAt(x: number, z: number, y: number, r: number): number {
        let g = 0;
        const e = r * 0.6;
        for (const b of this.boxes) {
            if (b.maxY > y + STEP + 0.01 || b.maxY <= g) continue;
            if (x + e > b.minX && x - e < b.maxX && z + e > b.minZ && z - e < b.maxZ) g = b.maxY;
        }
        return g;
    }

    // ---------- navigation ----------

    private buildNav(): void {
        for (let gz = 0; gz < GRID; gz++) {
            for (let gx = 0; gx < GRID; gx++) {
                const x = gx - HALF + 0.5, z = gz - HALF + 0.5;
                this.nav[gz * GRID + gx] = Math.abs(x) > this.bound || Math.abs(z) > this.bound || this.boxes.some(b => b.minY < 1.7 && b.maxY > STEP &&
                    x > b.minX - NAV_RADIUS && x < b.maxX + NAV_RADIUS && z > b.minZ - NAV_RADIUS && z < b.maxZ + NAV_RADIUS) ? 1 : 0;
            }
        }
    }

    walkable(x: number, z: number): boolean {
        const gx = Math.floor(x + HALF), gz = Math.floor(z + HALF);
        return gx >= 0 && gz >= 0 && gx < GRID && gz < GRID && this.nav[gz * GRID + gx] === 0;
    }

    private nearestWalkable(gx: number, gz: number): number {
        for (let r = 0; r < 4; r++) {
            for (let dz = -r; dz <= r; dz++) {
                for (let dx = -r; dx <= r; dx++) {
                    const x = gx + dx, z = gz + dz;
                    if (x >= 0 && z >= 0 && x < GRID && z < GRID && this.nav[z * GRID + x] === 0) return z * GRID + x;
                }
            }
        }
        return -1;
    }

    /** A* over the 1 m grid (8-way, no corner cutting), then string-pulled unless pull is false. Empty array = no path. */
    findPath(ax: number, az: number, bx: number, bz: number, pull = true): { x: number; z: number }[] {
        const clampG = (v: number) => Math.min(GRID - 1, Math.max(0, Math.floor(v + HALF)));
        const start = this.nearestWalkable(clampG(ax), clampG(az));
        const goal = this.nearestWalkable(clampG(bx), clampG(bz));
        if (start < 0 || goal < 0) return [];
        const N = GRID * GRID, g = new Float32Array(N).fill(Infinity), parent = new Int32Array(N).fill(-1), closed = new Uint8Array(N);
        const gxg = goal % GRID, gzg = (goal / GRID) | 0;
        const h = (i: number) => {
            const dx = Math.abs(i % GRID - gxg), dz = Math.abs(((i / GRID) | 0) - gzg);
            return dx + dz + (Math.SQRT2 - 2) * Math.min(dx, dz);
        };
        const heap: number[] = [], f: number[] = [];
        const push = (i: number, fi: number) => {
            heap.push(i); f.push(fi);
            for (let c = heap.length - 1; c > 0;) {
                const p = (c - 1) >> 1;
                if (f[p] <= f[c]) break;
                [heap[p], heap[c]] = [heap[c], heap[p]];
                [f[p], f[c]] = [f[c], f[p]];
                c = p;
            }
        };
        const pop = () => {
            const top = heap[0], li = heap.pop(), lf = f.pop();
            if (heap.length) {
                heap[0] = li; f[0] = lf;
                for (let c = 0; ;) {
                    const l = c * 2 + 1, r = l + 1;
                    let m = c;
                    if (l < heap.length && f[l] < f[m]) m = l;
                    if (r < heap.length && f[r] < f[m]) m = r;
                    if (m === c) break;
                    [heap[m], heap[c]] = [heap[c], heap[m]];
                    [f[m], f[c]] = [f[c], f[m]];
                    c = m;
                }
            }
            return top;
        };
        g[start] = 0;
        push(start, h(start));
        while (heap.length) {
            const cur = pop();
            if (cur === goal) break;
            if (closed[cur]) continue;
            closed[cur] = 1;
            const cx = cur % GRID, cz = (cur / GRID) | 0;
            for (let dz = -1; dz <= 1; dz++) {
                for (let dx = -1; dx <= 1; dx++) {
                    if (!dx && !dz) continue;
                    const nx = cx + dx, nz = cz + dz;
                    if (nx < 0 || nz < 0 || nx >= GRID || nz >= GRID) continue;
                    const ni = nz * GRID + nx;
                    if (this.nav[ni] || closed[ni]) continue;
                    if (dx && dz && (this.nav[cz * GRID + nx] || this.nav[nz * GRID + cx])) continue;
                    const ng = g[cur] + (dx && dz ? Math.SQRT2 : 1);
                    if (ng < g[ni]) {
                        g[ni] = ng;
                        parent[ni] = cur;
                        push(ni, ng + h(ni));
                    }
                }
            }
        }
        if (parent[goal] < 0 && goal !== start) return [];
        const cells: { x: number; z: number }[] = [];
        for (let i = goal; i >= 0; i = parent[i]) cells.push({ x: i % GRID - HALF + 0.5, z: ((i / GRID) | 0) - HALF + 0.5 });
        cells.reverse();
        if (!pull) return cells;
        const out: { x: number; z: number }[] = [];
        let from = { x: ax, z: az };
        for (let i = 0; i < cells.length;) {
            let j = cells.length - 1;
            while (j > i && !this.walkLine(from, cells[j])) j--;
            out.push(cells[j]);
            from = cells[j];
            i = j + 1;
        }
        return out;
    }

    private walkLine(a: { x: number; z: number }, b: { x: number; z: number }): boolean {
        const len = Math.hypot(b.x - a.x, b.z - a.z), steps = Math.ceil(len / 0.35);
        for (let s = 1; s <= steps; s++) {
            const t = s / steps;
            if (!this.walkable(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t)) return false;
        }
        return true;
    }

    private buildCover(): void {
        for (const b of this.boxes) {
            if (b.minY > 0.1 || b.maxY < 0.95) continue;
            const top = Math.min(b.maxY, 3);
            const sides: [number, number, number, number, number, number][] = [
                // [fixed x or z, span min, span max, normal x, normal z, alongX]
                [b.minZ, b.minX, b.maxX, 0, -1, 1], [b.maxZ, b.minX, b.maxX, 0, 1, 1],
                [b.minX, b.minZ, b.maxZ, -1, 0, 0], [b.maxX, b.minZ, b.maxZ, 1, 0, 0],
            ];
            for (const [fixed, s0, s1, nx, nz, alongX] of sides) {
                for (let s = s0 + 0.4; s <= s1 - 0.4 + 1e-6; s += 1.2) {
                    const x = alongX ? s : fixed + nx * 0.6, z = alongX ? fixed + nz * 0.6 : s;
                    if (Math.abs(x) > HALF - 0.8 || Math.abs(z) > HALF - 0.8 || !this.walkable(x, z)) continue;
                    if (this.cover.some(c => Math.abs(c.x - x) < 0.6 && Math.abs(c.z - z) < 0.6)) continue;
                    this.cover.push({ x, z, top, tx: alongX ? 1 : 0, tz: alongX ? 0 : 1 });
                }
            }
        }
    }

    private buildRange(): void {
        const eye = { x: this.rangeOrigin.x, y: 1.65, z: this.rangeOrigin.z };
        const visible = (x: number, z: number) => this.los(eye, { x, y: 1.45, z }) && this.los(eye, { x, y: 0.9, z });
        const cand: Vec[] = [];
        for (let z = -28; z <= 20; z += 2) {
            for (let x = -28; x <= 28; x += 2) {
                const d = Math.hypot(x - eye.x, z - eye.z);
                if (d >= 10 && d <= 56 && this.walkable(x, z) && visible(x, z)) cand.push({ x, y: 0, z });
            }
        }
        const r = rng(21);
        for (let i = cand.length - 1; i > 0; i--) {
            const j = Math.floor(r() * (i + 1));
            [cand[i], cand[j]] = [cand[j], cand[i]];
        }
        for (const c of cand) {
            if (this.rangeSpots.length >= 18) break;
            if (this.rangeSpots.every(s => Math.hypot(s.x - c.x, s.z - c.z) > 5)) this.rangeSpots.push(c);
        }
        for (let z = -18; z <= 14 && this.rangeRails.length < 3; z += 4) {
            for (let x = -24; x <= 16; x += 4) {
                let ok = true;
                for (let s = 0; s <= 8 && ok; s++) ok = this.walkable(x + s, z) && visible(x + s, z);
                if (ok && this.rangeRails.every(([a]) => Math.abs(a.z - z) >= 8)) {
                    this.rangeRails.push([{ x, y: 0, z }, { x: x + 8, y: 0, z }]);
                    break;
                }
            }
        }
    }

    private drawMinimap(): HTMLCanvasElement {
        const c = document.createElement("canvas"), px = 4;
        c.width = c.height = GRID * px;
        const ctx = c.getContext("2d");
        for (const b of this.boxes) {
            ctx.fillStyle = b.maxY >= 4 ? "rgba(214,206,170,0.7)" : b.maxY >= 1.4 ? "rgba(214,206,170,0.5)" : "rgba(214,206,170,0.25)";
            ctx.fillRect((b.minX + HALF) * px, (b.minZ + HALF) * px, (b.maxX - b.minX) * px, (b.maxZ - b.minZ) * px);
        }
        return c;
    }
}
