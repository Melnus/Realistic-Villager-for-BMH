/**
 * RVB 段1:
 *   ベルのそばにチェストを置く → 地表から階段(3×5)で Y=16 まで掘り下る →
 *   升目(格子)状に 3×3 の坑道を広げる(鉄鉱石は回収)→ 松明を点検しながら戻る →
 *   階段を登って出発点に戻り、チェストに鉄を入れる。
 *
 * 座標の取り方
 *   階段   … セル番号 n(0=地表の出発点、D=坑道の入口)。1セル進むごとに1段下がる。
 *   坑道   … 入口を原点とする格子座標 (u, v)。u=前方、v=右。
 * 合格条件は「帰還できたこと」。鉄が見つかるかは運なので見ない。
 */

import { system, world, BlockPermutation, EquipmentSlot, ItemStack } from "@minecraft/server";
import { TUNNEL, GRID, ORE, BASE, RVB_VERSION } from "./config.js";
import { boxFromPoints, findConflict, reserve, release } from "./reservations.js";

const PHASE = {
    STAIR_DIG: "STAIR_DIG",
    STAIR_WALK: "STAIR_WALK",
    GRID_PLAN: "GRID_PLAN",
    WALK_PATH: "WALK_PATH",
    GRID_DIG: "GRID_DIG",
    GRID_STEP: "GRID_STEP",
    STAIR_UP: "STAIR_UP",
    DONE: "DONE"
};

/** @type {Map<string, any>} owner player id -> job */
const jobs = new Map();
let loopId = null;

const STAIR_HALF = (TUNNEL.STAIR_WIDTH - 1) / 2;
const TUNNEL_HALF = (TUNNEL.WIDTH - 1) / 2;
const NEIGHBORS = [[1, 0], [0, 1], [0, -1], [-1, 0]];
const SIX = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

const mod = (a, m) => ((a % m) + m) % m;
const ck = (u, v) => `${u},${v}`;
const pk = (p) => `${p.x},${p.y},${p.z}`;

// ---------- 小物 ----------

function valid(entity) {
    if (!entity) return false;
    try {
        // バージョンにより isValid はメソッドだったりプロパティだったりする
        return typeof entity.isValid === "function" ? entity.isValid() : !!entity.isValid;
    } catch {
        return false;
    }
}

function say(job, text) {
    try {
        if (valid(job.owner)) {
            job.owner.sendMessage(`§e[RVB]§r ${text}`);
            return;
        }
    } catch {}
    console.warn(`[RVB] ${text}`);
}

function getBlockSafe(dim, pos) {
    try {
        return dim.getBlock(pos);
    } catch {
        return undefined;
    }
}

function isLiquidBlock(block) {
    try {
        if (block.isLiquid) return true;
    } catch {}
    return /(^|:)(flowing_)?(water|lava)$/.test(block.typeId);
}

const isSolidBlock = (block) => !!block && !block.isAir && !isLiquidBlock(block);
const isProtected = (typeId) => TUNNEL.PROTECTED_KEYWORDS.some((k) => typeId.includes(k));
const isIronOre = (typeId) => ORE.IDS.includes(typeId);
const isPlant = (typeId) =>
    /(short_grass|tall_grass|tallgrass|fern|flower|tulip|dandelion|poppy|orchid|allium|azure_bluet|cornflower|lily|rose_bush|peony|sapling|mushroom|wildflowers|pink_petals|bush)/.test(typeId);

// ---------- 経路の幾何 ----------

/** 階段セルnの足元のY */
const yAt = (job, n) => Math.max(job.targetY, job.y0 - n);

/** 階段セルnの、横s・高さhのブロック座標 */
function stairBlock(job, n, s, h) {
    return {
        x: job.origin.x + job.dir.x * n + job.side.x * s,
        y: yAt(job, n) + h,
        z: job.origin.z + job.dir.z * n + job.side.z * s
    };
}

/** 坑道の格子座標(u,v)・高さk のブロック座標。k=0 が村人の足元 */
function gridBlock(job, u, v, k) {
    return {
        x: job.base.x + job.dir.x * u + job.side.x * v,
        y: job.targetY + k,
        z: job.base.z + job.dir.z * u + job.side.z * v
    };
}

function stairCenter(job, n) {
    return { x: job.origin.x + job.dir.x * n + 0.5, y: yAt(job, n), z: job.origin.z + job.dir.z * n + 0.5 };
}

function gridCenter(job, u, v) {
    const b = gridBlock(job, u, v, 0);
    return { x: b.x + 0.5, y: b.y, z: b.z + 0.5 };
}

/**
 * 掘る範囲の仕様。body=掘る所, floor=床, ceil=天井, walls=左右の壁, ahead=1つ先(液体確認だけ)。
 * 階段セル n(<D) と、格子セル (u,v) を進行方向 (hu,hv) へ掘る場合の2種類。
 */
