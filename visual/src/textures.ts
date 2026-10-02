import { CanvasTexture, RepeatWrapping, SRGBColorSpace } from "three";
import { rng, Rng } from "./rules";

type RGB = [number, number, number];
const FONT = "Bahnschrift, 'Arial Narrow', sans-serif";

function canvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
    const c = document.createElement("canvas");
    c.width = c.height = size;
    return [c, c.getContext("2d")];
}

const smooth = (t: number) => t * t * (3 - 2 * t);

/** Tileable multi-octave value noise in ~[0, 1]. periods must divide size. */
function fbm(size: number, r: Rng, periods = [4, 8, 16, 32], weights = [0.5, 0.25, 0.15, 0.1]): Float32Array {
    const out = new Float32Array(size * size);
    periods.forEach((p, o) => {
        const g = Float32Array.from({ length: p * p }, () => r());
        const cell = size / p;
        for (let y = 0; y < size; y++) {
            const gy = y / cell, y0 = Math.floor(gy), fy = smooth(gy - y0), ya = (y0 % p) * p, yb = ((y0 + 1) % p) * p;
            for (let x = 0; x < size; x++) {
                const gx = x / cell, x0 = Math.floor(gx), fx = smooth(gx - x0), xa = x0 % p, xb = (x0 + 1) % p;
                const top = g[ya + xa] + (g[ya + xb] - g[ya + xa]) * fx;
                const bot = g[yb + xa] + (g[yb + xb] - g[yb + xa]) * fx;
                out[y * size + x] += weights[o] * (top + (bot - top) * fy);
            }
        }
    });
    return out;
}

/** Fills the canvas with base color modulated per pixel by f(index) (1 = base color). */
function shade(ctx: CanvasRenderingContext2D, size: number, base: RGB, f: (i: number, x: number, y: number) => number): void {
    const img = ctx.createImageData(size, size);
    for (let i = 0, y = 0; y < size; y++) {
        for (let x = 0; x < size; x++, i++) {
            const k = f(i, x, y);
            img.data[i * 4] = base[0] * k;
            img.data[i * 4 + 1] = base[1] * k;
            img.data[i * 4 + 2] = base[2] * k;
            img.data[i * 4 + 3] = 255;
        }
    }
    ctx.putImageData(img, 0, 0);
}

function blobs(ctx: CanvasRenderingContext2D, r: Rng, size: number, count: number, color: string, minR: number, maxR: number): void {
    ctx.fillStyle = color;
    for (let i = 0; i < count; i++) {
        const x = r() * size, y = r() * size, rad = minR + r() * (maxR - minR);
        ctx.beginPath();
        for (let a = 0; a < 7; a++) {
            const ang = a / 7 * Math.PI * 2, rr = rad * (0.6 + r() * 0.5);
            ctx.lineTo(x + Math.cos(ang) * rr, y + Math.sin(ang) * rr);
        }
        ctx.fill();
    }
}

function texture(c: HTMLCanvasElement): CanvasTexture {
    const t = new CanvasTexture(c);
    t.colorSpace = SRGBColorSpace;
    t.wrapS = t.wrapT = RepeatWrapping;
    t.anisotropy = 4;
    return t;
}

export function groundTexture(): CanvasTexture {
    const size = 512, r = rng(11), [c, ctx] = canvas(size);
    const n = fbm(size, r), m = fbm(size, r, [2, 4], [0.6, 0.4]);
    shade(ctx, size, [122, 112, 86], i => 0.78 + n[i] * 0.4 - (m[i] > 0.55 ? (m[i] - 0.55) * 0.6 : 0));
    for (let i = 0; i < 1400; i++) {
        const v = 70 + r() * 90;
        ctx.fillStyle = `rgba(${v},${v * 0.94},${v * 0.78},0.55)`;
        ctx.fillRect(r() * size, r() * size, 1 + r() * 2, 1 + r() * 2);
    }
    return texture(c);
}

export function concreteTexture(): CanvasTexture {
    const size = 256, r = rng(12), [c, ctx] = canvas(size);
    const n = fbm(size, r);
    shade(ctx, size, [140, 139, 126], i => 0.8 + n[i] * 0.35);
    for (let i = 0; i < 26; i++) {
        const x = r() * size, w = 2 + r() * 8, len = 30 + r() * 120;
        const g = ctx.createLinearGradient(0, 0, 0, len);
        g.addColorStop(0, `rgba(40,38,30,${0.08 + r() * 0.1})`);
        g.addColorStop(1, "rgba(40,38,30,0)");
        ctx.fillStyle = g;
        ctx.fillRect(x, 0, w, len);
    }
    ctx.fillStyle = "rgba(30,30,26,0.45)";
    ctx.fillRect(0, 0, size, 2);
    ctx.fillRect(0, 0, 2, size);
    ctx.fillStyle = "rgba(255,255,240,0.12)";
    ctx.fillRect(0, 2, size, 1);
    for (const [x, y] of [[64, 64], [192, 64], [64, 192], [192, 192]]) {
        ctx.fillStyle = "rgba(25,25,20,0.55)";
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fill();
    }
    return texture(c);
}

