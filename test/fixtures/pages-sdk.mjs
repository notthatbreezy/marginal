import { createGitHub } from "../../extensions/marginal/lib/prs/github.mjs";
import { fakeClock, fakeWorld } from "../../tools/demos/fake-github.mjs";

export const harness = {
    canvas: null, registration: null, servers: [], callbacks: new Set(), sent: [], calls: [],
    modules: new Map(), service: null, watcher: null, missionStop: null, armed: false,
};
harness.clock = fakeClock();
harness.world = fakeWorld({ clock: harness.clock.now });
harness.gh = createGitHub({ exec: harness.world.exec, env: {} });

export class CanvasError extends Error {
    constructor(code, message) { super(message); this.code = code; }
}
export const createCanvas = (config) => (harness.canvas = config);
export async function joinSession(config) {
    harness.registration = config;
    return {
        sessionId: "session-page-tests",
        send: async (message) => (harness.sent.push(message), `msg-discuss-${harness.sent.length}`),
        on: (callback) => (harness.callbacks.add(callback), () => harness.callbacks.delete(callback)),
        log: (message) => { throw new Error(message); },
    };
}
export function emit(event) { for (const callback of harness.callbacks) callback(event); }
export function observed(name, args) {
    if (harness.armed) harness.calls.push({ name, args });
}
export function options(name, args) {
    return name === "createPrService" ? [{ ...args[0], gh: harness.gh, clock: harness.clock }] : args;
}
export function captured(name, result) {
    if (name === "createPrService") harness.service = result;
    if (name === "createWatcher") {
        harness.watcher = result;
        for (const name of ["unwatch", "stopAll"]) {
            const original = result[name];
            result[name] = function (...args) { observed(`prs.${name}`, args); return original.apply(this, args); };
        }
    }
    if (name === "attachMission") harness.missionStop = result;
    if (name === "startServer") result.then((server) => harness.servers.push(server), () => {});
    return result;
}
export function loaded(url) {
    harness.modules.set(url, (harness.modules.get(url) ?? 0) + 1);
}
export function observeHooks(hooks, name) {
    const originals = [...hooks];
    hooks.splice(0, hooks.length, ...originals.map((fn) => function (...args) {
        observed(name, args);
        return fn.apply(this, args);
    }));
    return () => hooks.splice(0, hooks.length, ...originals);
}
