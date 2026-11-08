/**
 * RVB 戦闘(マイルストーン3):1対1。
 *   近接:斧を持ち、盾を構えて受ける。斬る瞬間だけ盾を下げる。
 *   遠距離:クロスボウで矢を撃つ(本物の矢のエンティティ。ダメージはゲームの計算)。
 * 盾は「正面から来た攻撃で減ったHPを戻す」方式で再現する(afterEvents.entityHurt)。
 * 動きは body.js の移動を使う(体の当たり判定を守る)。
 */

import { system, world, ItemStack } from "@minecraft/server";
import { COMBAT, TUNNEL, RVB_VERSION } from "./config.js";
import { valid, inventoryOf, say } from "./util.js";
import { createMover, cellBlocked } from "./body.js";
import { watch } from "./debug.js";

const TAG = "RVB 戦闘";

/** @type {Map<string, any>} プレイヤーid -> 戦闘テスト */
const fights = new Map();
let loopId = null;
let hookSet = false;

const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const distXZ = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

function equip(v, mainhand, offhand) {
    try { v.runCommand(`replaceitem entity @s slot.weapon.mainhand 0 ${mainhand.replace("minecraft:", "")}`); } catch (e) { console.warn(`[RVB] equip main failed: ${e}`); }
    try { v.runCommand(`replaceitem entity @s slot.weapon.offhand 0 ${offhand.replace("minecraft:", "")}`); } catch (e) { console.warn(`[RVB] equip off failed: ${e}`); }
}

function healthComp(e) {
    try { return e.getComponent("minecraft:health"); } catch { return null; }
}

function countItem(v, id) {
    const c = inventoryOf(v);
    if (!c) return 0;
    let n = 0;
    for (let i = 0; i < c.size; i++) {
        const it = c.getItem(i);
        if (it && it.typeId === id) n += it.amount;
    }
    return n;
}

function useOne(v, id) {
    const c = inventoryOf(v);
    if (!c) return false;
    for (let i = 0; i < c.size; i++) {
        const it = c.getItem(i);
        if (it && it.typeId === id) {
            if (it.amount > 1) {
                it.amount -= 1;
                c.setItem(i, it);
            } else {
                c.setItem(i, undefined);
            }
            return true;
        }
    }
    return false;
}

/** 周りの敵(モンスター族)を近い順に */
function listEnemies(f) {
    const loc = f.villager.location;
    let list = [];
    try {
        list = f.dim.getEntities({ families: ["monster"], location: loc, maxDistance: COMBAT.DETECT_RANGE });
    } catch (e) {
        console.warn(`[RVB] getEntities failed: ${e}`);
    }
    return list
        .filter((e) => {
            if (!valid(e) || e === f.villager) return false;
            const h = healthComp(e);
            return !(h && h.currentValue <= 0);
        })
        .sort((a, b) => dist3(loc, a.location) - dist3(loc, b.location));
}

/** いま相手にできる敵(足元より低すぎない・届かないと分かった敵は除く) */
function pickEnemy(f, list) {
    const v = f.villager.location;
    for (const e of list) {
        const d = distXZ(v, e.location);
        const dy = e.location.y - v.y;
        if (f.held === e) return e;
        // 近い敵は、段差が小さければ捕まえに行ける
        if (d <= COMBAT.MELEE_ENTER && Math.abs(dy) <= 1.5) return e;
        if (dy < -COMBAT.MAX_BELOW) continue; // 自分より低い所の敵は狙わない
        if (d > COMBAT.RANGE_MAX) continue;
        if ((f.skipUntil.get(e.id) ?? 0) > f.tick) continue; // 矢が届かないと分かった敵
        return e;
    }
    return null;
}

