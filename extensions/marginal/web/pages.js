// Retained Home controls; primary matches and supporting collection facts share one generation.
import { h, put, api } from "./core.js";

function localDay(value, next = false) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) throw new Error("Enter a valid calendar date (YYYY-MM-DD).");
    const [, y, m, d] = match.map(Number);
    const date = new Date(0);
    date.setFullYear(y, m - 1, d);
    date.setHours(0, 0, 0, 0);
    if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) throw new Error("Enter a real calendar date.");
    if (next) date.setDate(date.getDate() + 1);
    return date.toISOString();
}

// Catalog summaries retain authored dates. Validate their calendar before formatting, including legacy forms.
function dateText(value) {
    const epoch = typeof value === "string" ? Date.parse(value) : NaN;
    if (!Number.isFinite(epoch)) return "Unknown";
    const year = (n) => n >= 0 && n <= 49 ? n + 2000 : n >= 50 && n <= 99 ? n + 1900 : n;
    let calendar;
    const iso = /^\s*([+-]\d{6}|\d{4})-(\d{2})-(\d{2})(?=$|T|\s)/.exec(value);
    if (iso) calendar = iso.slice(1).map(Number);
    else {
        const text = value.replace(/\([^)]*\)/g, "")
            .replace(/^[^a-z\d]*(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*[^a-z\d]*)?(?=\d)/i, "");
        const numeric = /^\s*(\d{1,6})[-/.,\s]+(\d{1,2})[-/.,\s]+(\d{1,6})(?=\D|$)/.exec(text);
        if (numeric) {
            const [a, b, c] = numeric.slice(1).map(Number);
            calendar = a > 31 || a === 0 || numeric[1].length >= 4 ? [year(a), b, c] : [year(c), a, b];
        } else {
            const middle = /\b(\d{1,6})[-\s,]+([a-z]+)[-\s,]+(\d{1,6})\b/i.exec(text);
            const first = /\b([a-z]+)[-\s,]+(\d{1,6})[-\s,]+(\d{1,6})\b/i.exec(text);
            const last = /\b(\d{1,6})[-\s,]+(\d{1,6})[-\s,]+([a-z]+)\b/i.exec(text);
            const candidates = [
                middle && { index: middle.index, parts: [middle[1], middle[2], middle[3]] },
                first && { index: first.index, parts: [first[2], first[1], first[3]] },
                last && { index: last.index, parts: [last[1], last[3], last[2]] },
            ].filter(Boolean).sort((a, b) => a.index - b.index);
            for (const { parts } of candidates) {
                const month = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(parts[1].slice(0, 3).toLowerCase()) + 1;
                if (!month) continue;
                const a = Number(parts[0]), b = Number(parts[2]);
                calendar = a > 31 || a === 0 || parts[0].length >= 3 ? [year(a), month, b] : [year(b), month, a];
                break;
            }
        }
    }
    if (calendar) {
        const [y, m, d] = calendar, leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
        const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
        if (!(d >= 1 && d <= days)) return "Unknown";
    }
    return new Date(epoch).toLocaleString();
}

