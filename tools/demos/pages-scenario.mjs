// Owned IPC fixture over the actual extension. Only SDK lifecycle and fictional GitHub/clock are substituted.
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdirSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import { harness as h, emit, observeHooks } from "../../test/fixtures/pages-sdk.mjs";
import { directoryBytes } from "../../test/fixtures/pages.mjs";
import * as store from "../../extensions/marginal/lib/store.mjs";
import * as command from "../../extensions/marginal/lib/command/index.mjs";
import * as owner from "../../extensions/marginal/lib/command/owner.mjs";
import * as poller from "../../extensions/marginal/lib/command/poller.mjs";
import * as commandState from "../../extensions/marginal/lib/command/state.mjs";

const root = process.env.MARGINAL_DATA_DIR;
let before, bytes;
const restores = [];
const attached = () => Object.fromEntries(Object.entries(directoryBytes(root)).filter(([path]) => !/[\\/]versions[\\/]|[\\/]current\.json$/.test(path)));
const runtimeOracle = () => {
    assert.deepEqual(h.calls, [], "no actual lifecycle stop/cleanup edge");
    assert.deepEqual(h.watcher.watching(), ["arc-live"]);
};
const oracle = () => {
    runtimeOracle();
    assert.deepEqual(attached(), bytes);
    for (const key of ["id", "kind", "createdAt", "updatedAt", "content", "target", "pullRequest", "nextId"]) assert.deepEqual(store.getDoc("arc-live")[key], before[key], key);
};
async function tick() {
    const mark = h.world.calls.length;
    await h.clock.advance(60_000, () => h.watcher.settled());
    assert.ok(h.world.calls.slice(mark).some((call) => call.kind === "rest" && call.args.some((arg) => arg.startsWith("If-Modified-Since: "))));
    assert.deepEqual(h.watcher.watching(), ["arc-live"]);
}
async function close() {
    h.armed = false;
    for (const restore of restores.reverse()) restore();
    h.watcher?.stopAll(); await h.watcher?.settled();
    h.missionStop?.();
    for (const id of owner.heldHere()) owner.stopHeartbeat(id);
    for (const doc of store.list({ status: "all" })) { poller.stopAll(doc.documentId); commandState.unwatchCommand(doc.documentId); }
    for (const server of h.servers) {
        server.server.closeAllConnections();
        await new Promise((resolve, reject) => server.server.close((error) => error ? reject(error) : resolve()));
    }
}
async function dispatch(message) {
    switch (message.op) {
        case "init":
            await import("../../extensions/marginal/extension.mjs");
            assert.deepEqual([...h.modules.values()], Array(9).fill(1));
            return { ok: true };
        case "open":
            return h.canvas.open({ instanceId: message.instance ?? "browser-pages", input: message.documentId ? { documentId: message.documentId } : {} });
        case "read": return structuredClone(store.getDoc(message.documentId));
        case "counters": return {sent:h.sent.length,github:h.world.calls.length};
        case "edit": {
            const RealDate=Date;
            if(message.at)globalThis.Date=class extends RealDate{
                constructor(...args){super(...(args.length?args:[message.at]));}
                static now(){return RealDate.parse(message.at);}
            };
            try{return await store.applyEdit(message.documentId, { type: "update", targetId: message.blockId ?? "md-1", changes: { markdown: message.text } });}
            finally{globalThis.Date=RealDate;}
        }
        case "rename": return store.rename(message.documentId, message.title);
        case "archive": return store.archive(message.documentId);
        case "unarchive": return store.unarchive(message.documentId);
        case "emit": for (const event of message.events) emit(event); return { emitted: message.events.length };
        case "scene": {
            const repo=join(root,"synthetic-git");mkdirSync(repo);
            const git=(...args)=>execFileSync("git",["--no-pager",...args],{cwd:repo,encoding:"utf8",windowsHide:true,
                env:{...process.env,GIT_CONFIG_GLOBAL:join(root,"no-global-config"),GIT_CONFIG_NOSYSTEM:"1",GIT_TERMINAL_PROMPT:"0"}}).trim();
            git("init","--quiet","-b","ui-fixture");
            const commit=(word)=>{
                writeFileSync(join(repo,"fixture.mjs"),`export const fixture = "${word}";\n`);
                git("add","--","fixture.mjs");git("-c","user.name=UI Fixture","-c","user.email=ui@example.invalid","-c","commit.gpgsign=false","commit","--quiet","-m",`Synthetic ${word}`);
                return git("rev-parse","HEAD");
            };
            const base=commit("before"),head=commit("after"),gitm=await import("../../extensions/marginal/lib/git.mjs");
            const record=await gitm.registerRepository(repo),target=await gitm.resolvePins(record.repositoryId,base,head);
            await store.setTarget(message.documentId,target);
            const call=async(name,input)=>{
                const result=await h.canvas.actions.find(action=>action.name===name).handler({instanceId:"browser-pages",input:{documentId:message.documentId,...input}});
                assert.equal(result.ok,true,JSON.stringify(result));return result;
            };
            await call("command_plan",{op:"set",worktree:repo,plan:{id:"ui-plan",title:"Synthetic release",phases:[
                {id:"p1",title:"Readable implementation",expects:["fixture.mjs"],steps:[{id:"s1",title:"Synthetic step",expects:["fixture.mjs"]}]},
                {id:"p2",title:"Review",expects:["fixture.mjs"]},
            ]}});
            await call("command_plan",{op:"phase",phaseId:"p1",status:"implementing"});
            await call("command_front",{op:"plan",fronts:[{id:"review",label:"Synthetic reviewer",note:"Independent pending review"}]});
            h.world.model.pr.title="Synthetic pull request";
            h.world.review("fictional-reviewer",{state:"CHANGES_REQUESTED",body:"Synthetic review",comments:[{path:"fixture.mjs",line:1,body:"Synthetic comment",diffHunk:'@@ -1 +1 @@\n-export const fixture = "before";\n+export const fixture = "after";'}]});
            h.world.checks([{name:"Synthetic unit checks",status:"COMPLETED",conclusion:"SUCCESS"},{name:"Synthetic lint checks",status:"COMPLETED",conclusion:"FAILURE"}]);
            h.service.register(message.documentId,{url:h.world.ident.url,settings:{watch:true,handle:"read"}});
            await h.watcher.settled();
            return {target,base,head};
        }
        case "watch":
            h.service.register("arc-live", { url: h.world.ident.url, settings: { watch: true, handle: "read" } });
            await h.watcher.settled();
            assert.equal(h.service.ownership("arc-live").here, true);
            assert.equal(h.service.watcher, h.watcher);
            await tick();
            restores.push(observeHooks(store.beforeRemove, "beforeRemove"), observeHooks(command.cleanupHooks, "cleanupHooks"));
            return { watching: h.watcher.watching() };
        case "arm":
            before = structuredClone(store.getDoc("arc-live")); bytes = attached();
            h.calls.length = 0; h.armed = true;
            return { armed: true };
        case "oracle": oracle(); await tick(); runtimeOracle(); h.armed = false; return { calls: 0, watching: h.watcher.watching() };
        case "negative": {
            const all = directoryBytes(root), count = h.world.calls.length;
            h.calls.length = 0; h.armed = true;
            h.watcher.unwatch("arc-live");
            assert.deepEqual(directoryBytes(root), all);
            assert.deepEqual(h.calls.map((call) => call.name), ["prs.unwatch"]);
            assert.throws(oracle, /lifecycle stop/);
            await h.clock.advance(60_000, () => h.watcher.settled());
            assert.equal(h.world.calls.length, count);
            h.armed = false;
            return { negativeDetected: true };
        }
        case "close": await close(); return { closed: true };
        default: throw new Error(`Unknown owned fixture operation ${message.op}`);
    }
}
process.on("message", async (message) => {
    try { process.send({ id: message.id, result: await dispatch(message) }); }
    catch (error) { process.send({ id: message.id, error: error.stack }); }
    finally { if (message.op === "close") process.disconnect(); }
});
process.send({ ready: true });