export function plasterTexture(): CanvasTexture {
    const size = 256, r = rng(13), [c, ctx] = canvas(size);
    const n = fbm(size, r);
    shade(ctx, size, [166, 154, 120], (i, _x, y) => (0.84 + n[i] * 0.28) * (y > 200 ? 1 - (y - 200) / 400 : 1));
    blobs(ctx, r, size, 22, "rgba(112,100,76,0.55)", 3, 10);
    ctx.strokeStyle = "rgba(60,54,40,0.5)";
    ctx.lineWidth = 1;
    for (let i = 0; i < 6; i++) {
        let x = r() * size, y = r() * size;
        ctx.beginPath();
        ctx.moveTo(x, y);
        for (let s = 0; s < 12; s++) {
            x += (r() - 0.5) * 14;
            y += 4 + r() * 8;
            ctx.lineTo(x, y);
        }
        ctx.stroke();
    }
    return texture(c);
}

export function crateTexture(): CanvasTexture {
    const size = 256, r = rng(14), [c, ctx] = canvas(size);
    const n = fbm(size, r, [4, 8, 16, 64], [0.4, 0.25, 0.2, 0.15]);
    shade(ctx, size, [116, 95, 62], (i, _x, y) => 0.8 + n[i] * 0.3 + 0.06 * Math.sin(y * 0.8 + n[i] * 14) - (y % 64 < 2 ? 0.35 : 0));
    ctx.strokeStyle = "rgba(52,40,24,0.95)";
    ctx.lineWidth = 18;
    ctx.strokeRect(9, 9, size - 18, size - 18);
    ctx.lineWidth = 14;
    ctx.beginPath();
    ctx.moveTo(18, 18);
    ctx.lineTo(size - 18, size - 18);
    ctx.stroke();
    ctx.fillStyle = "rgba(30,28,22,0.6)";
    ctx.font = `bold 30px ${FONT}`;
    ctx.fillText("SL-07", 40, 210);
    ctx.font = `bold 15px ${FONT}`;
    ctx.fillText("LOT 24 / HANDLE WITH CARE", 40, 232);
    return texture(c);
}

/** Corrugated steel, neutral grey so each container material can tint it. */
export function containerTexture(): CanvasTexture {
    const size = 256, r = rng(15), [c, ctx] = canvas(size);
    const n = fbm(size, r);
    shade(ctx, size, [150, 150, 142], (i, x) => 0.78 + n[i] * 0.22 + 0.16 * Math.sin(x / size * Math.PI * 2 * 12));
    blobs(ctx, r, size, 16, "rgba(110,72,44,0.35)", 2, 9);
    ctx.fillStyle = "rgba(20,20,18,0.5)";
    ctx.fillRect(0, 0, size, 3);
    ctx.fillRect(0, size - 3, size, 3);
    return texture(c);
}

/** Concrete low wall with a faded hazard band on the top fifth (v = 1 is the top edge). */
export function barrierTexture(): CanvasTexture {
    const size = 256, r = rng(16), [c, ctx] = canvas(size);
    const n = fbm(size, r);
    shade(ctx, size, [152, 150, 136], i => 0.8 + n[i] * 0.3);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 10, size, 40);
    ctx.clip();
    for (let x = -64; x < size + 64; x += 32) {
        ctx.fillStyle = (x / 32) % 2 === 0 ? "rgba(196,110,46,0.8)" : "rgba(38,38,34,0.8)";
        ctx.beginPath();
        ctx.moveTo(x, 10);
        ctx.lineTo(x + 32, 10);
        ctx.lineTo(x + 72, 50);
        ctx.lineTo(x + 40, 50);
        ctx.fill();
    }
    ctx.restore();
    return texture(c);
}

export function bulletHoleTexture(): CanvasTexture {
    const [c, ctx] = canvas(32);
    const g = ctx.createRadialGradient(16, 16, 1, 16, 16, 15);
    g.addColorStop(0, "rgba(10,10,8,1)");
    g.addColorStop(0.35, "rgba(25,23,18,0.9)");
    g.addColorStop(1, "rgba(40,36,28,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 32, 32);
    const t = new CanvasTexture(c);
    t.colorSpace = SRGBColorSpace;
    return t;
}

export function flashTexture(): CanvasTexture {
    const [c, ctx] = canvas(64);
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, "rgba(255,250,220,1)");
    g.addColorStop(0.25, "rgba(255,190,90,0.9)");
    g.addColorStop(1, "rgba(255,120,30,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    const t = new CanvasTexture(c);
    t.colorSpace = SRGBColorSpace;
    return t;
}
