// Where the chat window sits: a box {x, y, w, h} in CSS pixels, placed by its top-left corner. Pure, so it's tested
// in node (test/command.web.test.mjs) and used by app.js.
export const MIN_W = 280;
export const MIN_H = 220;

/** The size and place a first-time chat opens at: bottom right, 420 × 520 where there's room. */
export const defaultBox = (vw, vh) => ({ x: null, y: null, w: Math.min(420, vw - 40), h: Math.min(520, vh - 100) });

/** Fit a box to a viewport: never bigger than it, never partly outside it. Unset x/y sit at the bottom right. */
export function fitBox(b, vw, vh) {
    const w = Math.round(Math.max(Math.min(MIN_W, vw), Math.min(b.w, vw)));
    const h = Math.round(Math.max(Math.min(MIN_H, vh), Math.min(b.h, vh)));
    const x = b.x ?? vw - w - 20;
    const y = b.y ?? vh - h - 20;
    return { x: Math.round(Math.max(0, Math.min(x, vw - w))), y: Math.round(Math.max(0, Math.min(y, vh - h))), w, h };
}

/** A drag of the bar by (dx, dy) from where it started: only moves, never resizes. */
export const dragBox = (start, dx, dy, vw, vh) => fitBox({ ...start, x: start.x + dx, y: start.y + dy }, vw, vh);

/** A drag of the corner handle: only resizes, keeping the top-left where it is and the window in view. */
export const resizeBox = (start, dx, dy, vw, vh) => fitBox({ x: start.x, y: start.y, w: Math.max(MIN_W, Math.min(start.w + dx, vw - start.x)), h: Math.max(MIN_H, Math.min(start.h + dy, vh - start.y)) }, vw, vh);
