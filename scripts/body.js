/**
 * RVB 体:村人の体の大きさと、ブロックとの当たり判定、迂回の経路探索。
 * 「テレポートで動かす」方式でも、動く前に必ず体の箱が固いブロックに重ならないか調べ、
 * 重なるなら動かずに別の道を探す。仕事(倉庫・伐採など)はここを通って移動する。
 *
 *   const mover = createMover(dim, villager);
 *   const r = mover.goTo({x, z});    // "arrived" | "moving" | "blocked"
 *   rescueIfEmbedded(dim, villager); // 万一めり込んでいたら外へ出す
 */

import { BODY, WAREHOUSE } from "./config.js";
import { getBlockSafe, isSolidBlock, isPlant } from "./util.js";

/** そのセルは体が通れない(固い。読み込まれていないセルも通れない扱い) */
export function cellBlocked(dim, x, y, z) {
    const b = getBlockSafe(dim, { x, y, z });
    if (!b) return true;
    if (b.isAir || isPlant(b.typeId)) return false;
    if (/torch|carpet|pressure_plate|button|rail|sign/.test(b.typeId)) return false;
    return isSolidBlock(b);
}

/** 位置 loc(足元の座標)に体を置いたとき、固いブロックに重なるか */
export function bodyOverlaps(dim, loc, extra = null) {
    const h = BODY.WIDTH / 2;
    const x0 = Math.floor(loc.x - h);
    const x1 = Math.floor(loc.x + h);
    const z0 = Math.floor(loc.z - h);
    const z1 = Math.floor(loc.z + h);
    // 足元が少し低いブロック(道 15/16、土のくぼみなど)の上に立つと y が整数より少し小さくなる。0.1 の許容を持たせる
    const y0 = Math.floor(loc.y + 0.1);
    const y1 = Math.floor(loc.y + BODY.HEIGHT - 0.001);
    for (let x = x0; x <= x1; x++) {
        for (let z = z0; z <= z1; z++) {
            for (let y = y0; y <= y1; y++) {
                if (extra && extra.x === x && extra.y === y && extra.z === z) return true;
                if (cellBlocked(dim, x, y, z)) return true;
            }
        }
    }
    return false;
}

/** セル (x,y,z) に立てる(足元が空いていて、頭も空いていて、下が固い) */
export function standable(dim, x, y, z) {
    return !cellBlocked(dim, x, y, z) && !cellBlocked(dim, x, y + 1, z) && cellBlocked(dim, x, y - 1, z);
}

/** 近くの立てるセルを探す(螺旋状に外へ)。無ければ null */
export function nearestStandable(dim, x, y, z, radius = BODY.RESCUE_RADIUS) {
    for (let r = 0; r <= radius; r++) {
        for (let dx = -r; dx <= r; dx++) {
            for (let dz = -r; dz <= r; dz++) {
                if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
                for (const yy of [y, y + 1, y - 1, y + 2, y - 2, y + 3, y - 3]) {
                    if (standable(dim, x + dx, yy, z + dz)) return { x: x + dx, y: yy, z: z + dz };
                }
            }
        }
    }
    return null;
}

/** めり込んでいたら、近くの立てる所へ出す。出したら true。 */
export function rescueIfEmbedded(dim, villager, extra = null) {
    const loc = villager.location;
    if (!bodyOverlaps(dim, loc, extra)) return false;
    const c = nearestStandable(dim, Math.floor(loc.x), Math.floor(loc.y), Math.floor(loc.z));
    if (!c) return false;
    try {
        villager.teleport({ x: c.x + 0.5, y: c.y, z: c.z + 0.5 });
    } catch (e) {
        console.warn(`[RVB] rescue failed: ${e}`);
    }
    return true;
}

const D4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/**
 * (sx,sy,sz) から水平の目的地 (tx,tz) までの、立てるセルをたどる経路。
 * 段差は上り MAX_STEP_UP・下り MAX_DROP まで。見つからなければ null。
 */
