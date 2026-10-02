// Run: node test/rules.test.mts (Node >= 23 strips TypeScript types natively).
// Pins the damage model that the DAX columns of the Arsenal page mirror.
import assert from "node:assert/strict";
import { rng, hash, buildWeapon, arsenalStats, hitDamage, sanitize, kindOf, DEFAULT_ROSTER } from "../src/rules.ts";

const a = rng(42), b = rng(42);
for (let i = 0; i < 100; i++) assert.equal(a(), b());
assert.notEqual(rng(1)(), rng(2)());
assert.equal(hash("R-7 Carbine"), hash("R-7 Carbine"));

assert.equal(sanitize({ name: "X", cls: "SMG", damage: 20, rpm: 800, mag: 30, pen: 45, recoil: 3 }).pen, 0.45);
assert.equal(kindOf("Sub-machine gun"), "smg");
assert.equal(kindOf("Whatever"), "assault");
assert.deepEqual(buildWeapon(DEFAULT_ROSTER[0]).pattern, buildWeapon(DEFAULT_ROSTER[0]).pattern);

const stats = Object.fromEntries(DEFAULT_ROSTER.map(r => [r.name, arsenalStats(r)]));
const expected: Record<string, [number, number, boolean]> = {
    // shots to kill (armored body), TTK ms, helmet one-shot
    "R-7 Carbine": [5, 333, false],
    "Kestrel AR": [4, 300, false],
    "Hawk SMG": [7, 400, false],
    "Moth PDW": [7, 360, false],
    "Longshot": [2, 1333, true],
    "Talon DMR": [2, 250, true],
    "Ward-9": [6, 750, false],
    "Brute": [2, 857, true],
};
for (const [name, [stk, ttk, one]] of Object.entries(expected)) {
    assert.deepEqual([stats[name].shotsToKill, stats[name].ttkMs, stats[name].helmetOneShot], [stk, ttk, one], name);
}
// Armor pen decides the helmet one-shot: same rifle, pen 45 % vs 100 %.
assert.ok(hitDamage({ damage: 50, pen: 0.45 }, "head", true) < 100);
assert.ok(hitDamage({ damage: 50, pen: 1 }, "head", true) >= 100);
console.log("rules: all checks passed");
