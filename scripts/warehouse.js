/**
 * RVB 段2:倉庫
 *   村人が(1)ベルの近くで建てられる平地を自分で探し、(2)範囲を予約して整地し、
 *   (3)渡された材料で小屋を建て(丸石1層 → 板材3層 → 階段の屋根)、(4)奥にチェストを並べる。
 *
 * 小屋の座標(ローカル)
 *   xl = 0..WIDTH-1 (長辺に沿う), zl = 0..DEPTH-1 (0=ドアのある前面, DEPTH-1=奥)
 *   layer = 0 が地面の高さ(立っているY)。ドアは前面の中央、layer 0〜1 を空ける。
 * 材料はスクリプトが村人のインベントリに必要数だけ渡す(木こり・調達は次の段)。
 */

import { system, world, BlockPermutation, ItemStack } from "@minecraft/server";
import { WAREHOUSE, BASE, TUNNEL, TREES, ROAD, RVB_VERSION } from "./config.js";
import { createTreeClearer } from "./trees.js";
import { createMover, rescueIfEmbedded } from "./body.js";
import { watch } from "./debug.js";
import { boxFromPoints, findConflict, reserve, release } from "./reservations.js";
import {
    valid, getBlockSafe, isLiquidBlock, isSolidBlock, isPlant, inventoryOf, groundY, dirName, say
} from "./util.js";

const TAG = "RVB 倉庫";
const W = WAREHOUSE.WIDTH;
const DP = WAREHOUSE.DEPTH;
const L = WAREHOUSE.WALL_LAYERS;
const DOOR_X = (W - 1) / 2;

const PHASE = { CLEAR: "CLEAR", SEARCH: "SEARCH", WALK_SITE: "WALK_SITE", PREP: "PREP", BUILD: "BUILD", CHESTS: "CHESTS", ROAD: "ROAD", DONE: "DONE" };

/** @type {Map<string, any>} owner player id -> job */
const jobs = new Map();
let loopId = null;

const ID = {
    cobble: "minecraft:cobblestone",
    plank: `minecraft:${WAREHOUSE.WOOD}_planks`,
    stair: `minecraft:${WAREHOUSE.WOOD}_stairs`,
    chest: BASE.CHEST_ID
};

// ---------- 小屋の座標と設計図 ----------

/** 中心 (cx,cz)・ドア側の向き facing から、ローカル→ワールドの対応を作る */
function makeFrame(cx, cz, facing) {
    const ez = { x: -facing.x, z: -facing.z }; // 前面(0)→奥
    const ex = { x: -ez.z, z: ez.x };
    const O = {
        x: cx - ex.x * ((W - 1) / 2) - ez.x * Math.floor((DP - 1) / 2),
        z: cz - ex.z * ((W - 1) / 2) - ez.z * Math.floor((DP - 1) / 2)
    };
    return { O, ex, ez, facing };
}

const worldXZ = (f, xl, zl) => ({ x: f.O.x + f.ex.x * xl + f.ez.x * zl, z: f.O.z + f.ex.z * xl + f.ez.z * zl });

/** 設計図:置く順に並べた {xl, zl, layer, kind, ascend?} */
function buildPlan() {
    const steps = [];
    // 外周を一周する順
    const ring = [];
    for (let x = 0; x < W; x++) ring.push([x, 0]);
    for (let z = 1; z < DP; z++) ring.push([W - 1, z]);
    for (let x = W - 2; x >= 0; x--) ring.push([x, DP - 1]);
    for (let z = DP - 2; z >= 1; z--) ring.push([0, z]);

    for (let layer = 0; layer < L; layer++) {
        for (const [xl, zl] of ring) {
            if (xl === DOOR_X && zl === 0 && layer < 2) continue; // ドアの開口
            steps.push({ xl, zl, layer, kind: layer < WAREHOUSE.COBBLE_LAYERS ? "cobble" : "plank" });
        }
    }
    // 屋根:軒から棟へ。前半の列は奥向きに登り、後半の列は手前向きに登る(棟で背中合わせ)
    for (let r = 0; r < DP / 2; r++) {
        for (let xl = 0; xl < W; xl++) steps.push({ xl, zl: r, layer: L + r, kind: "stair", ascend: "toBack" });
        for (let xl = W - 1; xl >= 0; xl--) steps.push({ xl, zl: DP - 1 - r, layer: L + r, kind: "stair", ascend: "toFront" });
    }
    // 妻(両端の三角)を板材で埋める
    for (const xl of [0, W - 1]) {
        for (let zl = 1; zl <= DP - 2; zl++) {
            const h = Math.min(zl, DP - 1 - zl);
            for (let layer = L; layer < L + h; layer++) steps.push({ xl, zl, layer, kind: "plank" });
        }
    }
    return steps;
}