function stairSpec(job, n) {
    const H = TUNNEL.STAIR_HEIGHT;
    const spec = { body: [], floor: [], ceil: [], walls: [], ahead: [], stairs: true, torchSpot: null, torchWall: null };
    for (let s = -STAIR_HALF; s <= STAIR_HALF; s++) {
        for (let h = 0; h < H; h++) spec.body.push(stairBlock(job, n, s, h));
        spec.floor.push(stairBlock(job, n, s, -1));
        spec.ceil.push(stairBlock(job, n, s, H));
    }
    for (const s of [-STAIR_HALF - 1, STAIR_HALF + 1]) {
        for (let h = 0; h < H; h++) spec.walls.push(stairBlock(job, n, s, h));
    }
    spec.torchSpot = stairBlock(job, n, STAIR_HALF, 1);
    spec.torchWall = stairBlock(job, n, STAIR_HALF + 1, 1);
    if (n + 1 < job.D) {
        for (let s = -STAIR_HALF; s <= STAIR_HALF; s++) {
            for (let h = 0; h < H; h++) spec.ahead.push(stairBlock(job, n + 1, s, h));
        }
    } else {
        spec.ahead = gridSpec(job, 0, 0, 1, 0).body;
    }
    return spec;
}

function gridSpec(job, u, v, hu, hv) {
    // p=進行方向の右(格子座標)。進行方向に対して横に TUNNEL.WIDTH 幅で掘る
    const pu = -hv;
    const pv = hu;
    const at = (uu, vv, k) => gridBlock(job, uu, vv, k);
    const spec = { body: [], floor: [], ceil: [], walls: [], ahead: [], stairs: false, torchSpot: null, torchWall: null };
    for (let s = -TUNNEL_HALF; s <= TUNNEL_HALF; s++) {
        for (let k = 0; k < TUNNEL.HEIGHT; k++) {
            spec.body.push(at(u + pu * s, v + pv * s, k));
            spec.ahead.push(at(u + hu + pu * s, v + hv + pv * s, k));
        }
        spec.floor.push(at(u + pu * s, v + pv * s, -1));
        spec.ceil.push(at(u + pu * s, v + pv * s, TUNNEL.HEIGHT));
    }
    for (const s of [-TUNNEL_HALF - 1, TUNNEL_HALF + 1]) {
        for (let k = 0; k < TUNNEL.HEIGHT; k++) spec.walls.push(at(u + pu * s, v + pv * s, k));
    }
    // 松明:進行方向の右側の壁(往路の右。戻りでは左手になる)
    spec.torchSpot = at(u + pu * TUNNEL_HALF, v + pv * TUNNEL_HALF, 1);
    spec.torchWall = at(u + pu * (TUNNEL_HALF + 1), v + pv * (TUNNEL_HALF + 1), 1);
    return spec;
}

/**
 * 掘って安全かを調べる。液体(範囲・壁・天井・床・1つ先)、保護ブロック、床の穴があれば理由を返す。
 * @returns {string|null} 問題なしなら null
 */
function checkSpec(job, spec) {
    const dim = job.dim;
    const at = (reason, p, b) => `${reason} @${p.x},${p.y},${p.z}${b ? " (" + b.typeId + ")" : ""}`;

    for (const p of spec.body) {
        const b = getBlockSafe(dim, p);
        if (!b) return at("chunk-not-loaded", p);
        if (isLiquidBlock(b)) return at("liquid-in-cell", p, b);
        if (isProtected(b.typeId)) return at("protected", p, b);
    }
    for (const p of spec.floor) {
        const b = getBlockSafe(dim, p);
        if (!b) return at("chunk-not-loaded", p);
        if (isLiquidBlock(b)) return at("liquid-floor", p, b);
        // 階段の途中は、段々の斜面などで床が空気でも進める(落ちるだけ)。坑道は床が要る
        if (!isSolidBlock(b) && !spec.stairs) return at("no-floor", p, b);
    }
    for (const p of spec.ceil) {
        const b = getBlockSafe(dim, p);
        if (b && isLiquidBlock(b)) return at("liquid-ceiling", p, b);
    }
    for (const p of spec.walls) {
        const b = getBlockSafe(dim, p);
        if (b && isLiquidBlock(b)) return at("liquid-wall", p, b);
    }
    for (const p of spec.ahead) {
        const b = getBlockSafe(dim, p);
        if (b && isLiquidBlock(b)) return at("liquid-ahead", p, b);
    }
    return null;
}

// ---------- インベントリ ----------

function inventoryOf(entity) {
    try {
        return entity.getComponent("minecraft:inventory")?.container ?? null;
    } catch {
        return null;
    }
}

/** 村人のインベントリに入れる。入らない分は数えておく。インベントリが無い個体は job.carried に持つ。 */
function collect(job, itemId, amount) {
    job.stats.ore += amount;
    const c = inventoryOf(job.villager);
    if (c) {
        try {
            const left = c.addItem(new ItemStack(itemId, amount));
            if (left && left.amount > 0) job.stats.lost += left.amount;
            return;
        } catch {}
    }
    job.carried[itemId] = (job.carried[itemId] ?? 0) + amount;
}