export function createPages({ open }) {
    let active = false, generation = 0, timer, lastGood = null, explicitSort = false;
    /** @type {{type:"pending-primary"|"pending-classification"|"current"} | {type:"invalid-input",message:string} | {type:"error",classification:boolean,message:string}} */
    let view = { type: "pending-primary" };
    let actionError = null;
    const pending = new Set();
    const search = h("input", { id: "pages-query", type: "search", placeholder: "Search titles and page text", "aria-label": "Search pages" });
    const select = (id, label, options) => h("select", { id, "aria-label": label }, options.map(([value, text]) => h("option", { value }, text)));
    const status = select("pages-scope", "Page status", [["active", "Active"], ["archived", "Archived"], ["all", "All"]]);
    const sort = select("pages-sort", "Sort pages", [["updated-desc", "Updated · newest"], ["updated-asc", "Updated · oldest"], ["created-desc", "Created · newest"], ["created-asc", "Created · oldest"], ["relevance", "Relevance"]]);
    const dateField = select("pages-date-field", "Date field", [["updated", "Updated"], ["created", "Created"]]);
    const from = h("input", { id: "pages-from", type: "date", "aria-label": "From date" });
    const through = h("input", { id: "pages-through", type: "date", "aria-label": "Through date" });
    const label = (name, control) => h("label", {}, h("span", {}, name), control);
    const toolbar = h("div", { class: "pages-controls", role: "search", "aria-label": "Find pages" },
        label("Search pages", search), label("Status", status), label("Sort", sort),
        label("Date field", dateField), label("From", from), label("Through", through));
    const pad = h("div", { id: "pages-scratchpad" });
    const notice = h("div", { id: "pages-status", role: "status", "aria-live": "polite" });
    const results = h("div", { id: "pages-results" });
    const root = h("div", { class: "doc home" }, h("h2", {}, "Scratchpad"), pad, h("h2", {}, "Pages"), toolbar, notice, results);
    const ordinary = (docs) => docs.filter((doc) => doc.kind !== "scratchpad");
    const controls = () => ({ query: search.value, status: status.value, sort: sort.value, dateField: dateField.value, from: from.value, through: through.value });
    function card(doc, scratchpad = false) {
        return h("div", { class: "card", "data-document-id": doc.documentId },
            h("button", { class: "page-open grow", type: "button", onclick: () => open(doc.documentId) },
                h("span", { class: "t" }, doc.title),
                h("span", { class: "m" }, [doc.repository, doc.pullRequest ? `PR ${doc.pullRequest.url.split("/").pop()}` : null, `${doc.blocks} blocks`, `Updated: ${dateText(doc.updatedAt)}`].filter(Boolean).join(" · "))),
            doc.archivedAt ? h("span", { class: "badge archived" }, "Archived") : null,
            doc.activity?.length ? h("span", { class: "badge live" }, "live") : null,
            !scratchpad && h("button", { type: "button", class: "page-archive", disabled: pending.has(doc.documentId),
                "aria-label": `${doc.archivedAt ? "Unarchive" : "Archive"} ${doc.title}`,
                onclick: (event) => { event.stopPropagation(); mutate(doc); } }, doc.archivedAt ? "Unarchive" : "Archive"));
    }
    function paint() {
        root.dataset.state = view.type;
        const previous = view.type !== "current";
        let message = view.type === "current" ? lastGood.message
            : view.type === "pending-primary" ? "Loading pages…"
            : view.type === "pending-classification" ? "Checking collection and scope…"
            : view.type === "invalid-input" ? `Invalid date range: ${view.message}`
            : `${view.classification ? "Classification unavailable" : "Couldn't load pages"}: ${view.message}`;
        if (previous && lastGood) message += ` Previous results — ${lastGood.message} (${lastGood.provenance}).`;
        put(notice, message,
            view.type === "error" && h("button", { type: "button", onclick: () => refresh() }, "Retry"),
            actionError && h("div", { class: "error", role: "alert" }, actionError.message, " ",
                h("button", { type: "button", onclick: () => mutate(actionError.doc) }, "Retry action")));
        results.dataset.previous = String(previous);
        put(results, lastGood?.docs.map((doc) => card(doc)) ?? []);
    }
    function query() {
        const raw = { status: status.value };
        if (search.value.trim()) raw.query = search.value;
        if (sort.value === "relevance") {
            if (!raw.query) throw new Error("Relevance requires search text.");
            raw.sort = "relevance";
        } else [raw.sort, raw.direction] = sort.value.split("-");
        if (from.validity.badInput || through.validity.badInput) throw new Error("Enter a complete calendar date.");
        if (from.value || through.value) {
            raw.dateField = dateField.value;
            if (from.value) raw.from = localDay(from.value);
            if (through.value) raw.until = localDay(through.value, true);
            if (raw.from && raw.until && raw.from >= raw.until) throw new Error("Through must be on or after From.");
        }
        return raw;
    }
    function invalidate() {
        generation++;
        clearTimeout(timer);
        return generation;
    }
    async function run(mark) {
        if (!active || mark !== generation) return;
        let raw;
        try { raw = query(); }
        catch (error) { view = { type: "invalid-input", message: error.message }; paint(); return; }
        const provenance = JSON.stringify(controls());
        view = { type: "pending-primary" }; paint();
        let classification = false;
        try {
            const primary = await api(`/catalog?${new URLSearchParams(raw)}`);
            if (!active || mark !== generation) return;
            const scratchpad = primary.find((doc) => doc.kind === "scratchpad");
            put(pad, scratchpad && card(scratchpad, true));
            const docs = ordinary(primary);
            let message = `${docs.length} ${docs.length === 1 ? "page" : "pages"}`;
            if (!docs.length) {
                classification = true;
                view = { type: "pending-classification" }; paint();
                const all = raw.status === "all" && !raw.query && !raw.from && !raw.until ? primary : await api("/catalog?status=all");
                if (!active || mark !== generation) return;
                const total = ordinary(all);
                const scope = total.filter((doc) => raw.status === "all" || (raw.status === "archived" ? !!doc.archivedAt : !doc.archivedAt));
                message = !total.length ? "No pages yet." : !scope.length ? `No ${raw.status} pages.` : "No pages match this query or date range.";
            }
            lastGood = { docs, message, provenance };
            view = { type: "current" }; paint();
        } catch (error) {
            if (!active || mark !== generation) return;
            view = { type: "error", classification, message: error.message }; paint();
        }
    }
    function refresh(delay = 0) {
        const mark = invalidate();
        if (!active) return;
        // Validate now, even when typing/event coalescing defers the network request.
        try { query(); }
        catch (error) { view = { type: "invalid-input", message: error.message }; paint(); return; }
        view = { type: "pending-primary" }; paint();
        timer = setTimeout(() => run(mark), delay);
    }
    async function mutate(doc) {
        if (pending.has(doc.documentId)) return;
        const action = doc.archivedAt ? "unarchive" : "archive";
        pending.add(doc.documentId); actionError = null; paint();
        try {
            await api(`/docs/${encodeURIComponent(doc.documentId)}/${action}`, { method: "POST", body: {} });
            refresh();
        } catch (error) {
            actionError = { doc, message: `Couldn't ${action} ${doc.title}: ${error.message}` };
        } finally { pending.delete(doc.documentId); if (active) paint(); }
    }
    search.addEventListener("input", () => {
        if (!explicitSort || sort.value === "relevance" && !search.value.trim()) {
            sort.value = search.value.trim() ? "relevance" : "updated-desc";
            explicitSort = false;
        }
        sort.querySelector('[value="relevance"]').disabled = !search.value.trim();
        refresh(150);
    });
    sort.querySelector('[value="relevance"]').disabled = true;
    sort.addEventListener("change", () => { explicitSort = true; refresh(); });
    for (const control of [status, dateField, from, through]) control.addEventListener("input", () => refresh());
    return {
        mount(main) { active = true; if (!root.isConnected) put(main, root); refresh(); },
        deactivate() { active = false; invalidate(); },
        refresh() { refresh(60); },
    };
}
