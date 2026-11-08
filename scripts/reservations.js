/**
 * RVB 予約:村人の仕事が使う範囲(階段・坑道・建設地など)を先に押さえて、
 * ほかの職とぶつからないようにする。メモリ上のみ(スクリプトを読み直すと消える。
 * 仕事の状態も同じく消えるので整合する)。
 *
 * 使い方
 *   const conflict = findConflict(dimId, boxes, owner);   // 他人の予約と重なるか
 *   reserve(owner, "ラベル", dimId, boxes);               // 押さえる
 *   release(owner);                                        // 仕事が終わったら返す
 * boxes は {min:{x,y,z}, max:{x,y,z}}(両端を含むブロック座標)の配列。
 */

/** @type {Map<string, {label: string, dimId: string, boxes: Box[]}>} */
const claims = new Map();

/** @typedef {{min: {x:number,y:number,z:number}, max: {x:number,y:number,z:number}}} Box */

/** 2点から Box を作る */
export function boxFromPoints(a, b) {
    return {
        min: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), z: Math.min(a.z, b.z) },
        max: { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y), z: Math.max(a.z, b.z) }
    };
}

function overlap(a, b) {
    return a.min.x <= b.max.x && a.max.x >= b.min.x &&
        a.min.y <= b.max.y && a.max.y >= b.min.y &&
        a.min.z <= b.max.z && a.max.z >= b.min.z;
}

export function reserve(owner, label, dimId, boxes) {
    claims.set(owner, { label, dimId, boxes });
}

export function release(owner) {
    claims.delete(owner);
}

/** @returns {{owner: string, label: string}|null} 重なる他人の予約(最初の1つ) */
export function findConflict(dimId, boxes, exceptOwner) {
    for (const [owner, c] of claims) {
        if (owner === exceptOwner || c.dimId !== dimId) continue;
        for (const a of boxes) {
            for (const b of c.boxes) {
                if (overlap(a, b)) return { owner, label: c.label };
            }
        }
    }
    return null;
}

/** デバッグ用の一覧 */
export function describeAll() {
    return [...claims.entries()].map(([owner, c]) => `${c.label} (${c.dimId}, ${c.boxes.length}箱) [${owner}]`);
}
