// Stop-motion GIF recorder for README demos. It drives a Playwright page and captures a frame only when something
// worth seeing happens, holding each frame for as long as the viewer should look at it. Waiting (chat replies,
// network) is simply not captured, so the GIF is naturally "edited" and small.
//
// Needs (not project dependencies): npm i --no-save playwright-core sharp gifenc pngjs
import { writeFileSync } from "node:fs";

const CURSOR_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22"><path d="M3 2l14 9.5-6.2 1.2 3.7 7.1-2.6 1.3-3.6-7.2L3.5 18z" fill="#fff" stroke="#1f2328" stroke-width="1.4" stroke-linejoin="round"/></svg>';

/** Overlay (cursor, click ripple, caption) injected into every page; never intercepts events. */
export const overlayScript = `(() => {
  const init = () => {
    if (document.getElementById("demo-cursor")) return;
    const st = document.createElement("style");
    st.textContent = \`
      #demo-cursor { position: fixed; z-index: 2147483647; left: 0; top: 0; width: 22px; height: 22px; pointer-events: none; transform: translate(-3px, -2px); filter: drop-shadow(0 1px 1.5px rgba(0,0,0,.35)); }
      #demo-ripple { position: fixed; z-index: 2147483646; width: 30px; height: 30px; margin: -15px 0 0 -15px; border-radius: 50%; pointer-events: none; background: rgba(9,105,218,.28); box-shadow: 0 0 0 2px rgba(9,105,218,.55); opacity: 0; }
      #demo-caption { position: fixed; z-index: 2147483645; left: 50%; bottom: 18px; transform: translateX(-50%); max-width: 80%; padding: 8px 16px; border-radius: 999px; pointer-events: none;
        font: 600 14px/20px -apple-system, "Segoe UI", sans-serif; color: #fff; background: rgba(31,35,40,.88); box-shadow: 0 6px 20px rgba(0,0,0,.22); white-space: nowrap; }
      #demo-caption:empty { display: none; }
      #demo-caption[data-pos="left"] { left: 18px; transform: none; }
      #demo-caption[data-pos="top"] { top: 64px; bottom: auto; }
      #demo-keys { display: inline-block; margin-left: 8px; padding: 0 6px; border-radius: 4px; background: rgba(255,255,255,.18); font-weight: 600; }\`;
    document.head.append(st);
    const c = document.createElement("div"); c.id = "demo-cursor"; c.innerHTML = ${JSON.stringify(CURSOR_SVG)};
    const r = document.createElement("div"); r.id = "demo-ripple";
    const cap = document.createElement("div"); cap.id = "demo-caption";
    document.body.append(c, r, cap);
    window.__demo = {
      move(x, y) { c.style.left = x + "px"; c.style.top = y + "px"; },
      ripple(x, y, on) { r.style.left = x + "px"; r.style.top = y + "px"; r.style.opacity = on ? "1" : "0"; },
      place(pos) { cap.dataset.pos = pos || ""; },
      caption(text, keys) { cap.textContent = text || ""; if (keys) { const k = document.createElement("span"); k.id = "demo-keys"; k.textContent = keys; cap.append(k); } },
      hide(on) { c.style.display = on ? "none" : ""; },
    };
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();`;