function countMaterials(plan) {
    const n = { cobble: 0, plank: 0, stair: 0 };
    for (const s of plan) n[s.kind]++;
    n.plank += chestSlots().length * WAREHOUSE.PLANKS_PER_CHEST;
    return n;
}

/**
 * チェストの置き場所(下の段から順)。ラージチェストは、同じ向きの2個を奥行き方向に並べて作る。
 * face=チェストの正面の向き(ローカルの軸)、stand=置くときに立つ室内のマス(通路側)
 */
function chestSlots() {
    const stacks = [];
    for (const z0 of WAREHOUSE.CHEST_SIDE_ZL) {
        if (z0 < 1 || z0 + 1 > DP - 2) continue;
        stacks.push({ xl: 1, z0, face: "ex", sx: 2 });
        if (W - 2 !== 1) stacks.push({ xl: W - 2, z0, face: "-ex", sx: W - 3 });
    }
    if (WAREHOUSE.CHEST_BACK) stacks.push({ xl: DOOR_X, z0: DP - 3, face: "ex", sx: DOOR_X + 1 });
    const out = [];
    for (let layer = 0; layer < WAREHOUSE.CHEST_STACK; layer++) {
        for (const s of stacks) {
            for (const zl of [s.z0, s.z0 + 1]) {
                out.push({ xl: s.xl, zl, layer, face: s.face, stand: { xl: s.sx, zl: s.z0 } });
            }
        }
    }
    return out;
}

// ---------- インベントリ(材料の支給と消費) ----------

function give(job, itemId, amount) {
    const c = inventoryOf(job.villager);
    if (!c) {
        job.supply[itemId] = (job.supply[itemId] ?? 0) + amount;
        return;
    }
    let rest = amount;
    while (rest > 0) {
        const n = Math.min(64, rest);
        try {
            const left = c.addItem(new ItemStack(itemId, n));
            if (left && left.amount > 0) {
                job.supply[itemId] = (job.supply[itemId] ?? 0) + left.amount; // 入りきらない分は持ち物の外で管理
            }
        } catch (e) {
            console.warn(`[RVB] give failed: ${e}`);
            job.supply[itemId] = (job.supply[itemId] ?? 0) + n;
        }
        rest -= n;
    }
}

/** itemId を amount 個使う。足りなければ false(何も減らさない) */
function take(job, itemId, amount) {
    const c = inventoryOf(job.villager);
    let have = job.supply[itemId] ?? 0;
    if (c) {
        for (let i = 0; i < c.size; i++) {
            const it = c.getItem(i);
            if (it && it.typeId === itemId) have += it.amount;
        }
    }
    if (have < amount) return false;
    let rest = amount;
    const fromSupply = Math.min(rest, job.supply[itemId] ?? 0);
    if (fromSupply > 0) {
        job.supply[itemId] -= fromSupply;
        rest -= fromSupply;
    }
    if (c) {
        for (let i = 0; i < c.size && rest > 0; i++) {
            const it = c.getItem(i);
            if (!it || it.typeId !== itemId) continue;
            const used = Math.min(it.amount, rest);
            rest -= used;
            if (it.amount - used > 0) {
                it.amount -= used;
                c.setItem(i, it);
            } else {
                c.setItem(i, undefined);
            }
        }
    }
    return true;
}

// ---------- 適地の探索 ----------

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

/** 基準点からの距離順に、探索する中心の候補を並べる */
function candidateCenters(ref) {
    const R = WAREHOUSE.SEARCH_RADIUS;
    const list = [];
    for (let dx = -R; dx <= R; dx += WAREHOUSE.SEARCH_STEP) {
        for (let dz = -R; dz <= R; dz += WAREHOUSE.SEARCH_STEP) {
            const d = Math.hypot(dx, dz);
            if (d < WAREHOUSE.MIN_DIST || d > R) continue;
            list.push({ x: ref.x + dx, z: ref.z + dz, d });
        }
    }
    list.sort((a, b) => a.d - b.d);
    return list;
}

