/**
 * RVB 伐採:区画の木を取って空きを作る。
 *   1. 区画内を柱ごとに調べて原木を見つける(ゲームを止めないよう少しずつ)。
 *   2. 原木から、つながった原木と葉をたどって「塊」を作る(葉は原木から LEAF_RANGE 以内だけ)。
 *   3. 塊の原木の隣に、板材・丸石・扉など人が建てたものがあれば、建物とみなして残す。
 *      原木と葉しか無ければ木とみなして、上から順にドロップ付きで壊す。
 *   4. 落ちた原木・苗木・棒・リンゴを拾って、村人のインベントリに入れる。
 */

import { TREES } from "./config.js";
import { boxFromPoints, findConflict } from "./reservations.js";
import { getBlockSafe, inventoryOf, say } from "./util.js";
import { createMover } from "./body.js";
import { watch } from "./debug.js";

const SIX = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const FOREIGN = new RegExp(TREES.FOREIGN_REGEX);
const PICKUP = new RegExp(TREES.PICKUP_REGEX);
const isLog = (t) => /_log$/.test(t);
const isLeaves = (t) => /_leaves$/.test(t);
const pk = (x, y, z) => `${x},${y},${z}`;

/**
 * 原木 start から木の塊を調べる。
 * @returns {{blocks: {x:number,y:number,z:number,t:string}[], logs:number, leaves:number, natural:boolean, reason:string|null, base:any, box:any}}
 */
function analyzeTree(dim, start, seen) {
    const blocks = [];
    const queue = [{ x: start.x, y: start.y, z: start.z, d: 0, log: true }];
    const here = new Set([pk(start.x, start.y, start.z)]);
    let logs = 0;
    let leaves = 0;
    let reason = null;
    let tooBig = false;

    for (let qi = 0; qi < queue.length; qi++) {
        const c = queue[qi];
        const cb = getBlockSafe(dim, c);
        if (!cb) {
            reason ??= "chunk-not-loaded";
            continue;
        }
        blocks.push({ x: c.x, y: c.y, z: c.z, t: cb.typeId });
        if (c.log) {
            logs++;
            if (cb.typeId.includes("stripped")) reason ??= `人が加工した原木 @${c.x},${c.y},${c.z}`;
        } else {
            leaves++;
        }
        if (blocks.length > TREES.MAX_BLOCKS || logs > TREES.MAX_LOGS) {
            tooBig = true;
            break;
        }
        for (const [dx, dy, dz] of SIX) {
            const n = { x: c.x + dx, y: c.y + dy, z: c.z + dz };
            const k = pk(n.x, n.y, n.z);
            if (here.has(k)) continue;
            const nb = getBlockSafe(dim, n);
            if (!nb) continue;
            if (isLog(nb.typeId)) {
                here.add(k);
                queue.push({ ...n, d: 0, log: true });
            } else if (isLeaves(nb.typeId)) {
                const nd = c.log ? 1 : c.d + 1;
                if (nd <= TREES.LEAF_RANGE) {
                    here.add(k);
                    queue.push({ ...n, d: nd, log: false });
                }
            } else if (c.log && FOREIGN.test(nb.typeId)) {
                reason ??= `隣に${nb.typeId.replace("minecraft:", "")} @${n.x},${n.y},${n.z}`;
            }
        }
    }
    for (const k of here) seen.add(k);

    const natural = !reason && !tooBig && (leaves >= 1 || logs <= 8);
    if (!natural && !reason) reason = tooBig ? "塊が大きすぎる" : "葉が無く原木が多い(建物の可能性)";

    let minY = Infinity;
    let base = start;
    let min = { x: Infinity, y: Infinity, z: Infinity };
    let max = { x: -Infinity, y: -Infinity, z: -Infinity };
    for (const b of blocks) {
        if (isLog(b.t) && b.y < minY) {
            minY = b.y;
            base = b;
        }
        min = { x: Math.min(min.x, b.x), y: Math.min(min.y, b.y), z: Math.min(min.z, b.z) };
        max = { x: Math.max(max.x, b.x), y: Math.max(max.y, b.y), z: Math.max(max.z, b.z) };
    }
    return { blocks, logs, leaves, natural, reason, base, box: boxFromPoints(min, max) };
}

/**
 * 伐採の進行役。tick() を毎tick呼ぶ。終わったら true を返す。
 * @param {{dim:any, villager:any, ref:{x:number,y:number,z:number}, radius?:number, ownerId:string, owner:any, tag?:string}} ctx
 */
