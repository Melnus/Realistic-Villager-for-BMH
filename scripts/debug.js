/**
 * RVB デバッグ表示(リソースパック不要)。
 *  - 一番近い RVB 村人の「HP・状態・座標」をアクションバー(画面下)に出す
 *  - 村人の HP が減ったら、その場でチャットに「いくつ減ったか・体がブロックに重なっていたか」を出す
 * 仕事は watch() で村人を登録するだけ。村人が消えれば自動で外れる。
 */

import { system } from "@minecraft/server";
import { valid } from "./util.js";
import { bodyOverlaps } from "./body.js";

/** @type {Map<any, {owner:any, label:string, status:()=>string, hp:number|null, since:number}>} */
const watched = new Map();
let loopId = null;
let tick = 0;

function healthOf(v) {
    try {
        const h = v.getComponent("minecraft:health");
        if (!h) return null;
        return { cur: h.currentValue, max: h.effectiveMax ?? h.defaultValue ?? 20 };
    } catch {
        return null;
    }
}

const fmt = (n) => (Number.isFinite(n) ? n.toFixed(1) : "?");

export function watch(villager, owner, label, status) {
    watched.set(villager, { owner, label, status, hp: healthOf(villager)?.cur ?? null, since: tick });
    ensureLoop();
}

export function unwatch(villager) {
    watched.delete(villager);
}

function ensureLoop() {
    if (loopId !== null) return;
    loopId = system.runInterval(() => {
        tick++;
        for (const [v, w] of watched) {
            if (!valid(v)) {
                watched.delete(v);
                continue;
            }
            // HP が減ったらすぐ知らせる(毎tick見る)
            const h = healthOf(v);
            if (h && w.hp !== null && h.cur < w.hp - 0.01) {
                let inBlock = "?";
                try {
                    inBlock = bodyOverlaps(v.dimension, v.location) ? "体がブロックに重なっている" : "体は重なっていない";
                } catch {}
                const l = v.location;
                try {
                    w.owner.sendMessage(`§c[RVB ダメージ]§r ${w.label} HP ${fmt(w.hp)}→${fmt(h.cur)} (-${fmt(w.hp - h.cur)}) / ${inBlock} / @${fmt(l.x)},${fmt(l.y)},${fmt(l.z)} / ${w.status()} / ${tick - w.since}tick目`);
                } catch {}
            }
            if (h) w.hp = h.cur;
        }
        if (tick % 5 === 0) showActionBar();
        if (watched.size === 0) {
            system.clearRun(loopId);
            loopId = null;
        }
    }, 1);
}

function showActionBar() {
    // 村人を登録した持ち主ごとに、その人に一番近い村人を表示する
    const byOwner = new Map();
    for (const [v, w] of watched) {
        if (!byOwner.has(w.owner)) byOwner.set(w.owner, []);
        byOwner.get(w.owner).push([v, w]);
    }
    for (const [owner, list] of byOwner) {
        if (!valid(owner)) continue;
        let best = null;
        let bestD = Infinity;
        for (const [v, w] of list) {
            const a = owner.location;
            const b = v.location;
            const d = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
            if (d < bestD) {
                bestD = d;
                best = [v, w];
            }
        }
        if (!best) continue;
        const [v, w] = best;
        const h = healthOf(v);
        const l = v.location;
        let st = "";
        try { st = w.status(); } catch {}
        let hit = "";
        try { hit = bodyOverlaps(v.dimension, l) ? " §c[重なり]§r" : ""; } catch {}
        const hp = h ? `§c♥§r ${fmt(h.cur)}/${fmt(h.max)}` : "HP?";
        try {
            owner.onScreenDisplay.setActionBar(`${w.label} ${hp}  ${st}  @${Math.floor(l.x)},${Math.floor(l.y)},${Math.floor(l.z)}${hit}`);
        } catch {}
    }
}