function mode(values) {
    const count = new Map();
    let best = values[0];
    let bestN = 0;
    for (const v of values) {
        const n = (count.get(v) ?? 0) + 1;
        count.set(v, n);
        if (n > bestN) {
            bestN = n;
            best = v;
        }
    }
    return best;
}

/** 中心 (cx,cz) に建てられるかを調べる。だめなら null。 */
function evaluateSite(job, cx, cz) {
    const dim = job.dim;
    const to = { x: job.ref.x - cx, z: job.ref.z - cz };
    const facing = Math.abs(to.x) >= Math.abs(to.z)
        ? { x: Math.sign(to.x) || 1, z: 0 }
        : { x: 0, z: Math.sign(to.z) || 1 };
    const frame = makeFrame(cx, cz, facing);

    // 小屋+1マスの余白の各列について、地面の高さを調べる
    const cols = [];
    for (let zl = -1; zl <= DP; zl++) {
        for (let xl = -1; xl <= W; xl++) {
            const p = worldXZ(frame, xl, zl);
            const g = groundY(dim, p.x, p.z, job.ref.y);
            if (g === null) return null;
            cols.push({ x: p.x, z: p.z, g, inside: xl >= 0 && xl < W && zl >= 0 && zl < DP });
        }
    }
    const y0 = mode(cols.filter((c) => c.inside).map((c) => c.g));
    if (cols.some((c) => Math.abs(c.g - y0) > WAREHOUSE.FLAT_TOLERANCE)) return null;

    // 小屋の中の空き・整地量
    const prep = { fill: [], carve: [] };
    const top = y0 + WAREHOUSE.CLEARANCE;
    for (const c of cols) {
        if (!c.inside) continue;
        for (let y = c.g; y <= top; y++) {
            const b = getBlockSafe(dim, { x: c.x, y, z: c.z });
            if (!b) return null;
            if (b.isAir) continue;
            if (isPlant(b.typeId)) prep.carve.push({ x: c.x, y, z: c.z });
            else return null; // 木・建物・水など
        }
        for (let y = c.g; y < y0; y++) prep.fill.push({ x: c.x, y, z: c.z }); // 低い所は埋める
        for (let y = y0; y < c.g; y++) prep.carve.push({ x: c.x, y, z: c.z }); // 高い所は削る
    }

    // 地面が液体・保護ブロックでないこと
    for (const c of cols) {
        const below = getBlockSafe(dim, { x: c.x, y: c.g - 1, z: c.z });
        if (!below || isLiquidBlock(below)) return null;
        if (TUNNEL.PROTECTED_KEYWORDS.some((k) => below.typeId.includes(k))) return null;
    }

    // 他の仕事の予約と重ならないこと
    const a = worldXZ(frame, -1, -1);
    const b = worldXZ(frame, W, DP);
    const box = boxFromPoints({ x: a.x, y: y0 - 1, z: a.z }, { x: b.x, y: top, z: b.z });
    if (findConflict(dim.id, [box], job.owner.id)) return null;

    return { frame, y0, prep, box };
}

// ---------- 建てる ----------

function blockPosOf(job, step) {
    const p = worldXZ(job.site.frame, step.xl, step.zl);
    return { x: p.x, y: job.site.y0 + step.layer, z: p.z };
}

/** 階段が登っていく方角の名前(ワールド)。ROOF_STAIR_FLIP で反転できる。 */
function ascendName(job, ascend) {
    const f = job.site.frame;
    const v = ascend === "toBack" ? f.ez : { x: -f.ez.x, z: -f.ez.z };
    let name = dirName(v.x, v.z);
    if (WAREHOUSE.ROOF_STAIR_FLIP) name = { east: "west", west: "east", south: "north", north: "south" }[name];
    return name;
}


// ---------- 村人の安全(体の当たり判定は body.js) ----------

function makeInvulnerable(v) {
    try {
        v.addEffect("resistance", 20000000, { amplifier: 255, showParticles: false });
    } catch (e) {
        console.warn(`[RVB] effect failed: ${e}`);
    }
}

function standFor(job, step) {
    const f = job.site.frame;
    let xs;
    let zs;
    if (step.kind === "chest") {
        xs = step.stand.xl;
        zs = step.stand.zl; // チェストの正面の室内(通路側)
    } else {
        xs = Math.max(0, Math.min(W - 1, step.xl));
        zs = step.zl <= (DP - 1) / 2 ? -1 : DP; // 近い側の外
    }
    const p = worldXZ(f, xs, zs);
    return { x: p.x + 0.5, z: p.z + 0.5 };
}