export function createTreeClearer(ctx) {
    const radius = ctx.radius ?? TREES.RADIUS;
    const tag = ctx.tag ?? "RVB 伐採";
    const dim = ctx.dim;

    // 近い順の柱
    const columns = [];
    for (let dx = -radius; dx <= radius; dx++) {
        for (let dz = -radius; dz <= radius; dz++) {
            const d = Math.hypot(dx, dz);
            if (d <= radius) columns.push({ x: ctx.ref.x + dx, z: ctx.ref.z + dz, d });
        }
    }
    columns.sort((a, b) => a.d - b.d);

    const stats = { trees: 0, kept: 0, logs: 0, leaves: 0, picked: {}, failed: 0, reservedSkip: 0 };
    const keptReasons = [];
    const seen = new Set();
    const trees = [];
    let phase = "SCAN";
    let ci = 0;
    let ti = 0;
    let cur = null;
    let timer = 0;
    const mover = createMover(dim, ctx.villager);
    const status = () => `伐採:${phase} 木${stats.trees}/${trees.length}本`;
    if (ctx.watch !== false) watch(ctx.villager, ctx.owner, "伐採", status);

    function scanStep() {
        for (let k = 0; k < TREES.SCAN_COLUMNS_PER_TICK && ci < columns.length; k++, ci++) {
            const col = columns[ci];
            for (let y = ctx.ref.y - TREES.SCAN_DOWN; y <= ctx.ref.y + TREES.SCAN_UP; y++) {
                if (seen.has(pk(col.x, y, col.z))) continue;
                const b = getBlockSafe(dim, { x: col.x, y, z: col.z });
                if (!b || !isLog(b.typeId)) continue;
                const tree = analyzeTree(dim, { x: col.x, y, z: col.z }, seen);
                if (tree.natural) {
                    trees.push(tree);
                } else {
                    stats.kept++;
                    if (keptReasons.length < 4) keptReasons.push(`${tree.reason}`);
                }
            }
        }
        if (ci >= columns.length) {
            // 基準点に近い木から
            trees.sort((a, b) => Math.hypot(a.base.x - ctx.ref.x, a.base.z - ctx.ref.z) - Math.hypot(b.base.x - ctx.ref.x, b.base.z - ctx.ref.z));
            say(ctx.owner, `区画(半径${radius})を調べました: 木${trees.length}本を伐採、建物らしくて残すもの${stats.kept}か所${keptReasons.length ? "(例: " + keptReasons[0] + ")" : ""}`, tag);
            phase = "NEXT";
        }
    }

    function nextTree() {
        while (ti < trees.length) {
            const t = trees[ti++];
            if (findConflict(dim.id, [t.box], ctx.ownerId)) {
                stats.reservedSkip++;
                continue;
            }
            cur = { tree: t, order: [...t.blocks].sort((a, b) => b.y - a.y), bi: 0 };
            phase = "WALK";
            return;
        }
        phase = "DONE";
    }

    function standPoint(t) {
        const loc = ctx.villager.location;
        let dx = loc.x - (t.base.x + 0.5);
        let dz = loc.z - (t.base.z + 0.5);
        const len = Math.hypot(dx, dz) || 1;
        dx /= len;
        dz /= len;
        if (len < 0.01) {
            dx = 1;
            dz = 0;
        }
        return { x: t.base.x + 0.5 + dx * 2, z: t.base.z + 0.5 + dz * 2 };
    }

    function pickup(t) {
        const inv = inventoryOf(ctx.villager);
        if (!inv) return;
        const c = { x: (t.box.min.x + t.box.max.x) / 2, y: (t.box.min.y + t.box.max.y) / 2, z: (t.box.min.z + t.box.max.z) / 2 };
        const r = Math.max(t.box.max.x - t.box.min.x, t.box.max.z - t.box.min.z, t.box.max.y - t.box.min.y) / 2 + TREES.PICKUP_RADIUS_MARGIN;
        let items = [];
        try {
            items = dim.getEntities({ type: "minecraft:item", location: c, maxDistance: r });
        } catch (e) {
            console.warn(`[RVB] getEntities failed: ${e}`);
        }
        for (const e of items) {
            try {
                const stack = e.getComponent("minecraft:item")?.itemStack;
                if (!stack || !PICKUP.test(stack.typeId)) continue;
                const before = stack.amount;
                const left = inv.addItem(stack);
                const got = before - (left?.amount ?? 0);
                if (got > 0) stats.picked[stack.typeId] = (stats.picked[stack.typeId] ?? 0) + got;
                if (!left || left.amount === 0) e.remove();
            } catch (err) {
                console.warn(`[RVB] pickup failed: ${err}`);
            }
        }
    }

    return {
        stats,
        status,
        /** @returns {boolean} 終わったら true */
        tick() {
            switch (phase) {
                case "SCAN":
                    scanStep();
                    return false;
                case "NEXT":
                    nextTree();
                    return false;
                case "WALK": {
                    const p = standPoint(cur.tree);
                    // 近づけない(到達不能)ときは、その場から壊す
                    if (mover.goTo(p) !== "moving") phase = "BREAK";
                    return false;
                }
                case "BREAK": {
                    for (let k = 0; k < TREES.BLOCKS_PER_TICK && cur.bi < cur.order.length; k++, cur.bi++) {
                        const b = cur.order[cur.bi];
                        try {
                            dim.runCommand(`setblock ${b.x} ${b.y} ${b.z} air destroy`);
                            if (isLog(b.t)) stats.logs++;
                            else stats.leaves++;
                        } catch (e) {
                            stats.failed++;
                        }
                    }
                    if (cur.bi >= cur.order.length) {
                        stats.trees++;
                        timer = TREES.PICKUP_WAIT;
                        phase = "WAIT";
                    }
                    return false;
                }
                case "WAIT":
                    if (timer-- > 0) return false;
                    pickup(cur.tree);
                    cur = null;
                    phase = "NEXT";
                    return false;
                case "DONE":
                    return true;
            }
            return false;
        },
        summary() {
            const picked = Object.entries(stats.picked).map(([id, n]) => `${id.replace("minecraft:", "")}×${n}`).join(" ");
            return `伐採 ${stats.trees}本(原木${stats.logs}・葉${stats.leaves}) / 残した建物らしきもの${stats.kept} / 他の予約と重なり${stats.reservedSkip} / 拾った: ${picked || "なし"}${stats.failed ? ` / 壊せず${stats.failed}` : ""}`;
        }
    };
}

