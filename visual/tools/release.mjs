// npm run package: bump the visual version, build the .pbiviz, then embed it in the PBIP report as
// CustomVisuals/<guid>/package.json + resources/<guid>.pbiviz.json (the unzipped .pbiviz), so the
// report opens with the visual without importing anything.
// Power BI Desktop caches custom visuals by GUID + version: every rebuild needs a new version, and
// Desktop must be restarted (reopen the .pbip) to pick it up.
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { inflateRawSync } from "node:zlib";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const visualDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const reportDir = join(visualDir, "..", "copbi-dops.Report");
const cfgPath = join(visualDir, "pbiviz.json");
const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));

const parts = cfg.visual.version.split(".").map(Number);
parts[3]++;
cfg.visual.version = cfg.version = parts.join(".");
writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");

execSync("npx pbiviz package", { cwd: visualDir, stdio: "inherit" });

const guid = cfg.visual.guid;
const target = join(reportDir, "CustomVisuals", guid);
rmSync(target, { recursive: true, force: true });
for (const [name, data] of unzip(readFileSync(join(visualDir, "dist", `${guid}.${cfg.visual.version}.pbiviz`)))) {
    const p = join(target, name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, data);
}
console.log(`Embedded ${guid} v${cfg.visual.version} in ${target}`);
execSync("node tools/standalone.mjs", { cwd: visualDir, stdio: "inherit" });

/** Minimal zip reader (central directory + deflate), enough for a .pbiviz. */
function unzip(buf) {
    let eocd = buf.length - 22;
    while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
    if (eocd < 0) throw new Error("not a zip file");
    const files = [];
    for (let i = 0, p = buf.readUInt32LE(eocd + 16); i < buf.readUInt16LE(eocd + 10); i++) {
        const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20);
        const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
        const local = buf.readUInt32LE(p + 42), name = buf.toString("utf8", p + 46, p + 46 + nameLen);
        const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
        const raw = buf.subarray(start, start + size);
        if (!name.endsWith("/")) files.push([name, method === 8 ? inflateRawSync(raw) : raw]);
        p += 46 + nameLen + extraLen + commentLen;
    }
    return files;
}