function placeStep(job, step) {
    const pos = blockPosOf(job, step);
    const b = getBlockSafe(job.dim, pos);
    if (!b) {
        job.stats.skipped++;
        return;
    }
    const id = ID[step.kind];
    if (!b.isAir && !isPlant(b.typeId)) {
        // すでに同じものがある場合は成功扱い、それ以外は置かない
        if (b.typeId === id) return;
        job.stats.skipped++;
        return;
    }
    if (!take(job, id, 1)) {
        job.stats.missing++;
        return;
    }
    try {
        if (step.kind === "stair") {
            const name = ascendName(job, step.ascend);
            b.setPermutation(BlockPermutation.resolve(id, {
                weirdo_direction: WAREHOUSE.STAIR_ASCEND_STATE[name],
                upside_down_bit: false
            }));
        } else {
            b.setType(id);
        }
        job.stats[step.kind]++;
    } catch (e) {
        console.warn(`[RVB] place failed: ${e}`);
        job.stats.skipped++;
    }
}

function placeChest(job, slot) {
    const f = job.site.frame;
    const p = worldXZ(f, slot.xl, slot.zl);
    const pos = { x: p.x, y: job.site.y0 + (slot.layer ?? 0), z: p.z };
    const b = getBlockSafe(job.dim, pos);
    if (!b || (!b.isAir && !isPlant(b.typeId))) {
        job.stats.skipped++;
        return;
    }
    if (!take(job, ID.plank, WAREHOUSE.PLANKS_PER_CHEST)) {
        job.stats.missing++;
        return;
    }
    try {
        b.setType(ID.chest);
        try {
            // チェストの正面を通路側へ向ける
            const v = slot.face === "ex" ? f.ex : slot.face === "-ex" ? { x: -f.ex.x, z: -f.ex.z } : { x: -f.ez.x, z: -f.ez.z };
            b.setPermutation(BlockPermutation.resolve(ID.chest, { "minecraft:cardinal_direction": dirName(v.x, v.z) }));
        } catch {}
        job.stats.chest++;
        job.chests.push(pos);
    } catch (e) {
        console.warn(`[RVB] chest failed: ${e}`);
        job.stats.skipped++;
    }
}

function prepareSite(job) {
    const { fill, carve } = job.site.prep;
    for (const p of carve) {
        try { job.dim.runCommand(`setblock ${p.x} ${p.y} ${p.z} air`); } catch {}
    }
    for (const p of fill) {
        try { job.dim.runCommand(`setblock ${p.x} ${p.y} ${p.z} ${WAREHOUSE.PREP_FILL_BLOCK.replace("minecraft:", "")}`); } catch {}
    }
}

// ---------- 登録(あとの段が倉庫の場所を引けるように) ----------

const PROP = "rvb:warehouse";

function registerWarehouse(job) {
    const f = job.site.frame;
    const door = worldXZ(f, DOOR_X, 0);
    const info = {
        dim: job.dim.id,
        y0: job.site.y0,
        facing: dirName(f.facing.x, f.facing.z),
        door: { x: door.x, y: job.site.y0, z: door.z },
        chests: job.chests
    };
    try {
        world.setDynamicProperty(PROP, JSON.stringify(info));
    } catch (e) {
        console.warn(`[RVB] register failed: ${e}`);
    }
    return info;
}

/** 登録済みの倉庫(無ければ null) */
export function getWarehouse() {
    try {
        const s = world.getDynamicProperty(PROP);
        return typeof s === "string" ? JSON.parse(s) : null;
    } catch {
        return null;
    }
}


// ---------- 道(ドアの前の広場と、ベルまでの道) ----------

const roadBlockId = { id: null };

function skipBlock(b) {
    return !b || ROAD.SKIP_KEYWORDS.some((k) => b.typeId.includes(k)) || TUNNEL.PROTECTED_KEYWORDS.some((k) => b.typeId.includes(k));
}

