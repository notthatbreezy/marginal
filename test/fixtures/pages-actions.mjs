import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const loader = new URL("./pages-loader.mjs", import.meta.url).href;
const worker = new URL("./pages-worker.mjs", import.meta.url).href;

/** Each real extension/server has a fresh module cache and only an owned synthetic data root. */
export async function actionProbe(root, scenario) {
    const child = spawn(process.execPath, ["--experimental-loader", loader, fileURLToPath(worker)], {
        cwd: fileURLToPath(new URL("../../", import.meta.url)),
        env: { ...process.env, MARGINAL_DATA_DIR: root, MARGINAL_NO_BROWSER: "1" },
        stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true,
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => stdout += chunk);
    child.stderr.on("data", (chunk) => stderr += chunk);
    const timeout = setTimeout(() => child.kill(), 60_000);
    try {
        let report;
        const code = await new Promise((resolve, reject) => {
            child.on("error", reject);
            child.on("close", resolve);
            child.on("message", (message) => {
                if (message.kind === "ready") child.send(scenario, (error) => { if (error) reject(error); });
                else if (message.kind === "result") report = message.value;
            });
        });
        assert.equal(code, 0, stdout + stderr);
        assert.ok(report, "worker must report after real cleanup");
        return report;
    } finally { clearTimeout(timeout); }
}
