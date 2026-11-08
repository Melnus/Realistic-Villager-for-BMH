/** RVB 共通の小物。tunnel.js と同じ振る舞いのコピー(tunnel.js は動作確認済みなので触らない)。 */

import { WAREHOUSE } from "./config.js";

export function valid(entity) {
    if (!entity) return false;
    try {
        // バージョンにより isValid はメソッドだったりプロパティだったりする
        return typeof entity.isValid === "function" ? entity.isValid() : !!entity.isValid;
    } catch {
        return false;
    }
}

export function getBlockSafe(dim, pos) {
    try {
        return dim.getBlock(pos);
    } catch {
        return undefined;
    }
}

export function isLiquidBlock(block) {
    try {
        if (block.isLiquid) return true;
    } catch {}
    return /(^|:)(flowing_)?(water|lava)$/.test(block.typeId);
}

export const isSolidBlock = (block) => !!block && !block.isAir && !isLiquidBlock(block);

export const isPlant = (typeId) =>
    /(short_grass|tall_grass|tallgrass|fern|flower|tulip|dandelion|poppy|orchid|allium|azure_bluet|cornflower|lily|rose_bush|peony|sapling|mushroom|wildflowers|pink_petals|bush)/.test(typeId);

export function inventoryOf(entity) {
    try {
        return entity.getComponent("minecraft:inventory")?.container ?? null;
    } catch {
        return null;
    }
}

/** 足元の地面の高さ(立てるY)を ref の近くから探す。見つからなければ null。 */
export function groundY(dim, x, z, ref, up = 4, down = 6) {
    for (let y = ref + up; y >= ref - down; y--) {
        const here = getBlockSafe(dim, { x, y, z });
        const below = getBlockSafe(dim, { x, y: y - 1, z });
        if (!here || !below) continue;
        if (isSolidBlock(below) && (here.isAir || isPlant(here.typeId))) return y;
    }
    return null;
}

/** 東西南北の名前(+x=east, +z=south) */
export const dirName = (dx, dz) => (Math.abs(dx) >= Math.abs(dz) ? (dx > 0 ? "east" : "west") : (dz > 0 ? "south" : "north"));

export function say(owner, text, tag = "RVB") {
    try {
        if (valid(owner)) {
            owner.sendMessage(`§e[${tag}]§r ${text}`);
            return;
        }
    } catch {}
    console.warn(`[${tag}] ${text}`);
}

/** 目的地(水平)へ1tick分だけ進む。Yは地面に合わせる。到着したら true。 */
export function walkToward(dim, villager, target, speed = WAREHOUSE.WALK_SPEED) {
    const loc = villager.location;
    const dx = target.x - loc.x;
    const dz = target.z - loc.z;
    const dist = Math.hypot(dx, dz);
    const nx = dist <= speed ? target.x : loc.x + (dx / dist) * speed;
    const nz = dist <= speed ? target.z : loc.z + (dz / dist) * speed;
    const gy = groundY(dim, Math.floor(nx), Math.floor(nz), Math.floor(loc.y), 3, 4);
    try {
        villager.teleport({ x: nx, y: gy ?? loc.y, z: nz }, { facingLocation: { x: target.x, y: (gy ?? loc.y) + 1.6, z: target.z } });
    } catch (e) {
        console.warn(`[RVB] teleport failed: ${e}`);
    }
    return dist <= speed;
}