/** 道の「列」の計画。各列は、中心のセルと、横に並ぶセルの一覧。y は敷くときに地形を見て決める。 */
function planRoad(job) {
    const f = job.site.frame;
    const rows = [];
    // 1) ドアの前の広場:ドアの外(zl=-1)から外へ APRON_DEPTH 列、横 APRON_WIDTH、ドアの床の高さ
    const aw = (ROAD.APRON_WIDTH - 1) / 2;
    for (let d = 1; d <= ROAD.APRON_DEPTH; d++) {
        const cells = [];
        for (let o = -aw; o <= aw; o++) cells.push(worldXZ(f, DOOR_X + o, -d));
        rows.push({ center: worldXZ(f, DOOR_X, -d), cells, flat: true });
    }
    // 2) ベルへの道:ドアの向きにまっすぐ進み、ベルと同じ線に並んだら横へ折れる
    let cur = worldXZ(f, DOOR_X, -ROAD.APRON_DEPTH);
    const goal = { x: job.ref.x, z: job.ref.z };
    const fx = f.facing.x;
    const fz = f.facing.z;
    let guard = 0;
    while (guard++ < 200) {
        const dx = goal.x - cur.x;
        const dz = goal.z - cur.z;
        if (Math.max(Math.abs(dx), Math.abs(dz)) <= ROAD.STOP_DIST) break;
        let step;
        const alongFacing = fx !== 0 ? dx * fx : dz * fz; // 向きの軸に、あとどれだけ進むか
        if (alongFacing > ROAD.STOP_DIST) step = { x: fx, z: fz };
        else if (fx !== 0) step = { x: 0, z: Math.sign(dz) || 1 };
        else step = { x: Math.sign(dx) || 1, z: 0 };
        if (step.x === 0 && step.z === 0) break;
        cur = { x: cur.x + step.x, z: cur.z + step.z };
        // 進行方向に直角に幅を広げる
        const half = (ROAD.WIDTH - 1) / 2;
        const px = step.z !== 0 ? 1 : 0;
        const pz = step.x !== 0 ? 1 : 0;
        const cells = [];
        for (let o = -half; o <= half; o++) cells.push({ x: cur.x + px * o, z: cur.z + pz * o });
        rows.push({ center: { ...cur }, cells, flat: false });
    }
    return rows;
}

function layRoadCell(job, x, z, y) {
    const dim = job.dim;
    const surf = getBlockSafe(dim, { x, y: y - 1, z });
    const top = getBlockSafe(dim, { x, y, z });
    if (!surf || !top) return false;
    for (let yy = y - 1; yy <= y + ROAD.CLEAR_ABOVE; yy++) {
        const b = getBlockSafe(dim, { x, y: yy, z });
        if (!b || isLiquidBlock(b)) return false;
        if (yy >= y && !b.isAir && !isPlant(b.typeId) && skipBlock(b)) return false;
        if (yy === y - 1 && skipBlock(b) && !/dirt_path|grass_path/.test(b.typeId)) return false;
    }
    // 低い所は土で埋める(地面まで)
    for (let yy = y - 2; yy >= y - 6; yy--) {
        const b = getBlockSafe(dim, { x, y: yy, z });
        if (!b) return false;
        if (!b.isAir && !isPlant(b.typeId)) break;
        try { dim.runCommand(`setblock ${x} ${yy} ${z} dirt`); } catch {}
    }
    // 道の上の空きを作る(高い所は削る)
    for (let yy = y; yy <= y + ROAD.CLEAR_ABOVE; yy++) {
        const b = getBlockSafe(dim, { x, y: yy, z });
        if (b && !b.isAir) { try { dim.runCommand(`setblock ${x} ${yy} ${z} air`); } catch {} }
    }
    // 路面
    const candidates = roadBlockId.id ? [roadBlockId.id] : ROAD.BLOCKS;
    for (const id of candidates) {
        try {
            dim.runCommand(`setblock ${x} ${y - 1} ${z} ${id.replace("minecraft:", "")}`);
            roadBlockId.id = id;
            return true;
        } catch {}
    }
    try { dim.runCommand(`setblock ${x} ${y - 1} ${z} dirt`); return true; } catch { return false; }
}