export function findPath(dim, start, goal) {
    const minX = Math.min(start.x, goal.x) - BODY.PATH_MARGIN;
    const maxX = Math.max(start.x, goal.x) + BODY.PATH_MARGIN;
    const minZ = Math.min(start.z, goal.z) - BODY.PATH_MARGIN;
    const maxZ = Math.max(start.z, goal.z) + BODY.PATH_MARGIN;
    const k = (x, y, z) => `${x},${y},${z}`;
    const prev = new Map([[k(start.x, start.y, start.z), null]]);
    const queue = [start];
    let found = null;
    let best = start;
    let bestD = Math.abs(start.x - goal.x) + Math.abs(start.z - goal.z);
    for (let qi = 0; qi < queue.length && qi < BODY.PATH_MAX_NODES; qi++) {
        const c = queue[qi];
        const d = Math.abs(c.x - goal.x) + Math.abs(c.z - goal.z);
        if (d < bestD) {
            bestD = d;
            best = c;
        }
        if (c.x === goal.x && c.z === goal.z) {
            found = c;
            break;
        }
        for (const [dx, dz] of D4) {
            const nx = c.x + dx;
            const nz = c.z + dz;
            if (nx < minX || nx > maxX || nz < minZ || nz > maxZ) continue;
            const ys = [c.y, c.y + 1, c.y - 1, c.y - 2, c.y - 3].filter((y) => y - c.y <= BODY.MAX_STEP_UP && c.y - y <= BODY.MAX_DROP);
            for (const ny of ys) {
                if (prev.has(k(nx, ny, nz))) continue;
                if (!standable(dim, nx, ny, nz)) continue;
                // 登るときは、元の場所の頭上も空いている必要がある
                if (ny > c.y && cellBlocked(dim, c.x, c.y + 2, c.z)) continue;
                // 降りるときは、移った先の頭上(元の高さの頭)が空いている必要がある
                if (ny < c.y && cellBlocked(dim, nx, c.y + 1, nz)) continue;
                prev.set(k(nx, ny, nz), c);
                queue.push({ x: nx, y: ny, z: nz });
                break;
            }
        }
    }
    const end = found ?? null;
    if (!end) return null;
    const path = [];
    for (let c = end; c; c = prev.get(k(c.x, c.y, c.z))) path.push(c);
    path.reverse();
    return path;
}

/**
 * 体の大きさを守って歩かせる係。goTo() を毎tick呼ぶ。
 *  - 次の一歩で体の箱が固いブロックに重なるなら動かない(経路を探し直す)
 *  - 道がふさがれたら迂回する。道が無ければ "blocked"
 */
export function createMover(dim, villager, speed = WAREHOUSE.WALK_SPEED) {
    let path = null;
    let pi = 0;
    let goalKey = "";
    let sinceRepath = 1e9;
    let stuck = 0;

    return {
        /** @returns {"arrived"|"moving"|"blocked"} */
        goTo(target, tolerance = 0.2) {
            const loc = villager.location;
            if (Math.hypot(target.x - loc.x, target.z - loc.z) <= tolerance) return "arrived";
            rescueIfEmbedded(dim, villager);
            const gx = Math.floor(target.x);
            const gz = Math.floor(target.z);
            const key = `${gx},${gz}`;
            sinceRepath++;
            const cx = Math.floor(villager.location.x);
            const cy = Math.floor(villager.location.y + 0.1);
            const cz = Math.floor(villager.location.z);
            const needPath = !path || key !== goalKey || (pi < path.length && !standable(dim, path[pi].x, path[pi].y, path[pi].z));
            if (needPath && (sinceRepath >= BODY.REPATH_TICKS || key !== goalKey)) {
                sinceRepath = 0;
                goalKey = key;
                let start = { x: cx, y: cy, z: cz };
                if (!standable(dim, start.x, start.y, start.z)) {
                    const s = nearestStandable(dim, cx, cy, cz, 2);
                    if (s) start = s;
                }
                path = findPath(dim, start, { x: gx, z: gz });
                pi = 1;
                if (!path) {
                    stuck++;
                    return stuck > BODY.STUCK_TICKS / BODY.REPATH_TICKS ? "blocked" : "moving";
                }
            }
            if (!path) {
                stuck++;
                return stuck > BODY.STUCK_TICKS ? "blocked" : "moving";
            }
            stuck = 0;
            // 次の中継点(セル中心)。最後のセルでは目的地の座標そのもの
            const last = pi >= path.length - 1;
            const wp = path[Math.min(pi, path.length - 1)];
            const tx = last ? target.x : wp.x + 0.5;
            const tz = last ? target.z : wp.z + 0.5;
            const dx = tx - loc.x;
            const dz = tz - loc.z;
            const dist = Math.hypot(dx, dz);
            const step = Math.min(speed, dist);
            const nx = dist < 1e-6 ? tx : loc.x + (dx / dist) * step;
            const nz = dist < 1e-6 ? tz : loc.z + (dz / dist) * step;
            // 段差:登るときは先に高さを上げてから進む。降りるときは、下げても体が当たらなくなってから下げる
            let ny = loc.y;
            if (wp.y > loc.y) ny = wp.y;
            else if (wp.y < loc.y && !bodyOverlaps(dim, { x: nx, y: wp.y, z: nz })) ny = wp.y;
            const np = { x: nx, y: ny, z: nz };
            if (bodyOverlaps(dim, np)) {
                // 体が当たる:この道は使えない。探し直す
                path = null;
                sinceRepath = BODY.REPATH_TICKS;
                return "moving";
            }
            try {
                villager.teleport(np, { facingLocation: { x: tx, y: ny + 1.6, z: tz } });
            } catch (e) {
                console.warn(`[RVB] teleport failed: ${e}`);
            }
            if (dist <= speed + 1e-6 && !last) pi++;
            return last && dist <= speed + 1e-6 ? "arrived" : "moving";
        }
    };
}