/** 矢を撃ったとして、地形に当たらずに敵まで届くか(空気抵抗と重力をまねて飛ばして調べる) */
function arrowReaches(f, eye, dir, target) {
    let p = { x: eye.x + dir.x, y: eye.y + dir.y, z: eye.z + dir.z };
    let vel = { x: dir.x * COMBAT.ARROW_SPEED, y: dir.y * COMBAT.ARROW_SPEED, z: dir.z * COMBAT.ARROW_SPEED };
    const SUB = 4; // 1tickを細かく刻んで、敵の横を飛び越えたり壁をすり抜けたりしないようにする
    for (let i = 0; i < 80; i++) {
        for (let k = 0; k < SUB; k++) {
            p = { x: p.x + vel.x / SUB, y: p.y + vel.y / SUB, z: p.z + vel.z / SUB };
            if (Math.hypot(p.x - target.x, p.z - target.z) < 1.0 && p.y >= target.y - 0.3 && p.y <= target.y + 2.0) return true;
            if (cellBlocked(f.dim, Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))) return false;
        }
        vel = { x: vel.x * 0.99, y: vel.y * 0.99 - COMBAT.ARROW_GRAVITY, z: vel.z * 0.99 };
        if (p.y < target.y - 8) return false;
    }
    return false;
}

// ---------- 盾(受けたダメージを戻す) ----------

function setupHurtHook() {
    if (hookSet) return;
    hookSet = true;
    try {
        world.afterEvents.entityHurt.subscribe((ev) => {
            for (const f of fights.values()) {
                if (ev.hurtEntity === f.villager) onFighterHurt(f, ev);
                else if (ev.damageSource?.damagingEntity === f.villager) onEnemyHurt(f, ev);
            }
        });
    } catch (e) {
        console.warn(`[RVB] entityHurt hook failed: ${e}`);
    }
}

function onFighterHurt(f, ev) {
    const dmg = ev.damage ?? 0;
    f.stats.taken += dmg;
    const src = ev.damageSource?.damagingEntity;
    const cause = ev.damageSource?.cause;
    // 盾が上がっていて、攻撃元が正面側なら防ぐ(ダメージを戻す)
    if (!(f.shieldUp || f.held) || !src || !valid(src)) return;
    if (cause !== "entityAttack" && cause !== "projectile") return;
    const loc = f.villager.location;
    const from = src.location;
    let view = { x: 0, z: 1 };
    try { view = f.villager.getViewDirection(); } catch {}
    const dx = from.x - loc.x;
    const dz = from.z - loc.z;
    const len = Math.hypot(dx, dz) || 1;
    const vlen = Math.hypot(view.x, view.z) || 1;
    const dot = (dx / len) * (view.x / vlen) + (dz / len) * (view.z / vlen);
    if (!f.held && dot < COMBAT.SHIELD_DOT_MIN) return;
    const h = healthComp(f.villager);
    if (!h) return;
    try {
        h.setCurrentValue(Math.min(h.effectiveMax ?? 20, h.currentValue + dmg));
        f.stats.blocked += dmg;
        f.stats.blocks++;
        f.dim.playSound(COMBAT.SHIELD_SOUND, loc);
    } catch (e) {
        console.warn(`[RVB] shield heal failed: ${e}`);
    }
}

function onEnemyHurt(f, ev) {
    if (ev.damageSource?.cause === "projectile") {
        f.stats.arrowHits++;
        f.stats.dealt += ev.damage ?? 0;
    }
}

// ---------- 攻撃 ----------

function swingAxe(f, enemy) {
    try {
        enemy.applyDamage(COMBAT.AXE_DAMAGE, { cause: "entityAttack", damagingEntity: f.villager });
        f.stats.swings++;
        f.stats.dealt += COMBAT.AXE_DAMAGE;
        try { enemy.applyKnockback({ x: enemy.location.x - f.villager.location.x, z: enemy.location.z - f.villager.location.z }, 0.3); } catch {}
    } catch (e) {
        console.warn(`[RVB] applyDamage failed: ${e}`);
    }
}