/** 村人の持ち物をチェストへ移す。@returns {Record<string, number>} 移した数 */
function depositAll(job) {
    const moved = {};
    const chestBlock = getBlockSafe(job.dim, job.chestPos);
    let chest = null;
    try {
        chest = chestBlock?.getComponent("minecraft:inventory")?.container ?? null;
    } catch {}
    if (!chest) {
        say(job, `§cチェストが見つかりません @${job.chestPos.x},${job.chestPos.y},${job.chestPos.z}`);
        return moved;
    }
    const put = (stack) => {
        const left = chest.addItem(stack);
        const done = stack.amount - (left?.amount ?? 0);
        if (done > 0) moved[stack.typeId] = (moved[stack.typeId] ?? 0) + done;
        return left;
    };
    const inv = inventoryOf(job.villager);
    if (inv) {
        for (let i = 0; i < inv.size; i++) {
            const it = inv.getItem(i);
            if (!it) continue;
            try {
                const left = put(it);
                inv.setItem(i, left && left.amount > 0 ? left : undefined);
            } catch (e) {
                console.warn(`[RVB] deposit failed: ${e}`);
            }
        }
    }
    for (const [id, amount] of Object.entries(job.carried)) {
        const left = put(new ItemStack(id, amount));
        job.carried[id] = left?.amount ?? 0;
    }
    return moved;
}

// ---------- ブロックを掘る ----------

function mineIron(job, p) {
    try {
        job.dim.runCommand(`setblock ${p.x} ${p.y} ${p.z} air`);
    } catch (e) {
        console.warn(`[RVB] mine failed at ${p.x},${p.y},${p.z}: ${e}`);
        return false;
    }
    job.stats.blocks++;
    collect(job, ORE.DROP_ITEM_ID, 1);
    return true;
}

/** 範囲(body)を空気にする。中にある鉄は回収する。 */
function carveSpec(job, spec) {
    for (const p of spec.body) {
        const b = getBlockSafe(job.dim, p);
        if (!b || b.isAir) continue;
        if (isIronOre(b.typeId)) {
            mineIron(job, p);
            job.stats.insideOre++;
            continue;
        }
        try {
            job.dim.runCommand(`setblock ${p.x} ${p.y} ${p.z} air${ORE.RUBBLE_DROPS ? " destroy" : ""}`);
            job.stats.blocks++;
        } catch (e) {
            console.warn(`[RVB] carve failed at ${p.x},${p.y},${p.z}: ${e}`);
        }
    }
}

/** 掘っても水が流れ込まないか(6方向の隣が液体でない) */
function safeToMine(job, p) {
    for (const [dx, dy, dz] of SIX) {
        const b = getBlockSafe(job.dim, { x: p.x + dx, y: p.y + dy, z: p.z + dz });
        if (!b || isLiquidBlock(b)) return false;
    }
    return true;
}

/**
 * 壁・天井に露出した鉄を掘り、同じ鉱脈のつながりを上限まで追う。
 * 床より下は掘らない(通路の下に穴を開けないため)。
 */
function mineExposed(job, spec) {
    if (!ORE.MINE_EXPOSED || spec.stairs) return;
    const queue = [];
    for (const p of [...spec.walls, ...spec.ceil]) {
        if (p.y < job.targetY) continue;
        const b = getBlockSafe(job.dim, p);
        if (b && isIronOre(b.typeId)) queue.push(p);
    }
    const seen = new Set(queue.map(pk));
    let mined = 0;
    while (queue.length > 0 && mined < ORE.VEIN_MAX_PER_CELL) {
        const p = queue.shift();
        if (!safeToMine(job, p)) continue;
        if (!mineIron(job, p)) continue;
        mined++;
        job.stats.exposedOre++;
        for (const [dx, dy, dz] of SIX) {
            const q = { x: p.x + dx, y: p.y + dy, z: p.z + dz };
            if (q.y < job.targetY || seen.has(pk(q))) continue;
            seen.add(pk(q));
            const b = getBlockSafe(job.dim, q);
            if (b && isIronOre(b.typeId)) queue.push(q);
        }
    }
}

// ---------- 松明 ----------

// 松明の向きは実機で判定する(落ちたら反転)。判定済みなら以降は確認を省く。
let torchInward = TUNNEL.TORCH_FACING_FROM_WALL;
let torchCalibrated = false;

const FACING_NAME = (dx, dz) => (dx > 0 ? "east" : dx < 0 ? "west" : dz > 0 ? "south" : "north");

