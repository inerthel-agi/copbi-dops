import {
    AdditiveBlending, BufferAttribute, BufferGeometry, InstancedMesh, LineBasicMaterial, LineSegments, MeshBasicMaterial,
    Object3D, PlaneGeometry, Points, PointsMaterial, Scene, Vector3
} from "three";
import { Rng } from "./rules";
import { bulletHoleTexture } from "./textures";

const TRACERS = 32, PARTICLES = 320, DECALS = 120;

/** Pooled tracers, impact particles and bullet holes: one draw call each. */
export class Effects {
    private tracerPos = new Float32Array(TRACERS * 6);
    private tracerCol = new Float32Array(TRACERS * 6);
    private tracerLife = new Float32Array(TRACERS);
    private tracerRgb = new Float32Array(TRACERS * 3);
    private tracerNext = 0;
    private tracers: LineSegments;

    private pPos = new Float32Array(PARTICLES * 3);
    private pCol = new Float32Array(PARTICLES * 4); // RGBA: alpha fades the particle out
    private pVel = new Float32Array(PARTICLES * 3);
    private pLife = new Float32Array(PARTICLES);
    private pRgb = new Float32Array(PARTICLES * 3);
    private pNext = 0;
    private particles: Points;

    private decals: InstancedMesh;
    private decalNext = 0;
    private dummy = new Object3D();

    constructor(scene: Scene, private r: Rng) {
        const tg = new BufferGeometry();
        tg.setAttribute("position", new BufferAttribute(this.tracerPos, 3));
        tg.setAttribute("color", new BufferAttribute(this.tracerCol, 3));
        this.tracers = new LineSegments(tg, new LineBasicMaterial({ vertexColors: true, transparent: true, blending: AdditiveBlending, depthWrite: false }));
        this.tracers.frustumCulled = false;
        scene.add(this.tracers);

        this.pPos.fill(-999);
        const pg = new BufferGeometry();
        pg.setAttribute("position", new BufferAttribute(this.pPos, 3));
        pg.setAttribute("color", new BufferAttribute(this.pCol, 4));
        this.particles = new Points(pg, new PointsMaterial({ size: 0.07, vertexColors: true, transparent: true, depthWrite: false }));
        this.particles.frustumCulled = false;
        scene.add(this.particles);

        this.decals = new InstancedMesh(new PlaneGeometry(0.11, 0.11), new MeshBasicMaterial({
            map: bulletHoleTexture(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4,
        }), DECALS);
        this.decals.count = 0;
        this.decals.frustumCulled = false;
        scene.add(this.decals);
    }

    tracer(from: Vector3, to: Vector3, rgb: [number, number, number]): void {
        const i = this.tracerNext;
        this.tracerNext = (i + 1) % TRACERS;
        // Draw only the far 85 % so the line does not start inside the camera.
        this.tracerPos.set([from.x + (to.x - from.x) * 0.15, from.y + (to.y - from.y) * 0.15, from.z + (to.z - from.z) * 0.15, to.x, to.y, to.z], i * 6);
        this.tracerLife[i] = 1;
        this.tracerRgb.set(rgb, i * 3);
    }

    impact(p: Vector3, nx: number, ny: number, nz: number, rgb: [number, number, number], count: number, decal: boolean): void {
        for (let k = 0; k < count; k++) {
            const i = this.pNext;
            this.pNext = (i + 1) % PARTICLES;
            this.pPos.set([p.x, p.y, p.z], i * 3);
            const s = 1.5 + this.r() * 2.5;
            this.pVel.set([(nx + (this.r() - 0.5) * 1.6) * s, (ny + this.r() * 0.9) * s, (nz + (this.r() - 0.5) * 1.6) * s], i * 3);
            this.pLife[i] = 0.35 + this.r() * 0.35;
            this.pRgb.set(rgb, i * 3);
        }
        if (!decal) return;
        const d = this.dummy;
        d.position.set(p.x + nx * 0.012, p.y + ny * 0.012, p.z + nz * 0.012);
        d.lookAt(p.x + nx, p.y + ny, p.z + nz);
        d.rotateZ(this.r() * Math.PI * 2);
        d.scale.setScalar(0.7 + this.r() * 0.6);
        d.updateMatrix();
        this.decals.setMatrixAt(this.decalNext, d.matrix);
        this.decalNext = (this.decalNext + 1) % DECALS;
        this.decals.count = Math.min(DECALS, this.decals.count + 1);
        this.decals.instanceMatrix.needsUpdate = true;
    }

    update(dt: number): void {
        for (let i = 0; i < TRACERS; i++) {
            const l = this.tracerLife[i] = Math.max(0, this.tracerLife[i] - dt / 0.08);
            for (let v = 0; v < 2; v++) {
                const fade = l * (v ? 1 : 0.35);
                for (let c = 0; c < 3; c++) this.tracerCol[i * 6 + v * 3 + c] = this.tracerRgb[i * 3 + c] * fade;
            }
        }
        this.tracers.geometry.getAttribute("color").needsUpdate = true;
        this.tracers.geometry.getAttribute("position").needsUpdate = true;

        for (let i = 0; i < PARTICLES; i++) {
            if (this.pLife[i] <= 0) continue;
            this.pLife[i] -= dt;
            const j = i * 3;
            if (this.pLife[i] <= 0) {
                this.pPos[j + 1] = -999;
                continue;
            }
            this.pVel[j + 1] -= 9 * dt;
            this.pPos[j] += this.pVel[j] * dt;
            this.pPos[j + 1] += this.pVel[j + 1] * dt;
            this.pPos[j + 2] += this.pVel[j + 2] * dt;
            const c = i * 4;
            this.pCol[c] = this.pRgb[j];
            this.pCol[c + 1] = this.pRgb[j + 1];
            this.pCol[c + 2] = this.pRgb[j + 2];
            this.pCol[c + 3] = Math.min(1, this.pLife[i] * 3);
        }
        this.particles.geometry.getAttribute("position").needsUpdate = true;
        this.particles.geometry.getAttribute("color").needsUpdate = true;
    }

    clear(): void {
        this.tracerLife.fill(0);
        this.pLife.fill(0);
        this.pPos.fill(-999);
        this.decals.count = 0;
        this.decalNext = 0;
    }
}
