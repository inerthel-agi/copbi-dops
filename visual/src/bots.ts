import {
    AdditiveBlending, BoxGeometry, DoubleSide, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, PlaneGeometry, Vector3
} from "three";
import { Rng, Zone } from "./rules";
import { Box, CoverPoint, Vec, World } from "./world";
import { flashTexture } from "./textures";

export interface Hitbox { box: Box; zone: Zone; }

const M = {
    uniform: new MeshStandardMaterial({ color: 0x3b3d38, roughness: 0.9 }),
    vest: new MeshStandardMaterial({ color: 0x6b6648, roughness: 0.85 }),
    helmet: new MeshStandardMaterial({ color: 0x4f5435, roughness: 0.7 }),
    face: new MeshStandardMaterial({ color: 0x26271f, roughness: 0.9 }),
    band: new MeshStandardMaterial({ color: 0xc8541e, emissive: 0x6a2406, roughness: 0.6 }),
    gun: new MeshStandardMaterial({ color: 0x1f201d, metalness: 0.5, roughness: 0.5 }),
    steel: new MeshStandardMaterial({ color: 0xcfc7a6, roughness: 0.55, metalness: 0.2 }),
    steelHead: new MeshStandardMaterial({ color: 0xc08a50, roughness: 0.55, metalness: 0.2 }),
    post: new MeshStandardMaterial({ color: 0x2c2e2b, roughness: 0.6, metalness: 0.4 }),
};
let flashMat: MeshBasicMaterial | null = null;