/** 置いた松明が壁に支えられているか確かめるため、隣のマスで更新を起こす。 */
function kickUpdate(job, spot, inward) {
    const p = { x: spot.x + inward.x, y: spot.y, z: spot.z + inward.z };
    const b = getBlockSafe(job.dim, p);
    if (!b || !b.isAir) return;
    try {
        job.dim.runCommand(`setblock ${p.x} ${p.y} ${p.z} dirt`);
        job.dim.runCommand(`setblock ${p.x} ${p.y} ${p.z} air`);
    } catch {}
}

/** 置いた松明の確認。落ちていたら向きを反転して1回だけ置き直す。 */
function checkTorch(job) {
    const c = job.torchCheck;
    if (!c || job.tick < c.due) return;
    job.torchCheck = null;
    const spot = getBlockSafe(job.dim, c.spot);
    if (spot && spot.typeId.includes("torch")) {
        if (!torchCalibrated) {
            torchCalibrated = true;
            say(job, `松明の向きOK (${torchInward ? "壁から通路側" : "通路側から壁"}の指定)`);
        }
        return;
    }
    if (torchCalibrated) return;
    if (c.tries >= 1) {
        torchCalibrated = true;
        say(job, "§c松明が両方の向きで落ちました。壁の材質か置き方を見直す必要があります");
        return;
    }
    torchInward = !torchInward;
    say(job, "松明が落ちたので、向きを反転して置き直します");
    placeTorch(job, c.spot, c.wall, c.tries + 1);
}

/** spot に、wall を背にした壁松明を置く。置けなければ false。 */
function placeTorch(job, spot, wall, tries = 0) {
    const sb = getBlockSafe(job.dim, spot);
    const wb = getBlockSafe(job.dim, wall);
    if (!sb || !sb.isAir || !isSolidBlock(wb)) return false;

    const inward = { x: spot.x - wall.x, z: spot.z - wall.z }; // 壁から通路側へ
    const facing = torchInward ? FACING_NAME(inward.x, inward.z) : FACING_NAME(-inward.x, -inward.z);
    try {
        sb.setPermutation(BlockPermutation.resolve("minecraft:torch", { torch_facing_direction: facing }));
    } catch (e) {
        console.warn(`[RVB] torch failed: ${e}`);
        return false;
    }
    if (!torchCalibrated) {
        kickUpdate(job, spot, inward);
        job.torchCheck = { spot, wall, due: job.tick + TUNNEL.TORCH_CHECK_TICKS, tries };
    }
    return true;
}

/** 新しく掘ったセルに、近くに松明が無ければ置く */
function maybeTorch(job, u, v, spec) {
    for (const t of job.torches) {
        if (Math.max(Math.abs(t.u - u), Math.abs(t.v - v)) < TUNNEL.TORCH_INTERVAL) return;
    }
    if (placeTorch(job, spec.torchSpot, spec.torchWall)) {
        job.torches.push({ u, v, spot: spec.torchSpot, wall: spec.torchWall });
        job.stats.torches++;
    }
}

/** 階段のセルnに松明を置く(間隔ごと) */
function maybeStairTorch(job, n, spec) {
    if (n <= 0 || n % TUNNEL.STAIR_TORCH_INTERVAL !== 0) return;
    if (placeTorch(job, spec.torchSpot, spec.torchWall)) {
        job.stairTorches.set(n, { spot: spec.torchSpot, wall: spec.torchWall });
        job.stats.stairTorches++;
    }
}

/** 階段を登る途中の点検:このセルに松明があるはずなのに無ければ置き直す */
function ensureStairTorch(job, n) {
    const rec = job.stairTorches.get(n);
    if (!rec) return;
    const b = getBlockSafe(job.dim, rec.spot);
    if (!b || b.typeId.includes("torch")) return;
    if (placeTorch(job, rec.spot, rec.wall)) job.stats.replaced++;
}

/** 戻りの点検:このセルに松明があるはずなのに無ければ置き直す */
function ensureTorchAt(job, u, v) {
    const rec = job.torches.find((t) => t.u === u && t.v === v);
    if (!rec) return;
    const b = getBlockSafe(job.dim, rec.spot);
    if (!b || b.typeId.includes("torch")) return;
    if (placeTorch(job, rec.spot, rec.wall)) job.stats.replaced++;
}

// ---------- 村人の動き ----------

function equipPickaxe(villager) {
    try {
        const eq = villager.getComponent("minecraft:equippable");
        if (eq) {
            eq.setEquipment(EquipmentSlot.Mainhand, new ItemStack(TUNNEL.PICKAXE_ITEM_ID, 1));
            return;
        }
    } catch {}
    try {
        villager.runCommand(`replaceitem entity @s slot.weapon.mainhand 0 ${TUNNEL.PICKAXE_ITEM_ID}`);
    } catch {}
}