function tickRoad(job) {
    if (job.ri >= job.road.length) {
        job.i = 0;
        job.timer = WAREHOUSE.BUILD_TICKS_PER_BLOCK;
        job.phase = PHASE.BUILD;
        say(job.owner, `道ができました(${job.stats.road ?? 0}マス)。小屋を建てます`, TAG);
        return;
    }
    const row = job.road[job.ri];
    const f = job.site.frame;
    const loc = job.villager.location;
    const cx = row.center.x + 0.5;
    const cz = row.center.z + 0.5;
    if (rescueIfEmbedded(job.dim, job.villager)) job.stats.rescued = (job.stats.rescued ?? 0) + 1;
    if (Math.hypot(cx - loc.x, cz - loc.z) > ROAD.REACH) {
        // 届かない:ひとつ前に敷いた列まで歩く(最初はドアの内側)
        const prev = job.ri > 0 ? job.road[job.ri - 1].center : worldXZ(f, DOOR_X, -2);
        const r = job.mover.goTo({ x: prev.x + 0.5, z: prev.z + 0.5 });
        if (r === "blocked") {
            job.stats.skipped++;
            job.ri++;
        }
        return;
    }
    if (job.timer-- > 0) return;
    job.timer = ROAD.TICKS_PER_ROW;
    // この列の高さ:広場はドアの床。道は前の列から ±MAX_SLOPE、地面に近い高さ
    let y;
    if (row.flat) {
        y = job.site.y0;
    } else {
        const g = groundY(job.dim, row.center.x, row.center.z, job.roadY ?? job.site.y0, 4, 5);
        const prevY = job.roadY ?? job.site.y0;
        y = g === null ? prevY : Math.max(prevY - ROAD.MAX_SLOPE, Math.min(prevY + ROAD.MAX_SLOPE, g));
    }
    job.roadY = y;
    // 他の仕事の予約の上には敷かない
    for (const c of row.cells) {
        const box = boxFromPoints({ x: c.x, y: y - 1, z: c.z }, { x: c.x, y: y + ROAD.CLEAR_ABOVE, z: c.z });
        if (findConflict(job.dim.id, [box], job.owner.id + ":warehouse")) continue;
        // 小屋の本体には触れない
        if (insideHut(job, c.x, c.z)) continue;
        // 体の重なる所は先に外へ(自分の足元を削らない)
        if (layRoadCell(job, c.x, c.z, y)) job.stats.road = (job.stats.road ?? 0) + 1;
    }
    job.ri++;
}

function insideHut(job, x, z) {
    const f = job.site.frame;
    const dx = x - f.O.x;
    const dz = z - f.O.z;
    const xl = dx * f.ex.x + dz * f.ex.z;
    const zl = dx * f.ez.x + dz * f.ez.z;
    return xl >= 0 && xl < W && zl >= 0 && zl < DP;
}

// ---------- 状態遷移 ----------

/** 伐採で拾った木材などを、倉庫のチェストへ入れる(板材の支給分は使い切っているのでほぼ伐採品だけ) */
function depositLeftovers(job) {
    const inv = inventoryOf(job.villager);
    if (!inv || !job.chests.length) return 0;
    let moved = 0;
    for (let i = 0; i < inv.size; i++) {
        const it = inv.getItem(i);
        if (!it || !/(_log$|_sapling$|^minecraft:stick$|^minecraft:apple$)/.test(it.typeId)) continue;
        let stack = it;
        for (const pos of job.chests) {
            const cb = getBlockSafe(job.dim, pos);
            const cc = cb?.getComponent("minecraft:inventory")?.container;
            if (!cc) continue;
            const left = cc.addItem(stack);
            const got = stack.amount - (left?.amount ?? 0);
            moved += got;
            if (!left || left.amount === 0) { stack = null; break; }
            stack = left;
        }
        try { inv.setItem(i, stack ?? undefined); } catch {}
    }
    return moved;
}

function finish(job) {
    job.phase = PHASE.DONE;
    const info = registerWarehouse(job);
    let stored = 0;
    try { stored = depositLeftovers(job); } catch (e) { console.warn(`[RVB] deposit failed: ${e}`); }
    const s = job.stats;
    const ok = s.skipped === 0 && s.missing === 0;
    const verdict = ok ? "§a完成" : "§6一部できず";
    say(job.owner, `${verdict}§r  丸石${s.cobble} / 板材${s.plank} / 階段${s.stair} / チェスト${s.chest} / 道${s.road ?? 0}マス  置けず${s.skipped}・材料不足${s.missing}・救出${s.rescued ?? 0} / ドア @${info.door.x},${info.door.y},${info.door.z}(${info.facing}向き) / 伐採品を収納${stored}個 / ${job.tick}tick`, TAG);
}

function fail(job, text) {
    say(job.owner, `§c${text}`, TAG);
    try { job.villager.remove(); } catch {}
    return false;
}

