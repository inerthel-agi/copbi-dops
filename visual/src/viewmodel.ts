import {
    AdditiveBlending, DirectionalLight, DoubleSide, Group, HemisphereLight, Mesh, MeshBasicMaterial, PerspectiveCamera,
    PlaneGeometry, PMREMGenerator, Scene, WebGLRenderer
} from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { GunModel, GUNS } from "./guns";
import { Kind, Weapon } from "./rules";
import { flashTexture } from "./textures";

interface Model extends GunModel { group: Group; }

/** First-person weapon drawn in its own scene/camera on top of the world (no wall clipping). */
export class ViewModel {
    readonly scene = new Scene();
    readonly camera = new PerspectiveCamera(55, 1, 0.01, 5);
    private rig = new Group();
    private models = new Map<Kind, Model>();
    private cur: Model | null = null;
    private flash = new Group();
    private flashT = 0;
    private kickZ = 0;
    private kickR = 0;
    private swayX = 0;
    private swayY = 0;
    private pumpT = 1;

    constructor() {
        this.scene.add(new HemisphereLight(0xc8ccc0, 0x4a4636, 0.6));
        const key = new DirectionalLight(0xffe6c4, 1.6);
        key.position.set(-1, 2, 1);
        const rim = new DirectionalLight(0xb8c4d0, 0.6);
        rim.position.set(1.5, 0.5, -1);
        this.scene.add(key, rim, this.rig);
        const fm = new MeshBasicMaterial({ map: flashTexture(), transparent: true, blending: AdditiveBlending, depthWrite: false, side: DoubleSide });
        for (const ry of [0, Math.PI / 2]) {
            const p = new Mesh(new PlaneGeometry(0.09, 0.22), fm);
            p.rotation.set(Math.PI / 2, ry, 0);
            p.position.z = -0.09;
            this.flash.add(p);
        }
        this.flash.add(new Mesh(new PlaneGeometry(0.16, 0.16), fm));
        this.flash.visible = false;
    }

    /** Image-based lighting so metal parts show reflections (procedural room, no files). */
    setEnvironment(renderer: WebGLRenderer): void {
        const pmrem = new PMREMGenerator(renderer);
        this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
        this.scene.environmentIntensity = 0.55;
        pmrem.dispose();
    }

    setWeapon(w: Weapon): void {
        let m = this.models.get(w.kind);
        if (!m) {
            const group = new Group();
            m = { group, ...GUNS[w.kind](group) };
            this.models.set(w.kind, m);
        }
        this.rig.clear();
        this.rig.add(m.group, this.flash);
        this.flash.position.set(...m.muzzle);
        this.cur = m;
        this.pumpT = 1;
    }

    fire(strength: number, r: number): void {
        this.kickZ += 0.025 + strength * 0.012;
        this.kickR += 0.02 + strength * 0.012;
        this.flashT = 0.045;
        this.flash.rotation.z = r * Math.PI;
        this.flash.scale.setScalar(0.8 + r * 0.5);
        if (this.cur?.pump) this.pumpT = -0.15;
    }

    update(dt: number, s: { t: number; move: number; ads: number; sprint: number; slide: number; lookDX: number; lookDY: number; reload: number; draw: number; hidden: boolean }): void {
        const m = this.cur;
        this.rig.visible = !!m && !s.hidden;
        if (!m) return;
        // Aiming: the stock sits against the shoulder, under the eye. Clip what is closer than 16 cm so it does not fill the bottom of the screen.
        const near = 0.01 + 0.15 * s.ads;
        if (Math.abs(this.camera.near - near) > 1e-3) {
            this.camera.near = near;
            this.camera.updateProjectionMatrix();
        }
        const k = 1 - Math.exp(-dt * 12);
        this.swayX += (Math.max(-0.04, Math.min(0.04, -s.lookDX * 0.0005)) - this.swayX) * k;
        this.swayY += (Math.max(-0.04, Math.min(0.04, s.lookDY * 0.0005)) - this.swayY) * k;
        this.kickZ *= Math.exp(-dt * 14);
        this.kickR *= Math.exp(-dt * 12);
        const bob = s.move * (1 - 0.85 * s.ads) * (1 - s.slide);
        const rl = s.reload >= 0 ? Math.sin(Math.PI * s.reload) : 0;
        const lerp = (a: number, b: number) => a + (b - a) * s.ads;
        // Sliding: the gun is tucked in and canted, unless the player aims during the slide.
        const tuck = s.slide * (1 - s.ads);
        this.rig.position.set(
            lerp(m.hip[0], 0) + Math.sin(s.t * 9) * 0.008 * bob + this.swayX * (1 - s.ads * 0.7) - tuck * 0.03,
            lerp(m.hip[1], 0) - Math.abs(Math.cos(s.t * 9)) * 0.008 * bob + this.swayY - rl * 0.08 - (1 - s.draw) * 0.25 - s.sprint * 0.04 + tuck * 0.02,
            lerp(m.hip[2], m.adsZ) + this.kickZ + tuck * 0.03);
        // At the hip the gun is yawed slightly inward so its flank shows, like a held weapon.
        this.rig.rotation.set(
            this.kickR - rl * 0.6 - s.sprint * 0.25,
            this.swayX * 2 + s.sprint * 0.6 + 0.09 * (1 - s.ads) + tuck * 0.15,
            rl * 0.3 + s.sprint * 0.2 + tuck * 0.45);

        this.flashT -= dt;
        this.flash.visible = this.flashT > 0;
        if (m.pump) {
            this.pumpT = Math.min(1, this.pumpT + dt / 0.45);
            m.pump.position.z = this.pumpT > 0 && this.pumpT < 1 ? Math.sin(Math.PI * this.pumpT) * 0.08 : 0;
        }
    }

    resize(aspect: number): void {
        this.camera.aspect = aspect;
        this.camera.updateProjectionMatrix();
    }
}