/** 目的地へ1tick分だけ進む。到着したら true。 */
function stepToward(villager, target) {
    const loc = villager.location;
    const dx = target.x - loc.x;
    const dz = target.z - loc.z;
    const dist = Math.hypot(dx, dz);
    const next = dist <= TUNNEL.WALK_SPEED
        ? { x: target.x, y: target.y, z: target.z }
        : { x: loc.x + (dx / dist) * TUNNEL.WALK_SPEED, y: target.y, z: loc.z + (dz / dist) * TUNNEL.WALK_SPEED };
    try {
        villager.teleport(next, { facingLocation: { x: target.x, y: target.y + 1.6, z: target.z } });
    } catch (e) {
        console.warn(`[RVB] teleport failed: ${e}`);
        if (!stepToward.warned) {
            stepToward.warned = true;
            try { world.sendMessage(`§c[RVB]§r teleport失敗: ${e}`); } catch {}
        }
    }
    return dist <= TUNNEL.WALK_SPEED;
}

// ---------- 格子の探索 ----------

function isTarget(job, u, v) {
    return u >= 0 && u <= job.U && Math.abs(v) <= job.W &&
        (mod(u, GRID.PITCH) === 0 || mod(v, GRID.PITCH) === 0);
}

function countTargets(job) {
    let n = 0;
    for (let u = 0; u <= job.U; u++) for (let v = -job.W; v <= job.W; v++) if (isTarget(job, u, v)) n++;
    return n;
}

/**
 * いま居るセルから、掘ってあるセルをたどって最も近い「まだ掘っていない目標セル」を探す。
 * @returns {{path: {u:number,v:number}[], target: {u:number,v:number,hu:number,hv:number}}|null}
 */
function nextFrontier(job) {
    const start = job.pos;
    const prev = new Map([[ck(start.u, start.v), null]]);
    const queue = [{ u: start.u, v: start.v }];
    for (let qi = 0; qi < queue.length; qi++) {
        const c = queue[qi];
        for (const [du, dv] of NEIGHBORS) {
            const nu = c.u + du;
            const nv = c.v + dv;
            const k = ck(nu, nv);
            if (isTarget(job, nu, nv) && !job.mined.has(k) && !job.blocked.has(k)) {
                return { path: pathTo(prev, c), target: { u: nu, v: nv, hu: du, hv: dv } };
            }
        }
        for (const [du, dv] of NEIGHBORS) {
            const nu = c.u + du;
            const nv = c.v + dv;
            const k = ck(nu, nv);
            if (job.mined.has(k) && !prev.has(k)) {
                prev.set(k, c);
                queue.push({ u: nu, v: nv });
            }
        }
    }
    return null;
}

function pathTo(prev, cell) {
    const path = [];
    let c = cell;
    while (c && prev.get(ck(c.u, c.v)) !== null) {
        path.push({ u: c.u, v: c.v });
        c = prev.get(ck(c.u, c.v));
    }
    return path.reverse();
}

/** 掘ってあるセルだけを通って from から to へ行く経路(from は含まない) */
function bfsPath(job, from, to) {
    const prev = new Map([[ck(from.u, from.v), null]]);
    const queue = [{ u: from.u, v: from.v }];
    for (let qi = 0; qi < queue.length; qi++) {
        const c = queue[qi];
        if (c.u === to.u && c.v === to.v) return pathTo(prev, c);
        for (const [du, dv] of NEIGHBORS) {
            const nu = c.u + du;
            const nv = c.v + dv;
            const k = ck(nu, nv);
            if (job.mined.has(k) && !prev.has(k)) {
                prev.set(k, c);
                queue.push({ u: nu, v: nv });
            }
        }
    }
    return [];
}

// ---------- 状態遷移 ----------

function abortToStairs(job, reason) {
    job.abortReason = reason;
    say(job, `中止して戻ります: ${reason}`);
    job.phase = PHASE.STAIR_UP;
}

function enterGrid(job) {
    job.pos = { u: 0, v: 0 };
    job.mined.add(ck(0, 0));
    job.cellsTotal = countTargets(job);
    say(job, `坑道の入口に到着 (Y=${job.targetY})。升目状に広げます: 前方${job.U} / 左右${job.W} / 間隔${GRID.PITCH} / 目標${job.cellsTotal}セル`);
    job.phase = PHASE.GRID_PLAN;
}

function finish(job) {
    job.phase = PHASE.DONE;
    const moved = depositAll(job);
    const loc = job.villager.location;
    const o = stairCenter(job, 0);
    const back = Math.hypot(loc.x - o.x, loc.y - o.y, loc.z - o.z);
    const returned = back <= TUNNEL.RETURN_TOLERANCE;
    const verdict = returned && !job.abortReason ? "§a合格" : returned ? "§6帰還のみ成功(途中中止)" : "§c不合格";
    const iron = moved[ORE.DROP_ITEM_ID] ?? 0;
    say(job, `${verdict}§r  階段${job.D}段 / 坑道${job.mined.size}セル(通行止め${job.blocked.size}) / 鉄鉱石${job.stats.ore}個(うち露出${job.stats.exposedOre}) → チェストへ${iron}個${job.stats.lost ? ` §c(入りきらず${job.stats.lost}個)§r` : ""} / 松明 坑道${job.stats.torches}本・階段${job.stats.stairTorches}本(置き直し${job.stats.replaced}本) / 出発点まで${back.toFixed(2)}ブロック / ${job.tick}tick`);
}