/** @returns {"shot"|"unreachable"|"noammo"|"error"} */
function shootArrow(f, enemy) {
    const v = f.villager;
    if (countItem(v, COMBAT.ARROW_ITEM) <= 0) {
        f.stats.noAmmo++;
        return "noammo";
    }
    const eye = { x: v.location.x, y: v.location.y + COMBAT.EYE_HEIGHT, z: v.location.z };
    const tl = enemy.location;
    let tv = { x: 0, y: 0, z: 0 };
    try { tv = enemy.getVelocity(); } catch {}
    const d0 = dist3(eye, tl);
    const t = Math.max(1, d0 / COMBAT.ARROW_SPEED);
    // 動く敵の少し先を狙い、矢が落ちる分だけ上を狙う
    const aim = {
        x: tl.x + tv.x * t,
        y: tl.y + COMBAT.AIM_HEIGHT + tv.y * t + 0.5 * COMBAT.ARROW_GRAVITY * t * t,
        z: tl.z + tv.z * t
    };
    let dir = { x: aim.x - eye.x, y: aim.y - eye.y, z: aim.z - eye.z };
    const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
    dir = { x: dir.x / len, y: dir.y / len, z: dir.z / len };
    // 地形に遮られて届かないなら撃たない
    if (!arrowReaches(f, eye, dir, { x: tl.x + tv.x * t, y: tl.y, z: tl.z + tv.z * t })) {
        f.stats.refused++;
        return "unreachable";
    }
    useOne(v, COMBAT.ARROW_ITEM);
    try {
        v.teleport(v.location, { facingLocation: { x: tl.x, y: tl.y + 1, z: tl.z } });
    } catch {}
    try {
        const arrow = f.dim.spawnEntity("minecraft:arrow", { x: eye.x + dir.x * 1.0, y: eye.y + dir.y * 1.0, z: eye.z + dir.z * 1.0 });
        const pc = arrow.getComponent("minecraft:projectile");
        try { pc.owner = v; } catch {}
        pc.shoot({ x: dir.x * COMBAT.ARROW_SPEED, y: dir.y * COMBAT.ARROW_SPEED, z: dir.z * COMBAT.ARROW_SPEED });
        f.stats.arrows++;
        return "shot";
    } catch (e) {
        console.warn(`[RVB] shoot failed: ${e}`);
        return "error";
    }
}

// ---------- 捕まえて倒す ----------

function startHold(f, enemy) {
    const v = f.villager;
    const dx = enemy.location.x - v.location.x;
    const dz = enemy.location.z - v.location.z;
    const l = Math.hypot(dx, dz) || 1;
    f.holdDir = { x: dx / l, z: dz / l };
    f.held = enemy;
    f.holdTicks = 0;
    f.attackTimer = COMBAT.FIRST_SWING_DELAY;
    f.stats.grabs++;
    const dur = (COMBAT.HOLD_MAX_TICKS + 40);
    try { v.addEffect("resistance", dur, { amplifier: 255, showParticles: false }); } catch (e) { console.warn(`[RVB] resistance failed: ${e}`); }
    try { enemy.addEffect("slowness", dur, { amplifier: 5, showParticles: false }); } catch {}
    try { enemy.addEffect("weakness", dur, { amplifier: 5, showParticles: false }); } catch {}
    f.shieldUp = true;
}

function endHold(f) {
    const v = f.villager;
    f.held = null;
    try { v.removeEffect("resistance"); } catch {}
}

function holdTick(f) {
    const v = f.villager;
    const e = f.held;
    f.holdTicks++;
    if (!valid(e) || (healthComp(e)?.currentValue ?? 1) <= 0) {
        endHold(f);
        return;
    }
    if (f.holdTicks > COMBAT.HOLD_MAX_TICKS) {
        say(f.owner, "捕まえている時間が長すぎるので放しました", TAG);
        endHold(f);
        return;
    }
    // 敵を村人の正面に固定する
    const p = { x: v.location.x + f.holdDir.x * COMBAT.HOLD_DIST, y: v.location.y, z: v.location.z + f.holdDir.z * COMBAT.HOLD_DIST };
    try { e.teleport(p, { facingLocation: v.location }); } catch {}
    face(v, p);
    f.attackTimer--;
    if (f.attackTimer <= 0) {
        swingAxe(f, e);
        f.attackTimer = COMBAT.ATTACK_INTERVAL;
    }
}

// ---------- 状態 ----------

function setMode(f, mode) {
    if (f.mode === mode) return;
    f.mode = mode;
    if (mode === "MELEE") {
        equip(f.villager, COMBAT.AXE_ITEM, COMBAT.SHIELD_ITEM);
        f.shieldUp = true;
    } else if (mode === "RANGED") {
        equip(f.villager, COMBAT.CROSSBOW_ITEM, COMBAT.SHIELD_ITEM);
        f.shieldUp = false;
        f.cooldown = COMBAT.CROSSBOW_RELOAD;
    }
    f.stats.switches++;
}

function face(v, target) {
    try { v.teleport(v.location, { facingLocation: { x: target.x, y: target.y + 1, z: target.z } }); } catch {}
}