export async function createRecorder(page, { width, height } = {}) {
    const { PNG } = (await import("pngjs")).default ?? (await import("pngjs"));
    const frames = []; // { png: Buffer, delay }
    let pos = { x: width / 2, y: height / 2 };
    const demo = (fn, ...args) => page.evaluate(([f, a]) => window.__demo?.[f]?.(...a), [fn, args]);

    const rec = {
        /** Capture the current view and show it for `ms`. */
        async frame(ms = 400) {
            const png = await page.screenshot({ type: "png" });
            frames.push({ png, delay: Math.max(20, Math.round(ms)) });
        },
        /** Extend the last frame (a pause without a new capture). */
        hold(ms) {
            if (frames.length) frames.at(-1).delay += ms;
        },
        async caption(text, keys) {
            await demo("caption", text, keys);
        },
        /** Where captions sit: "" (bottom centre), "left" (bottom left) or "top", to stay clear of what's being shown. */
        async captionAt(pos) {
            await demo("place", pos);
        },
        /** Glide the cursor to (x, y) (or a locator's centre), capturing a few frames on the way. */
        async move(target, { steps = 7, frameMs = 32, offset = { x: 0, y: 0 } } = {}) {
            const to = typeof target?.boundingBox === "function" ? await centre(target, offset) : target;
            const from = { ...pos };
            for (let i = 1; i <= steps; i++) {
                const t = i / steps;
                const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2; // ease in-out
                const x = from.x + (to.x - from.x) * e;
                const y = from.y + (to.y - from.y) * e;
                await page.mouse.move(x, y);
                await demo("move", x, y);
                if (i % 2 === 0 || i === steps) await rec.frame(frameMs);
            }
            pos = to;
            return to;
        },
        /** Move to a target and click it, with a visible ripple. Modifiers: ["Control"] etc. */
        async click(target, { modifiers = [], offset, settle = 350 } = {}) {
            const at = await rec.move(target, { offset });
            for (const m of modifiers) await page.keyboard.down(m);
            await demo("ripple", at.x, at.y, true);
            await rec.frame(90);
            await page.mouse.click(at.x, at.y);
            for (const m of modifiers) await page.keyboard.up(m);
            await demo("ripple", at.x, at.y, false);
            await page.waitForTimeout(settle);
        },
        /** Type into the focused field, a few characters per frame. */
        async type(text, { perFrame = 3, frameMs = 70 } = {}) {
            for (let i = 0; i < text.length; i += perFrame) {
                await page.keyboard.type(text.slice(i, i + perFrame));
                await rec.frame(frameMs);
            }
        },
        async key(key, { settle = 350 } = {}) {
            await page.keyboard.press(key);
            await page.waitForTimeout(settle);
        },
        /** Capture frames while something animates or streams (e.g. a chat reply), until `until()` is true. */
        async watch(until, { every = 140, max = 12_000, frameMs = 110 } = {}) {
            const end = Date.now() + max;
            while (Date.now() < end) {
                await rec.frame(frameMs);
                if (await until()) return;
                await page.waitForTimeout(every);
            }
        },
        get count() {
            return frames.length;
        },
        /** A contact sheet of the frames held longest (the beats a viewer actually reads), for reviewing a take. */
        async sheet(file, { minDelay = 700, cols = 3, scale = 0.45 } = {}) {
            const sharp = (await import("sharp")).default;
            const picked = frames.filter((f) => f.delay >= minDelay);
            const meta = await sharp(picked[0].png).metadata();
            const w = Math.round(meta.width * scale);
            const h = Math.round(meta.height * scale);
            const tiles = await Promise.all(picked.map((f) => sharp(f.png).resize(w, h).png().toBuffer()));
            const rows = Math.ceil(tiles.length / cols);
            await sharp({ create: { width: cols * (w + 8) + 8, height: rows * (h + 8) + 8, channels: 3, background: "#888" } })
                .composite(tiles.map((input, i) => ({ input, left: 8 + (i % cols) * (w + 8), top: 8 + Math.floor(i / cols) * (h + 8) })))
                .png()
                .toFile(file);
        },
        /** Encode by extension: .webp (animated, via sharp) or .gif. */
        async save(file, opts = {}) {
            return file.endsWith(".webp") ? rec.saveWebp(file, opts) : rec.saveGif(file, opts);
        },
        /** Animated WebP: full colour, much smaller than GIF for long demos. */
        async saveWebp(file, { quality = 88, effort = 6 } = {}) {
            const sharp = (await import("sharp")).default;
            const out = await sharp(frames.map((f) => f.png), { join: { animated: true } })
                .webp({ quality, effort, smartSubsample: true, loop: 0, delay: frames.map((f) => f.delay) })
                .toBuffer();
            writeFileSync(file, out);
            return { frames: frames.length, bytes: out.length, seconds: frames.reduce((n, f) => n + f.delay, 0) / 1000 };
        },
        /** GIF: one global palette, and each frame after the first keeps only the pixels that changed. */
        async saveGif(file, { maxColors = 255 } = {}) {
            const { GIFEncoder, quantize, applyPalette } = await import("gifenc");
            const decoded = frames.map((f) => PNG.sync.read(f.png));
            const w = decoded[0].width;
            const h = decoded[0].height;
            // Palette from a sample of frames (stride keeps it quick; UI colours are few).
            const sample = [];
            const step = Math.max(1, Math.floor(decoded.length / 12));
            for (let i = 0; i < decoded.length; i += step) sample.push(decoded[i].data);
            const all = new Uint8Array(sample.reduce((n, d) => n + d.length, 0));
            let o = 0;
            for (const d of sample) {
                all.set(d, o);
                o += d.length;
            }
            const palette = quantize(all, maxColors, { format: "rgb565" });
            const TRANSPARENT = palette.length; // one past the colours
            const full = [...palette];
            while (full.length < 256) full.push([255, 0, 255]);
            const gif = GIFEncoder();
            let prev = null;
            decoded.forEach((img, k) => {
                const index = applyPalette(img.data, palette, "rgb565");
                let out = index;
                if (prev) {
                    out = new Uint8Array(index.length);
                    for (let i = 0; i < index.length; i++) out[i] = index[i] === prev[i] ? TRANSPARENT : index[i];
                }
                gif.writeFrame(out, w, h, { palette: k === 0 ? full : undefined, delay: frames[k].delay, transparent: k > 0, transparentIndex: TRANSPARENT, dispose: 1, repeat: 0 });
                prev = index;
            });
            gif.finish();
            writeFileSync(file, gif.bytes());
            return { frames: frames.length, bytes: gif.bytes().length, seconds: frames.reduce((n, f) => n + f.delay, 0) / 1000 };
        },
    };

    async function centre(locator, offset) {
        const b = await locator.boundingBox();
        if (!b) throw new Error("demo: target not visible");
        return { x: b.x + b.width / 2 + (offset?.x ?? 0), y: b.y + b.height / 2 + (offset?.y ?? 0) };
    }
    await demo("move", pos.x, pos.y);
    return rec;
}