function tickJob(job) {
    job.tick++;
    if (!valid(job.villager)) {
        say(job.owner, "村人がいなくなったため終了", TAG);
        return false;
    }
    if (job.tick > WAREHOUSE.MAX_TICKS) return fail(job, "時間切れ。村人を消して終了");

    switch (job.phase) {
        case PHASE.CLEAR: {
            if (job.clearer.tick()) {
                say(job.owner, job.clearer.summary(), TAG);
                job.phase = PHASE.SEARCH;
            }
            break;
        }
        case PHASE.SEARCH: {
            for (let k = 0; k < WAREHOUSE.CANDIDATES_PER_TICK; k++) {
                if (job.ci >= job.candidates.length) {
                    return fail(job, `建てられる平地が見つかりません(基準点から${WAREHOUSE.SEARCH_RADIUS}マス以内、${job.candidates.length}か所を確認)`);
                }
                const c = job.candidates[job.ci++];
                const site = evaluateSite(job, c.x, c.z);
                if (!site) continue;
                job.site = site;
                reserve(job.owner.id + ":warehouse", "RVB倉庫", job.dim.id, [site.box]);
                job.reserved = true;
                say(job.owner,
                    `建設地を決めました: 中心(${c.x},${c.z}) 高さY=${site.y0} / ドアは${dirName(site.frame.facing.x, site.frame.facing.z)}向き / 整地 埋め${site.prep.fill.length}・削り${site.prep.carve.length} / ${job.ci}か所目`, TAG);
                job.phase = PHASE.WALK_SITE;
                break;
            }
            break;
        }
        case PHASE.WALK_SITE: {
            const door = worldXZ(job.site.frame, DOOR_X, -2);
            if (job.mover.goTo({ x: door.x + 0.5, z: door.z + 0.5 }) !== "moving") job.phase = PHASE.PREP;
            break;
        }
        case PHASE.PREP: {
            prepareSite(job);
            const m = countMaterials(job.plan);
            give(job, ID.cobble, m.cobble);
            give(job, ID.plank, m.plank);
            give(job, ID.stair, m.stair);
            say(job.owner, `材料を支給しました: 丸石${m.cobble} / 板材${m.plank}(チェスト${job.chestPlan.length}個ぶん${job.chestPlan.length * WAREHOUSE.PLANKS_PER_CHEST}含む) / 階段${m.stair}。建て始めます`, TAG);
            job.i = 0;
            job.timer = WAREHOUSE.BUILD_TICKS_PER_BLOCK;
            if (ROAD.ENABLED) {
                // 先に道(広場)を作る:ドアの前が土の段差だと、村人が中に入れない
                job.road = planRoad(job);
                job.ri = 0;
                job.timer = 0;
                job.phase = PHASE.ROAD;
                say(job.owner, `先にドアの前の広場とベルまでの道を作ります(${job.road.length}列)`, TAG);
            } else {
                job.phase = PHASE.BUILD;
            }
            break;
        }
        case PHASE.BUILD:
        case PHASE.CHESTS: {
            const list = job.phase === PHASE.BUILD ? job.plan : job.chestPlan;
            if (job.i >= list.length) {
                if (job.phase === PHASE.BUILD) {
                    job.phase = PHASE.CHESTS;
                    job.i = 0;
                    say(job.owner, "壁と屋根ができました。チェストを作って並べます", TAG);
                } else {
                    finish(job);
                }
                break;
            }
            const step = list[job.i];
            const stand = standFor(job, step);
            const loc = job.villager.location;
            if (rescueIfEmbedded(job.dim, job.villager)) job.stats.rescued = (job.stats.rescued ?? 0) + 1;
            if (Math.hypot(stand.x - loc.x, stand.z - loc.z) > 0.2) {
                const r = job.mover.goTo(stand);
                if (r === "blocked") {
                    // 立ち位置へ行けない:この1ブロックは諦める(数えて報告)
                    job.stats.skipped++;
                    job.i++;
                    job.timer = 0;
                }
                break;
            }
            if (job.timer-- > 0) break;
            {
                // 置く場所に体が重なっていたら、先に外へ出す
                const pos = step.kind === "chest" ? { ...worldXZ(job.site.frame, step.xl, step.zl), y: job.site.y0 + step.layer } : blockPosOf(job, step);
                if (rescueIfEmbedded(job.dim, job.villager, pos)) {
                    job.stats.rescued = (job.stats.rescued ?? 0) + 1;
                    break;
                }
            }
            if (step.kind === "chest") placeChest(job, step);
            else placeStep(job, step);
            job.i++;
            job.timer = WAREHOUSE.BUILD_TICKS_PER_BLOCK;
            if (job.phase === PHASE.BUILD && job.i % 30 === 0) say(job.owner, `建築 ${job.i}/${job.plan.length}`, TAG);
            break;
        }
        case PHASE.ROAD:
            tickRoad(job);
            break;
        case PHASE.DONE:
            return false;
    }
    return true;
}