// ---------- 単体テスト用の実行(rvb:trees_test) ----------

import { system } from "@minecraft/server";
import { TUNNEL, BASE, RVB_VERSION } from "./config.js";
import { valid } from "./util.js";

/** @type {Map<string, any>} */
const jobs = new Map();
let loopId = null;

function findBell(dim, center) {
    const R = BASE.BELL_SEARCH_RADIUS;
    const cx = Math.floor(center.x);
    const cy = Math.floor(center.y);
    const cz = Math.floor(center.z);
    let best = null;
    let bestD = Infinity;
    for (let dx = -R; dx <= R; dx++) {
        for (let dz = -R; dz <= R; dz++) {
            for (let dy = -BASE.BELL_SEARCH_DOWN; dy <= BASE.BELL_SEARCH_UP; dy++) {
                const b = getBlockSafe(dim, { x: cx + dx, y: cy + dy, z: cz + dz });
                if (b && b.typeId === BASE.BELL_ID) {
                    const d = dx * dx + dy * dy + dz * dz;
                    if (d < bestD) {
                        bestD = d;
                        best = { x: cx + dx, y: cy + dy, z: cz + dz };
                    }
                }
            }
        }
    }
    return best;
}

export function startTreesTest(player, opts = {}) {
    if (jobs.has(player.id)) {
        player.sendMessage("§e[RVB 伐採]§r すでに走っています。止めるなら rvb:trees_stop");
        return;
    }
    const dim = player.dimension;
    const p = player.location;
    const bell = findBell(dim, p);
    const ref = bell ?? { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
    const radius = Math.max(2, Math.min(32, opts.radius ?? TREES.RADIUS));
    let villager;
    try {
        villager = dim.spawnEntity(TUNNEL.VILLAGER_TYPE_ID, { x: p.x + 1, y: p.y, z: p.z });
        villager.addTag("rvb_woodcutter");
        villager.nameTag = "RVB Woodcutter";
        try { villager.addEffect("resistance", 20000000, { amplifier: 255, showParticles: false }); } catch {}
    } catch (e) {
        player.sendMessage(`§c[RVB 伐採]§r 村人を出せませんでした: ${e}`);
        return;
    }
    const clearer = createTreeClearer({ dim, villager, ref, radius, ownerId: `${player.id}:trees`, owner: player });
    jobs.set(player.id, { owner: player, villager, clearer, tick: 0 });
    if (loopId === null) {
        loopId = system.runInterval(() => {
            for (const [key, job] of jobs) {
                let done = false;
                try {
                    job.tick++;
                    if (!valid(job.villager)) done = true;
                    else if (job.tick > 20000) {
                        say(job.owner, "時間切れ", "RVB 伐採");
                        done = true;
                    } else if (job.clearer.tick()) {
                        say(job.owner, job.clearer.summary() + ` / ${job.tick}tick`, "RVB 伐採");
                        done = true;
                    }
                } catch (e) {
                    console.warn(`[RVB] trees job error: ${e}`);
                    say(job.owner, `§cエラーで停止: ${e}`, "RVB 伐採");
                    done = true;
                }
                if (done) {
                    jobs.delete(key);
                    const v = job.villager;
                    system.runTimeout(() => { try { if (valid(v)) v.remove(); } catch {} }, 60);
                }
            }
            if (jobs.size === 0) {
                system.clearRun(loopId);
                loopId = null;
            }
        }, 1);
    }
    player.sendMessage(`§e[RVB v${RVB_VERSION}]§r 伐採開始 / ${bell ? `ベル(${bell.x},${bell.y},${bell.z})` : "プレイヤー位置"}を中心に半径${radius}`);
}

export function stopTreesTest(player) {
    const job = jobs.get(player.id);
    if (!job) {
        player.sendMessage("§e[RVB 伐採]§r 走っている伐採はありません");
        return;
    }
    try { job.villager.remove(); } catch {}
    jobs.delete(player.id);
    player.sendMessage("§e[RVB 伐採]§r 止めて村人を消しました");
}