function tickFight(f) {
    f.tick++;
    if (!valid(f.villager)) return finish(f, "村人が倒れた/いなくなった");
    if (f.tick > COMBAT.MAX_TICKS) return finish(f, "時間切れ");
    const v = f.villager;

    if (f.endAt !== null) return f.tick >= f.endAt;

    // 捕まえている間は、それだけをする
    if (f.held) {
        holdTick(f);
        return false;
    }

    const list = listEnemies(f);
    const enemy = pickEnemy(f, list);
    if (list.length) f.spawned = true;
    if (!enemy) {
        f.idle++;
        if (f.spawned && f.idle > (list.length ? COMBAT.NO_TARGET_END : 20)) {
            f.endAt = f.tick + COMBAT.CLEANUP_TICKS;
            report(f, list.length ? `§6届かない敵が${list.length}体残っています(低い所/地形の向こう)。戦闘を終えます` : "§a敵を倒しました");
        }
        return false;
    }
    f.idle = 0;
    f.target = enemy;

    const d = dist3(v.location, enemy.location);
    const dxz = distXZ(v.location, enemy.location);
    // 近接⇄遠距離の切り替え(ヒステリシス)
    if (f.mode !== "MELEE" && d <= COMBAT.MELEE_ENTER) setMode(f, "MELEE");
    else if (f.mode !== "RANGED" && d >= COMBAT.MELEE_EXIT) setMode(f, "RANGED");
    else if (!f.mode) setMode(f, d <= COMBAT.MELEE_ENTER ? "MELEE" : "RANGED");

    if (f.mode === "RANGED") {
        f.shieldUp = false;
        face(v, enemy.location);
        if (f.cooldown-- <= 0) {
            const r = shootArrow(f, enemy);
            if (r === "shot") f.cooldown = COMBAT.CROSSBOW_RELOAD;
            else if (r === "unreachable") {
                f.skipUntil.set(enemy.id, f.tick + COMBAT.UNREACHABLE_RETRY);
                f.cooldown = 5;
            } else f.cooldown = 10;
        }
        return false;
    }

    // 近接:近づいたら捕まえる。離れていれば寄っていく
    face(v, enemy.location);
    if (dxz <= COMBAT.GRAB_REACH && Math.abs(enemy.location.y - v.location.y) <= 1.5) {
        startHold(f, enemy);
        return false;
    }
    f.mover.goTo({ x: enemy.location.x, z: enemy.location.z }, COMBAT.GRAB_REACH - 0.4);
    return false;
}

function report(f, head) {
    const s = f.stats;
    const h = healthComp(f.villager);
    say(f.owner,
        `${head}  /  与えた(推定)${s.dealt.toFixed(0)} 斧${s.swings}回・矢${s.arrows}本(命中${s.arrowHits})・受けた${s.taken.toFixed(1)} 防いだ${s.blocked.toFixed(1)}(${s.blocks}回)・矢切れ${s.noAmmo} / 村人HP ${h ? h.currentValue.toFixed(1) : "?"} / 切替${s.switches}回・捕獲${s.grabs}回・見送り(届かず)${s.refused} / ${f.tick}tick`, TAG);
}

function finish(f, why) {
    report(f, `§6${why}`);
    return true;
}

function cleanup(f) {
    for (const e of f.targets) { try { if (valid(e)) e.remove(); } catch {} }
    try { if (valid(f.villager)) f.villager.remove(); } catch {}
}

function ensureLoop() {
    if (loopId !== null) return;
    loopId = system.runInterval(() => {
        for (const [key, f] of fights) {
            let done = false;
            try {
                done = tickFight(f);
            } catch (e) {
                console.warn(`[RVB] fight error: ${e}`);
                say(f.owner, `§cエラーで停止: ${e}`, TAG);
                done = true;
            }
            if (done) {
                fights.delete(key);
                system.runTimeout(() => cleanup(f), 20);
            }
        }
        if (fights.size === 0) {
            system.clearRun(loopId);
            loopId = null;
        }
    }, 1);
}

// ---------- 公開API ----------

