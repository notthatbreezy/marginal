// Settings for a watched PR, and the handling ladder. The ladder is stored as its last step, so the steps before it
// are on by construction: there's no way to represent "push & resolve without remediate".
import { InputError } from "../errors.mjs";

/** Handling steps in order; each includes the ones before it. "none" means Do nothing (just show). */
export const STEPS = ["read", "assess", "remediate", "localReview", "pushResolve"];
export const LEVELS = ["none", ...STEPS];
export const STEP_LABEL = { read: "Read", assess: "Assess", remediate: "Remediate", localReview: "Local review", pushResolve: "Push & resolve" };
export const DELIVER = ["queue", "interrupt"];

export const DEFAULT_SETTINGS = Object.freeze({ watch: true, handle: "read", deliver: "queue" });

/** Does this level include that step? */
export const includes = (level, step) => step !== "none" && LEVELS.indexOf(level) >= LEVELS.indexOf(step);

/** Levels at which Copilot gets a turn (Read is Marginal's alone). */
export const needsAgent = (level) => LEVELS.indexOf(level) >= LEVELS.indexOf("assess");

/**
 * A level from either form the API accepts: {handle:"assess"} or {steps:["read","assess"]}. A list of steps must be a
 * prefix of the ladder; a gap is refused rather than guessed at.
 */
export function parseHandle(input) {
    if (input.handle !== undefined) {
        if (!LEVELS.includes(input.handle)) throw new InputError(`handle must be one of ${LEVELS.join(", ")}.`);
        return input.handle;
    }
    if (input.steps !== undefined) {
        if (!Array.isArray(input.steps) || input.steps.some((s) => !STEPS.includes(s))) throw new InputError(`steps must be a list of ${STEPS.join(", ")}.`);
        const on = new Set(input.steps);
        const prefix = STEPS.slice(0, on.size);
        const missing = prefix.find((s) => !on.has(s));
        if (missing) {
            const last = [...on].sort((a, b) => STEPS.indexOf(b) - STEPS.indexOf(a))[0];
            throw new InputError(`Handling steps build on each other: ${STEP_LABEL[last]} needs ${STEP_LABEL[missing]} too.`);
        }
        return on.size ? STEPS[on.size - 1] : "none";
    }
    return undefined;
}

/** Validated settings: unknown keys dropped, defaults filled in. */
export function normalizeSettings(s = {}) {
    const out = { ...DEFAULT_SETTINGS };
    if (typeof s.watch === "boolean") out.watch = s.watch;
    if (LEVELS.includes(s.handle)) out.handle = s.handle;
    if (DELIVER.includes(s.deliver)) out.deliver = s.deliver;
    return out;
}

/** Apply a partial update from the panel or an agent. Throws InputError on anything invalid; changes nothing then. */
export function updateSettings(current, patch = {}) {
    const next = normalizeSettings(current);
    if (patch.watch !== undefined) {
        if (typeof patch.watch !== "boolean") throw new InputError("watch must be true or false.");
        next.watch = patch.watch;
    }
    const level = parseHandle(patch);
    if (level !== undefined) next.handle = level;
    if (patch.deliver !== undefined) {
        if (!DELIVER.includes(patch.deliver)) throw new InputError(`deliver must be one of ${DELIVER.join(", ")}.`);
        next.deliver = patch.deliver;
    }
    return next;
}