const geo = new Map<string, BoxGeometry>();
/** Shared box geometry; pivot = top-center when hang is true (limbs). */
function part(parent: Group, mat: MeshStandardMaterial, w: number, h: number, d: number, x: number, y: number, z: number, hang = false): Mesh {
    const key = `${w}|${h}|${d}|${hang}`;
    let g = geo.get(key);
    if (!g) {
        g = new BoxGeometry(w, h, d);
        if (hang) g.translate(0, -h / 2, 0);
        geo.set(key, g);
    }
    const m = new Mesh(g, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    parent.add(m);
    return m;
}

/** Meters the upper body drops when fully crouched (mesh, hitboxes, eye and muzzle all use it). */
const SINK = 0.6;
const dist2 =(a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

export interface BotContext {
    world: World;
    r: Rng;
    now: number;
    eye: Vector3;       // player eye
    feet: Vector3;      // player feet
    playerAlive: boolean;
    skill: number;      // 0..1
    rush: number;       // 0..1, chance to push the player instead of taking cover
    claimed: Set<CoverPoint>;
    others: Bot[];
    /** eye = ray origin (matches the line-of-sight test), muzzle = tracer start. */
    shoot(bot: Bot, eye: Vector3, muzzle: Vector3, errorMult: number): void;
}

export type BotState = "move" | "hide" | "peek" | "dead";

/** Hostile soldier: moves to cover, hides, peeks to shoot in bursts, falls back when hurt or flanked. */
export class Bot {
    readonly group = new Group();
    readonly pos = new Vector3();
    yaw = 0;
    health = 100;
    alive = true;
    armored = true;
    kills = 0;
    deaths = 0;
    state: BotState = "move";
    crouch = 0;
    lastShot = -99;
    respawnAt = -1;
    /** Time of the first hit received (TTK start), -1 when untouched. */
    firstHit = -1;

    private body = new Group();
    private legL: Mesh;
    private legR: Mesh;
    private flash: Mesh;
    private vestMat: MeshStandardMaterial;
    private cover: CoverPoint | null = null;
    private peekSpot: { x: number; z: number } | null = null;
    private goal: { x: number; z: number } | null = null;
    private path: { x: number; z: number }[] = [];
    private timer = 0;
    private seenFor = 0;
    private unseenFor = 0;
    private exposedFor = 0;
    private burst = 0;
    private burstLen = 3;
    private shotCd = 0;
    private losT = 0;
    private visible = false;
    private hurtAt = -99;
    /** Last time the bot saw the player (or spawned): after 5 s without contact it goes hunting. */
    private lastSeen = 0;
    private stuckT = 0;
    private stuckFrom = new Vector3();
    private walk = 0;
    private deathT = 0;
    private flashT = 0;
    private boxes: Hitbox[] = (["head", "torso", "legs"] as Zone[]).map(zone => ({ zone, box: { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 } }));
    private tmp = new Vector3();
    private eye = new Vector3();

    constructor(readonly name: string) {
        this.vestMat = M.vest.clone();
        this.group.rotation.order = "YXZ";
        this.legL = part(this.group, M.uniform, 0.17, 0.9, 0.19, -0.1, 0.9, 0, true);
        this.legR = part(this.group, M.uniform, 0.17, 0.9, 0.19, 0.1, 0.9, 0, true);
        const b = this.body;
        part(b, M.uniform, 0.44, 0.58, 0.25, 0, 1.19, 0);
        part(b, this.vestMat, 0.5, 0.42, 0.31, 0, 1.22, 0);
        part(b, M.face, 0.21, 0.24, 0.23, 0, 1.6, 0);
        part(b, M.helmet, 0.27, 0.13, 0.29, 0, 1.73, 0.01);
        part(b, M.band, 0.272, 0.03, 0.03, 0, 1.69, -0.14);
        part(b, M.uniform, 0.11, 0.11, 0.48, 0.2, 1.36, -0.2);
        part(b, M.uniform, 0.11, 0.11, 0.42, -0.14, 1.33, -0.28);
        part(b, M.gun, 0.06, 0.09, 0.78, 0.1, 1.33, -0.42);
        flashMat ??= new MeshBasicMaterial({ map: flashTexture(), transparent: true, blending: AdditiveBlending, depthWrite: false, side: DoubleSide });
        this.flash = new Mesh(new PlaneGeometry(0.35, 0.35), flashMat);
        this.flash.position.set(0.1, 1.34, -0.86);
        this.flash.visible = false;
        b.add(this.flash);
        this.group.add(b);
    }

    spawn(p: Vec, yaw: number): void {
        this.pos.set(p.x, 0, p.z);
        this.yaw = yaw;
        this.health = 100;
        this.alive = true;
        this.state = "move";
        this.cover = this.peekSpot = this.goal = null;
        this.path = [];
        this.crouch = 0;
        this.deathT = 0;
        this.respawnAt = -1;
        this.firstHit = -1;
        this.burst = 0;
        this.shotCd = 0.5;
        this.lastSeen = Infinity; // reset to "now" on the first update
        this.group.visible = true;
        this.group.rotation.set(0, yaw, 0);
        this.group.position.copy(this.pos);
    }

    hitboxes(): Hitbox[] {
        // Same pose as the mesh: the upper body sinks as a block, the legs shrink.
        const k = SINK * this.crouch, p = this.pos;
        const set = (b: Box, hw: number, y0: number, y1: number) => {
            b.minX = p.x - hw; b.maxX = p.x + hw; b.minZ = p.z - hw; b.maxZ = p.z + hw;
            b.minY = p.y + y0; b.maxY = p.y + y1;
        };
        set(this.boxes[0].box, 0.15, 1.47 - k, 1.81 - k);
        set(this.boxes[1].box, 0.27, 0.9 - k, 1.47 - k);
        set(this.boxes[2].box, 0.2, 0, 0.9 - k);
        return this.boxes;
    }

    /** Applies damage; returns true on the killing blow. */
    damage(amount: number, now: number, claimed: Set<CoverPoint>): boolean {
        if (!this.alive) return false;
        this.health -= amount;
        this.hurtAt = now;
        if (this.firstHit < 0) this.firstHit = now;
        this.vestMat.emissive.setHex(0x5a2010);
        if (this.health > 0) return false;
        this.alive = false;
        this.state = "dead";
        this.deaths++;
        if (this.cover) claimed.delete(this.cover);
        this.cover = null;
        return true;
    }

    dispose(): void {
        this.vestMat.dispose();
    }

    update(dt: number, c: BotContext): void {
        this.vestMat.emissive.multiplyScalar(Math.exp(-dt * 10));
        this.flashT -= dt;
        this.flash.visible = this.flashT > 0;
        if (!this.alive) {
            this.deathT += dt;
            this.group.rotation.x = Math.min(1, this.deathT * 2.6) * 1.45;
            if (this.deathT > 3.5) this.group.visible = false;
            return;
        }
        this.shotCd -= dt;
        this.losT -= dt;
        if (this.losT <= 0) {
            this.losT = 0.1 + c.r() * 0.06;
            this.tmp.set(this.pos.x, 1.62 - SINK * this.crouch, this.pos.z);
            this.visible = c.playerAlive && c.world.los(this.tmp, c.eye);
            if (this.visible || this.lastSeen > c.now) this.lastSeen = c.now;
        }
        // Camping a spot that never sees the player: move up toward the player's position.
        if (c.playerAlive && c.now - this.lastSeen > 5) {
            this.lastSeen = c.now;
            this.push(c);
        }
        const reaction = 0.7 - 0.55 * c.skill;
        let wantCrouch = false, speed = 3.4;

        if (this.state === "move") {
            if (!this.path.length) {
                if (this.cover) this.toHide(c);
                else if ((this.timer -= dt) <= 0) {
                    this.pickCover(c);
                    this.timer = 1;
                }
            }
            if (this.visible && dist2(this.pos, c.feet) < 30) {
                this.seenFor += dt;
                if (this.seenFor > reaction * 1.4) this.tryShoot(c, 1.8);
            } else this.seenFor = 0;
        } else if (this.state === "hide") {
            wantCrouch = !!this.cover && this.cover.top < 1.5;
            speed = 2.6;
            this.goal = this.cover;
            // Seen while settled in cover: the player flanked this spot.
            const settled = !!this.cover && dist2(this.pos, this.cover) < 0.4 && (this.crouch > 0.8) === wantCrouch;
            this.exposedFor = this.visible && settled ? this.exposedFor + dt : 0;
            if (this.exposedFor > 0.4) {
                if (c.r() < 0.5) this.toPeek(c);
                else this.pickCover(c);
            }
            this.timer -= dt;
            if (this.timer <= 0 && this.state === "hide") this.toPeek(c);
        } else if (this.state === "peek") {
            speed = 2.2;
            this.goal = this.peekSpot ?? this.cover;
            if (this.visible) {
                this.unseenFor = 0;
                this.seenFor += dt;
                if (this.seenFor > reaction) this.tryShoot(c, 1);
            } else {
                this.seenFor = 0;
                this.unseenFor += dt;
                if (this.unseenFor > 1.6) this.pickCover(c);
            }
            if (c.now - this.hurtAt < 0.05 && c.r() < 0.5) this.toHide(c);
        }

        // Steering: long moves follow the A* path, short ones (peek / back to cover) go straight.
        const dest = this.state === "move" ? this.path[0] : this.goal;
        let moving = false, moveYaw = this.yaw;
        if (dest) {
            const dx = dest.x - this.pos.x, dz = dest.z - this.pos.z, d = Math.hypot(dx, dz);
            if (d < 0.25) {
                if (this.state === "move") this.path.shift();
            } else {
                const step = Math.min(d, speed * (1 - 0.5 * this.crouch) * dt);
                c.world.move(this.pos, 0.3, 1.7, dx / d * step, dz / d * step);
                moving = true;
                moveYaw = Math.atan2(-dx, -dz);
            }
        }
        for (const o of c.others) {
            if (o === this || !o.alive) continue;
            const dx = this.pos.x - o.pos.x, dz = this.pos.z - o.pos.z, d = Math.hypot(dx, dz);
            if (d > 0.01 && d < 0.7) c.world.move(this.pos, 0.3, 1.7, dx / d * (0.7 - d) * 0.5, dz / d * (0.7 - d) * 0.5);
        }
        if (this.state === "move" && this.path.length) {
            this.stuckT += dt;
            if (this.stuckT > 1.2) {
                if (this.pos.distanceTo(this.stuckFrom) < 0.3) {
                    // Caught on a corner by a shortcut line: follow the raw grid cells instead (they keep clear of corners).
                    const goal = this.path[this.path.length - 1];
                    const raw = c.world.findPath(this.pos.x, this.pos.z, goal.x, goal.z, false);
                    if (raw.length > 1) this.path = raw;
                    else this.pickCover(c);
                }
                this.stuckT = 0;
                this.stuckFrom.copy(this.pos);
            }
        }

        const faceYaw = this.visible && (this.state !== "move" || this.seenFor > 0)
            ? Math.atan2(-(c.feet.x - this.pos.x), -(c.feet.z - this.pos.z)) : moveYaw;
        const dy = wrap(faceYaw - this.yaw);
        this.yaw += Math.sign(dy) * Math.min(Math.abs(dy), 7 * dt);
        this.crouch += ((wantCrouch ? 1 : 0) - this.crouch) * Math.min(1, dt * 8);

        const ns = 1 - SINK / 0.9 * this.crouch;
        this.walk += moving ? dt * 9 : 0;
        const swing = moving ? Math.sin(this.walk) * 0.55 : 0;
        this.legL.position.y = this.legR.position.y = 0.9 * ns;
        this.legL.scale.y = this.legR.scale.y = ns;
        this.legL.rotation.x = swing;
        this.legR.rotation.x = -swing;
        this.body.position.y = 0.9 * ns - 0.9;
        this.group.position.copy(this.pos);
        this.group.rotation.y = this.yaw;
    }

    private toHide(c: BotContext): void {
        this.state = "hide";
        this.timer = 0.7 + c.r() * 1.5;
        this.burst = 0;
        this.exposedFor = 0;
        this.path = [];
    }

    private toPeek(c: BotContext): void {
        if (!this.cover) return this.pickCover(c);
        this.state = "peek";
        this.seenFor = this.unseenFor = 0;
        this.burstLen = 3 + Math.floor(c.r() * 4);
    }

    private tryShoot(c: BotContext, errorMult: number): void {
        if (this.shotCd > 0) return;
        this.shotCd = 0.12 + c.r() * 0.06;
        this.lastShot = c.now;
        this.flashT = 0.05;
        this.flash.rotation.z = c.r() * Math.PI;
        const k = SINK * this.crouch, sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
        // Muzzle (0.1, 1.34, -0.86) in model space, rotated by yaw. The ray itself starts at the eye:
        // the muzzle can poke through the cover the bot is peeking over.
        this.tmp.set(this.pos.x + 0.1 * cos - 0.86 * sin, 1.34 - k, this.pos.z - 0.1 * sin - 0.86 * cos);
        this.eye.set(this.pos.x, 1.55 - k, this.pos.z);
        c.shoot(this, this.eye, this.tmp, errorMult);
        if (++this.burst >= this.burstLen) {
            this.burst = 0;
            this.burstLen = 3 + Math.floor(c.r() * 4);
            this.shotCd = (0.5 + c.r() * 0.5) * (1.3 - c.skill);
            if (this.state === "peek") this.toHide(c);
        }
    }

    /** Picks a spot hidden from the player that still offers a peek (stand up, or sidestep a corner). */
    private pickCover(c: BotContext): void {
        if (this.cover) c.claimed.delete(this.cover);
        this.cover = this.peekSpot = this.goal = null;
        const w = c.world, eye = c.eye;
        if (c.r() < c.rush) return this.push(c);
        const cands = w.cover
            .filter(p => !c.claimed.has(p))
            .map(p => ({ p, d: dist2(p, this.pos) }))
            .filter(e => e.d < 32)
            .sort((a, b) => a.d - b.d)
            .slice(0, 45);
        let best: CoverPoint | null = null, bestPeek: { x: number; z: number } | null = null, bestScore = Infinity;
        for (const { p, d } of cands) {
            const dp = dist2(p, c.feet);
            if (dp < 7 || dp > 38) continue;
            const low = p.top < 1.5;
            if (w.los({ x: p.x, y: low ? 1.62 - SINK : 1.62, z: p.z }, eye)) continue;
            let peek: { x: number; z: number } | null = null;
            if (low) {
                if (w.los({ x: p.x, y: 1.62, z: p.z }, eye)) peek = { x: p.x, z: p.z };
            } else {
                for (const sg of [1, -1]) {
                    const q = { x: p.x + p.tx * 1.1 * sg, z: p.z + p.tz * 1.1 * sg };
                    if (w.walkable(q.x, q.z) && w.los({ x: q.x, y: 1.62, z: q.z }, eye)) { peek = q; break; }
                }
            }
            if (!peek) continue;
            const crowd = c.others.some(o => o !== this && o.alive && dist2(o.pos, p) < 2.5) ? 8 : 0;
            const score = d + Math.abs(dp - 16) * 0.6 + c.r() * 4 + crowd;
            if (score < bestScore) { bestScore = score; best = p; bestPeek = peek; }
        }
        this.state = "move";
        this.stuckT = 0;
        this.stuckFrom.copy(this.pos);
        if (best) {
            c.claimed.add(best);
            this.cover = best;
            this.peekSpot = bestPeek;
            this.path = w.findPath(this.pos.x, this.pos.z, best.x, best.z);
            if (!this.path.length) this.path = [{ x: best.x, z: best.z }];
        } else this.push(c);
    }

    /** Push toward the player and fight in the open (no cover left, or a rushing bot). */
    private push(c: BotContext): void {
        if (this.cover) c.claimed.delete(this.cover);
        this.cover = this.peekSpot = this.goal = null;
        this.state = "move";
        this.stuckT = 0;
        this.stuckFrom.copy(this.pos);
        const path = c.world.findPath(this.pos.x, this.pos.z, c.feet.x, c.feet.z);
        this.path = path.slice(0, Math.max(1, Math.ceil(path.length / 2)));
    }
}

/** Pop-up steel silhouette for the Aim Range; optional rail makes it a mover. */
export class Target {
    readonly group = new Group();
    readonly pos = new Vector3();
    up = 0;
    raised = false;
    timer = 0;
    downAt = -99;
    raisedAt = 0;
    private plate = new Group();
    private railT = 0;
    private railDir = 1;
    private boxes: Hitbox[] = (["head", "torso"] as Zone[]).map(zone => ({ zone, box: { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 } }));

    constructor(spot: Vec, readonly rail: [Vec, Vec] | null, readonly label: string) {
        this.pos.set(spot.x, 0, spot.z);
        part(this.group, M.post, 0.06, 0.25, 0.06, 0, 0.125, 0);
        part(this.plate, M.steel, 0.52, 0.78, 0.04, 0, 0.39, 0);
        part(this.plate, M.steelHead, 0.26, 0.27, 0.04, 0, 0.93, 0);
        this.plate.position.y = 0.25;
        this.group.add(this.plate);
        this.group.position.copy(this.pos);
        this.plate.rotation.x = -Math.PI / 2;
    }

    get hittable(): boolean { return this.raised && this.up > 0.85; }

    raise(duration: number): void {
        this.raised = true;
        this.timer = duration;
    }

    drop(now: number): void {
        this.raised = false;
        this.downAt = now;
    }

    hitboxes(): Hitbox[] {
        const p = this.pos;
        const set = (b: Box, hw: number, y0: number, y1: number) => {
            b.minX = p.x - hw; b.maxX = p.x + hw; b.minZ = p.z - 0.04; b.maxZ = p.z + 0.04; b.minY = y0; b.maxY = y1;
        };
        set(this.boxes[0].box, 0.13, 1.045, 1.315);
        set(this.boxes[1].box, 0.26, 0.25, 1.03);
        return this.boxes;
    }

    /** Returns true when the target timed out while raised (a miss). */
    update(dt: number, now: number): boolean {
        this.up += ((this.raised ? 1 : 0) - this.up) * Math.min(1, dt * 9);
        this.plate.rotation.x = -(1 - this.up) * Math.PI / 2;
        if (this.rail) {
            const [a, b] = this.rail, len = Math.hypot(b.x - a.x, b.z - a.z);
            this.railT += this.railDir * dt * 2.4 / len;
            if (this.railT > 1 || this.railT < 0) { this.railDir *= -1; this.railT = Math.min(1, Math.max(0, this.railT)); }
            this.pos.set(a.x + (b.x - a.x) * this.railT, 0, a.z + (b.z - a.z) * this.railT);
            this.group.position.copy(this.pos);
        }
        if (!this.raised) return false;
        this.timer -= dt;
        if (this.timer > 0) return false;
        this.drop(now);
        return true;
    }
}