function cleanup(job) {
    if (job.reserved) release(job.owner.id + ":warehouse");
}

function ensureLoop() {
    if (loopId !== null) return;
    loopId = system.runInterval(() => {
        for (const [key, job] of jobs) {
            let alive = false;
            try {
                alive = tickJob(job) && job.phase !== PHASE.DONE;
            } catch (e) {
                console.warn(`[RVB] warehouse job error: ${e}`);
                say(job.owner, `§cエラーで停止: ${e}`, TAG);
            }
            if (!alive) {
                jobs.delete(key);
                cleanup(job);
                if (valid(job.villager) && job.phase === PHASE.DONE) {
                    const v = job.villager;
                    system.runTimeout(() => { try { if (valid(v)) v.remove(); } catch {} }, 100);
                }
            }
        }
        if (jobs.size === 0) {
            system.clearRun(loopId);
            loopId = null;
        }
    }, 1);
}

// ---------- 公開API ----------

/** @param {import("@minecraft/server").Player} player */
export function startWarehouseTest(player) {
    if (jobs.has(player.id)) {
        player.sendMessage("§e[RVB 倉庫]§r すでに倉庫づくりが走っています。止めるなら rvb:warehouse_stop");
        return;
    }
    const dim = player.dimension;
    const p = player.location;
    const bell = findBell(dim, p);
    const ref = bell ?? { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };

    const plan = buildPlan();
    const chestPlan = chestSlots().map((s) => ({ ...s, kind: "chest" }));
    const job = {
        owner: player,
        dim,
        ref,
        candidates: candidateCenters(ref),
        ci: 0,
        site: null,
        reserved: false,
        plan,
        chestPlan,
        chests: [],
        supply: {},
        clearer: null,
        phase: TREES.ENABLED ? PHASE.CLEAR : PHASE.SEARCH,
        i: 0,
        timer: 0,
        tick: 0,
        villager: null,
        stats: { cobble: 0, plank: 0, stair: 0, chest: 0, skipped: 0, missing: 0 }
    };

    try {
        const v = dim.spawnEntity(TUNNEL.VILLAGER_TYPE_ID, { x: p.x + 1, y: p.y, z: p.z });
        v.addTag("rvb_builder");
        v.nameTag = "RVB Builder";
        job.villager = v;
        makeInvulnerable(v);
        job.mover = createMover(dim, v);
        watch(v, player, "倉庫", () => `${job.phase === "CLEAR" && job.clearer ? job.clearer.status() : job.phase}${job.plan && job.phase === "BUILD" ? " " + job.i + "/" + job.plan.length : ""} 置けず${job.stats.skipped} 救出${job.stats.rescued ?? 0}`);
    } catch (e) {
        player.sendMessage(`§c[RVB 倉庫]§r 村人を出せませんでした: ${e}`);
        return;
    }

    if (TREES.ENABLED) {
        job.clearer = createTreeClearer({ dim, villager: job.villager, ref, ownerId: player.id + ":warehouse", owner: player, watch: false });
    }
    jobs.set(player.id, job);
    ensureLoop();
    const m = countMaterials(plan);
    player.sendMessage(
        `§e[RVB v${RVB_VERSION}]§r 倉庫づくり開始 / ${bell ? `ベル(${bell.x},${bell.y},${bell.z})` : "プレイヤー位置"}を基準に適地を探します / ` +
        `小屋 ${W}×${DP}・壁${L}層(丸石${WAREHOUSE.COBBLE_LAYERS}+板材${L - WAREHOUSE.COBBLE_LAYERS})+階段の屋根 / 必要材料 丸石${m.cobble}・板材${m.plank}・階段${m.stair}`
    );
}

export function stopWarehouseTest(player) {
    const job = jobs.get(player.id);
    if (!job) {
        player.sendMessage("§e[RVB 倉庫]§r 走っている倉庫づくりはありません");
        return;
    }
    try { job.villager.remove(); } catch {}
    jobs.delete(player.id);
    cleanup(job);
    player.sendMessage("§e[RVB 倉庫]§r 倉庫づくりを止めて村人を消しました(建築途中のものは残ります)");
}