/** @param {import("@minecraft/server").Player} player */
export function startCombatTest(player, opts = {}) {
    if (fights.has(player.id)) {
        player.sendMessage("§e[RVB 戦闘]§r すでに走っています。止めるなら rvb:combat_stop");
        return;
    }
    const dim = player.dimension;
    const p = player.location;
    let view = { x: 1, z: 0 };
    try { view = player.getViewDirection(); } catch {}
    const vl = Math.hypot(view.x, view.z) || 1;
    const fwd = { x: view.x / vl, z: view.z / vl };

    // 村人はプレイヤーの前方 4 マス、敵はさらにその前方 SPAWN_DIST マス
    const base = { x: Math.floor(p.x + fwd.x * 4) + 0.5, y: p.y, z: Math.floor(p.z + fwd.z * 4) + 0.5 };
    let villager;
    try {
        villager = dim.spawnEntity(TUNNEL.VILLAGER_TYPE_ID, base);
        villager.addTag(COMBAT.FIGHTER_TAG);
        villager.nameTag = COMBAT.FIGHTER_NAME;
    } catch (e) {
        player.sendMessage(`§c[RVB 戦闘]§r 村人を出せませんでした: ${e}`);
        return;
    }
    const inv = inventoryOf(villager);
    try {
        inv?.addItem(new ItemStack(COMBAT.ARROW_ITEM, COMBAT.ARROWS));
        inv?.addItem(new ItemStack(COMBAT.AXE_ITEM, 1));
        inv?.addItem(new ItemStack(COMBAT.SHIELD_ITEM, 1));
        inv?.addItem(new ItemStack(COMBAT.CROSSBOW_ITEM, 1));
    } catch (e) {
        console.warn(`[RVB] give gear failed: ${e}`);
    }

    const type = opts.type ?? COMBAT.TARGET_TYPE;
    const count = Math.max(1, Math.min(4, opts.count ?? COMBAT.TARGET_COUNT));
    const targets = [];
    for (let i = 0; i < count; i++) {
        try {
            const e = dim.spawnEntity(type, { x: base.x + fwd.x * COMBAT.SPAWN_DIST - fwd.z * i * 2, y: p.y, z: base.z + fwd.z * COMBAT.SPAWN_DIST + fwd.x * i * 2 });
            e.addTag(COMBAT.TARGET_TAG);
            targets.push(e);
        } catch (e) {
            player.sendMessage(`§c[RVB 戦闘]§r 敵(${type})を出せませんでした: ${e}`);
        }
    }
    if (!targets.length) {
        try { villager.remove(); } catch {}
        return;
    }

    const f = {
        owner: player, dim, villager, targets,
        mover: createMover(dim, villager, COMBAT.WALK_SPEED),
        mode: null, shieldUp: true, cooldown: 0, attackTimer: 10, held: null, holdDir: null, holdTicks: 0, idle: 0, skipUntil: new Map(),
        tick: 0, endAt: null, spawned: false, noEnemy: 0, target: null,
        stats: { swings: 0, arrows: 0, arrowHits: 0, dealt: 0, taken: 0, blocked: 0, blocks: 0, noAmmo: 0, switches: 0, grabs: 0, refused: 0 }
    };
    fights.set(player.id, f);
    setupHurtHook();
    equip(villager, COMBAT.CROSSBOW_ITEM, COMBAT.SHIELD_ITEM);
    watch(villager, player, "戦闘", () => `${f.mode ?? "-"}${f.held ? " 捕獲中" : f.shieldUp ? " 盾↑" : " 盾↓"} 矢${countItem(villager, COMBAT.ARROW_ITEM)}${f.target && valid(f.target) ? ` 敵${(healthComp(f.target)?.currentValue ?? 0).toFixed(0)}HP/${dist3(villager.location, f.target.location).toFixed(1)}m` : ""}`);
    ensureLoop();
    player.sendMessage(`§e[RVB v${RVB_VERSION}]§r 戦闘テスト開始 / 敵 ${type}×${targets.length}(${COMBAT.SPAWN_DIST}マス先) / 遠いうちはクロスボウ、${COMBAT.MELEE_ENTER}マス以内で敵を捕まえて斧で倒す(捕まえている間だけ無敵)`);
}

export function stopCombatTest(player) {
    const f = fights.get(player.id);
    if (!f) {
        player.sendMessage("§e[RVB 戦闘]§r 走っている戦闘テストはありません");
        return;
    }
    fights.delete(player.id);
    cleanup(f);
    player.sendMessage("§e[RVB 戦闘]§r 止めて村人と敵を消しました");
}
