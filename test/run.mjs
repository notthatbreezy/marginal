// Run node --test on the given files with a hard timeout; report whether the process exited on its own.
import { spawn } from "node:child_process";

const [timeoutMs, ...files] = process.argv.slice(2);
const t0 = Date.now();
const child = spawn(process.execPath, ["--test", ...files], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
let out = "";
child.stdout.on("data", (b) => (out += b));
child.stderr.on("data", (b) => (out += b));
const timer = setTimeout(() => {
    console.log(`HUNG: still running after ${timeoutMs} ms`);
    child.kill();
}, Number(timeoutMs));
child.on("close", (code) => {
    clearTimeout(timer);
    const lines = out.split(/\r?\n/).filter((l) => /^(ℹ (tests|pass|fail)|✖|not ok)/.test(l) || /Error|expected|actual/.test(l));
    console.log(lines.slice(0, 40).join("\n"));
    console.log(`exit ${code} after ${Math.round((Date.now() - t0) / 1000)} s`);
});