function tickJob(job) {
    job.tick++;
    checkTorch(job);
    if (!valid(job.villager)) {
        say(job, "村人がいなくなったため終了");
        return false;
    }
    if (job.tick > job.maxTicks) {
        say(job, "時間切れ。村人を消して終了");
        try { job.villager.remove(); } catch {}
        return false;
    }

    switch (job.phase) {
        case PHASE.STAIR_DIG: {
            if (job.timer-- > 0) break;
            const next = job.n + 1;
            const entering = next >= job.D;
            const spec = entering ? gridSpec(job, 0, 0, 1, 0) : stairSpec(job, next);
            const problem = checkSpec(job, spec);
            if (problem) {
                abortToStairs(job, problem);
                break;
            }
            carveSpec(job, spec);
            if (entering) {
                mineExposed(job, spec);
                maybeTorch(job, 0, 0, spec);
            } else {
                maybeStairTorch(job, next, spec);
            }
            job.phase = PHASE.STAIR_WALK;
            break;
        }
        case PHASE.STAIR_WALK: {
            if (stepToward(job.villager, stairCenter(job, job.n + 1))) {
                job.n++;
                if (job.n % 8 === 0) say(job, `下降 ${job.n}/${job.D}  Y=${yAt(job, job.n)}`);
                if (job.n >= job.D) {
                    enterGrid(job);
                } else {
                    job.phase = PHASE.STAIR_DIG;
                    job.timer = TUNNEL.DIG_TICKS;
                }
            }
            break;
        }
        case PHASE.GRID_PLAN: {
            const plan = nextFrontier(job);
            if (!plan) {
                say(job, `坑道を掘り終えました。戻ります (${job.mined.size}セル)`);
                job.returning = true;
                job.path = bfsPath(job, job.pos, { u: 0, v: 0 });
                job.afterPath = "STAIR_UP";
                ensureTorchAt(job, job.pos.u, job.pos.v);
                job.phase = PHASE.WALK_PATH;
                break;
            }
            job.path = plan.path;
            job.digTarget = plan.target;
            job.afterPath = "GRID_DIG";
            job.phase = PHASE.WALK_PATH;
            break;
        }
        case PHASE.WALK_PATH: {
            if (job.path.length === 0) {
                if (job.afterPath === "GRID_DIG") {
                    job.phase = PHASE.GRID_DIG;
                    job.timer = TUNNEL.DIG_TICKS;
                } else {
                    job.n = job.D;
                    job.phase = PHASE.STAIR_UP;
                }
                break;
            }
            const nxt = job.path[0];
            if (stepToward(job.villager, gridCenter(job, nxt.u, nxt.v))) {
                job.path.shift();
                job.pos = { u: nxt.u, v: nxt.v };
                if (job.returning) ensureTorchAt(job, nxt.u, nxt.v);
            }
            break;
        }
        case PHASE.GRID_DIG: {
            if (job.timer-- > 0) break;
            const t = job.digTarget;
            const key = ck(t.u, t.v);
            const spec = gridSpec(job, t.u, t.v, t.hu, t.hv);
            const problem = checkSpec(job, spec);
            if (problem) {
                job.blocked.add(key);
                if (job.blocked.size <= 5) say(job, `通行止め (${t.u},${t.v}): ${problem}`);
                job.phase = PHASE.GRID_PLAN;
                break;
            }
            carveSpec(job, spec);
            mineExposed(job, spec);
            maybeTorch(job, t.u, t.v, spec);
            job.mined.add(key);
            job.phase = PHASE.GRID_STEP;
            break;
        }
        case PHASE.GRID_STEP: {
            const t = job.digTarget;
            if (stepToward(job.villager, gridCenter(job, t.u, t.v))) {
                job.pos = { u: t.u, v: t.v };
                if (job.mined.size % 10 === 0) {
                    say(job, `坑道 ${job.mined.size}/${job.cellsTotal}セル / 鉄鉱石${job.stats.ore}個`);
                }
                job.phase = PHASE.GRID_PLAN;
            }
            break;
        }
        case PHASE.STAIR_UP: {
            if (job.ensuredStair !== job.n) {
                job.ensuredStair = job.n;
                ensureStairTorch(job, job.n);
            }
            if (job.n <= 0) {
                finish(job);
                break;
            }
            if (stepToward(job.villager, stairCenter(job, job.n - 1))) job.n--;
            break;
        }
        case PHASE.DONE:
            return false;
    }
    return true;
}

function ensureLoop() {
    if (loopId !== null) return;
    loopId = system.runInterval(() => {
        for (const [key, job] of jobs) {
            let alive = false;
            try {
                alive = tickJob(job) && job.phase !== PHASE.DONE;
            } catch (e) {
                console.warn(`[RVB] tunnel job error: ${e}`);
                say(job, `§cエラーで停止: ${e}`);
            }
            if (!alive) {
                jobs.delete(key);
                releaseJob(job);
                // 終了後、村人は少し見せてから消す
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

// ---------- 予約 ----------

/** この仕事が使う範囲(階段の全セル・坑道の升目全体・チェスト)の予約箱 */
function reservationBoxes(job) {
    const boxes = [];
    const H = TUNNEL.STAIR_HEIGHT;
    for (let n = 0; n < job.D; n++) {
        boxes.push(boxFromPoints(
            stairBlock(job, n, -STAIR_HALF - 1, -1),
            stairBlock(job, n, STAIR_HALF + 1, H)
        ));
    }
    // 坑道全体(入口の1つ手前から、前方・左右の端の外側1マスまで)
    boxes.push(boxFromPoints(
        gridBlock(job, -1, -job.W - TUNNEL_HALF - 1, -1),
        gridBlock(job, job.U + TUNNEL_HALF + 1, job.W + TUNNEL_HALF + 1, TUNNEL.HEIGHT)
    ));
    // チェスト
    boxes.push(boxFromPoints(job.chestPos, job.chestPos));
    return boxes;
}

function releaseJob(job) {
    release(job.owner.id);
}

// ---------- 開始(ベル・チェスト・向きの決定) ----------

/** 足元の地面の高さ(立てるY)を ref の近くから探す。見つからなければ null。 */
function groundY(dim, x, z, ref) {
    for (let y = ref + 4; y >= ref - 6; y--) {
        const here = getBlockSafe(dim, { x, y, z });
        const below = getBlockSafe(dim, { x, y: y - 1, z });
        if (!here || !below) continue;
        if (isSolidBlock(below) && (here.isAir || isPlant(here.typeId))) return y;
    }
    return null;
}

/** プレイヤーの周りで一番近いベルを探す */
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
                const p = { x: cx + dx, y: cy + dy, z: cz + dz };
                const b = getBlockSafe(dim, p);
                if (b && b.typeId === BASE.BELL_ID) {
                    const d = dx * dx + dy * dy + dz * dz;
                    if (d < bestD) {
                        bestD = d;
                        best = p;
                    }
                }
            }
        }
    }
    return best;
}

function placeChest(dim, pos) {
    const b = getBlockSafe(dim, pos);
    if (!b) return false;
    if (b.typeId === BASE.CHEST_ID) return true;
    if (!b.isAir && !isPlant(b.typeId)) return false;
    try {
        b.setType(BASE.CHEST_ID);
        return true;
    } catch (e) {
        console.warn(`[RVB] chest failed: ${e}`);
        return false;
    }
}

/**
 * 拠点 B(ベル、無ければプレイヤーの足元)を基準に、方向 d を試す。
 * チェスト C = B+d、出発点 S = B+2d。階段は d の向きへ掘り下る。
 * 階段の全経路を先に検査して通れる方向だけ採用する。
 * @returns {{job: any}|{reason: string}}
 */
function layoutAround(player, B, dirs, opts) {
    const dim = player.dimension;
    let lastReason = "no-direction";
    for (const d of dirs) {
        const dir = { x: d[0], z: d[1] };
        const C = { x: B.x + dir.x, z: B.z + dir.z };
        const S = { x: B.x + dir.x * 2, z: B.z + dir.z * 2 };
        const cy = groundY(dim, C.x, C.z, B.y);
        const sy = groundY(dim, S.x, S.z, B.y);
        if (cy === null || sy === null || Math.abs(cy - sy) > 1) {
            lastReason = "ground-not-flat";
            continue;
        }
        const D = sy - opts.targetY;
        if (D < 1) return { reason: `今いる高さ(Y=${sy})が目標のY=${opts.targetY}以下です。地表で実行してください` };

        const job = {
            owner: player,
            dim,
            dir,
            side: { x: -dir.z, z: dir.x }, // 進行方向の右
            origin: { x: S.x, z: S.z },
            base: { x: S.x + dir.x * D, z: S.z + dir.z * D },
            y0: sy,
            targetY: opts.targetY,
            D,
            U: opts.length,
            W: opts.side,
            chestPos: { x: C.x, y: cy, z: C.z },
            n: 0,
            pos: { u: 0, v: 0 },
            mined: new Set(),
            blocked: new Set(),
            torches: [],
            stairTorches: new Map(),
            ensuredStair: -1,
            torchCheck: null,
            path: [],
            digTarget: null,
            afterPath: null,
            returning: false,
            cellsTotal: 0,
            phase: PHASE.STAIR_DIG,
            timer: TUNNEL.DIG_TICKS,
            tick: 0,
            maxTicks: 0,
            villager: null,
            abortReason: null,
            carried: {},
            stats: { blocks: 0, ore: 0, insideOre: 0, exposedOre: 0, lost: 0, torches: 0, stairTorches: 0, replaced: 0 }
        };
        job.maxTicks = TUNNEL.MAX_TICKS_BASE + D * TUNNEL.MAX_TICKS_PER_STAIR + countTargets(job) * TUNNEL.MAX_TICKS_PER_CELL;

        // 階段の全経路(と坑道の入口)を事前検査
        let problem = null;
        for (let n = 0; n < D && !problem; n++) problem = checkSpec(job, stairSpec(job, n));
        if (!problem) problem = checkSpec(job, gridSpec(job, 0, 0, 1, 0));
        if (problem) {
            lastReason = problem;
            continue;
        }
        // 他の仕事が予約している範囲と重なっていないか
        job.boxes = reservationBoxes(job);
        const conflict = findConflict(dim.id, job.boxes, player.id);
        if (conflict) {
            lastReason = `reserved-by:${conflict.label}`;
            continue;
        }
        return { job };
    }
    return { reason: lastReason };
}

/**
 * @param {import("@minecraft/server").Player} player
 * @param {{length?: number, targetY?: number, side?: number}} opts
 */
export function startTunnelTest(player, opts = {}) {
    const key = player.id;
    if (jobs.has(key)) {
        player.sendMessage("§e[RVB]§r すでに坑道テストが走っています。止めるなら rvb:tunnel_stop");
        return;
    }
    const o = {
        length: Math.max(1, Math.min(GRID.MAX_LENGTH, opts.length ?? GRID.DEFAULT_LENGTH)),
        side: Math.max(0, Math.min(GRID.MAX_SIDE, opts.side ?? GRID.DEFAULT_SIDE)),
        targetY: Math.max(TUNNEL.MIN_TARGET_Y, opts.targetY ?? TUNNEL.TARGET_Y)
    };

    const dim = player.dimension;
    const p = player.location;
    const bell = findBell(dim, p);

    let res;
    let where;
    if (bell) {
        // 4方向のうち、プレイヤーから遠ざかる向きを優先
        const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]]
            .sort((a, b) => (b[0] * (bell.x - p.x) + b[1] * (bell.z - p.z)) - (a[0] * (bell.x - p.x) + a[1] * (bell.z - p.z)));
        res = layoutAround(player, bell, dirs, o);
        where = `ベル(${bell.x},${bell.y},${bell.z})のそば`;
    } else {
        // ベルが無ければ、プレイヤーの足元を基準に、見ている方角へ
        const vd = player.getViewDirection();
        const d = Math.abs(vd.x) > Math.abs(vd.z) ? [Math.sign(vd.x), 0] : [0, Math.sign(vd.z) || 1];
        res = layoutAround(player, { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }, [d], o);
        where = "ベルが見つからないのでプレイヤー位置";
    }
    if (!res.job) {
        player.sendMessage(`§c[RVB]§r ここでは始められません: ${res.reason}`);
        return;
    }
    const job = res.job;

    if (!placeChest(dim, job.chestPos)) {
        player.sendMessage(`§c[RVB]§r チェストを置けません @${job.chestPos.x},${job.chestPos.y},${job.chestPos.z}`);
        return;
    }
    carveSpec(job, stairSpec(job, 0));

    try {
        const v = dim.spawnEntity(TUNNEL.VILLAGER_TYPE_ID, stairCenter(job, 0));
        v.addTag(TUNNEL.VILLAGER_TAG);
        v.nameTag = TUNNEL.VILLAGER_NAME;
        job.villager = v;
    } catch (e) {
        player.sendMessage(`§c[RVB]§r 村人を出せませんでした: ${e}`);
        return;
    }
    equipPickaxe(job.villager);

    reserve(player.id, `RVB坑道(${player.name ?? player.id})`, dim.id, job.boxes);
    jobs.set(key, job);
    ensureLoop();
    player.sendMessage(
        `§e[RVB v${RVB_VERSION}]§r 開始 今のY=${job.y0}→目標Y=${job.targetY}。階段${job.D}段(${TUNNEL.STAIR_WIDTH}×${TUNNEL.STAIR_HEIGHT})、` +
        `坑道は前方${job.U}・左右${job.W}の升目 / ${where} / チェスト ${job.chestPos.x},${job.chestPos.y},${job.chestPos.z} / 出発点 ${job.origin.x},${job.y0},${job.origin.z}`
    );
}

export function stopTunnelTest(player) {
    const job = jobs.get(player.id);
    if (!job) {
        player.sendMessage("§e[RVB]§r 走っている坑道テストはありません");
        return;
    }
    try { job.villager.remove(); } catch {}
    jobs.delete(player.id);
    releaseJob(job);
    player.sendMessage("§e[RVB]§r 坑道テストを止めて村人を消しました");
}
