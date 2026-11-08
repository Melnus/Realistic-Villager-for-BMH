import * as server from "@minecraft/server";
import * as ui from "@minecraft/server-ui";
import { startTunnelTest, stopTunnelTest } from "./tunnel.js";
import { RVB_VERSION } from "./config.js";
import { describeAll } from "./reservations.js";
import { startCombatTest, stopCombatTest } from "./combat.js";
import { startTreesTest, stopTreesTest } from "./trees.js";
import { startWarehouseTest, stopWarehouseTest, getWarehouse } from "./warehouse.js";

const HELP = [
    `§e[RVB v${RVB_VERSION}]§r デバッグコマンド(チャットで /scriptevent を使う)`,
    "  /scriptevent rvb:tunnel_test [前方の長さ] [目標Y] [左右の幅]",
    "      ベルのそばにチェストを置き、地表からY=16まで階段で下り、升目状に坑道を広げ、",
    "      鉄鉱石を持ち帰ってチェストに入れる。既定 14 / 16 / 14。ベルが近くに無ければ今の位置が基準。",
    "  /scriptevent rvb:tunnel_stop     止めて村人を消す",
    "  /scriptevent rvb:reservations    いま予約されている範囲の一覧",
    "  /scriptevent rvb:warehouse_test  ベルの近くで村人が平地を探し、道を作り、小屋(丸石+板材+階段屋根)を建ててラージチェスト15個(チェスト30個)を積む",
    "  /scriptevent rvb:warehouse_stop  倉庫づくりを止めて村人を消す",
    "  /scriptevent rvb:warehouse_info  登録済みの倉庫の場所を表示",
    "  /scriptevent rvb:trees_test [半径]  ベル(無ければ今の位置)の周りの木を、村人が原木と葉ごと壊して原木を拾う。建物の原木は残す",
    "  /scriptevent rvb:trees_stop      伐採を止めて村人を消す",
    "  (rvb:warehouse_test は最初に伐採を行ってから建てる)",
    "  /scriptevent rvb:combat_test [敵の種類] [数]  前方に村人(斧+盾+クロスボウ)と敵を出し、遠いうちは矢、近づいたら敵を捕まえて斧で倒す。例: rvb:combat_test zombie 2",
    "  /scriptevent rvb:combat_stop     止めて村人と敵を消す",
    "  浅く試すなら例: rvb:tunnel_test 7 55 7"
].join("\n");

server.system.afterEvents.scriptEventReceive.subscribe((ev) => {
    if (!ev.id.startsWith("rvb:")) return;
    const player = ev.sourceEntity;
    if (!player || player.typeId !== "minecraft:player") {
        console.warn(`[RVB] ${ev.id} はプレイヤーから実行してください`);
        return;
    }

    switch (ev.id) {
        case "rvb:help":
            player.sendMessage(HELP);
            break;
        case "rvb:tunnel_test": {
            const [len, ty, side] = ev.message.trim().split(/\s+/).map((s) => parseInt(s, 10));
            startTunnelTest(player, {
                length: Number.isFinite(len) ? len : undefined,
                targetY: Number.isFinite(ty) ? ty : undefined,
                side: Number.isFinite(side) ? side : undefined
            });
            break;
        }
        case "rvb:reservations": {
            const list = describeAll();
            player.sendMessage(list.length ? `§e[RVB]§r 予約中:\n  ${list.join("\n  ")}` : "§e[RVB]§r 予約はありません");
            break;
        }
        case "rvb:warehouse_test":
            startWarehouseTest(player);
            break;
        case "rvb:warehouse_stop":
            stopWarehouseTest(player);
            break;
        case "rvb:warehouse_info": {
            const w = getWarehouse();
            player.sendMessage(w
                ? `§e[RVB 倉庫]§r ドア @${w.door.x},${w.door.y},${w.door.z} (${w.facing}向き) / チェスト ${w.chests.map((c) => `${c.x},${c.y},${c.z}`).join(" | ")}`
                : "§e[RVB 倉庫]§r 登録された倉庫はありません");
            break;
        }
        case "rvb:trees_test": {
            const r = parseInt(ev.message.trim(), 10);
            startTreesTest(player, { radius: Number.isFinite(r) ? r : undefined });
            break;
        }
        case "rvb:combat_test": {
            const [type, n] = ev.message.trim().split(/\s+/);
            const cnt = parseInt(n, 10);
            startCombatTest(player, {
                type: type ? (type.includes(":") ? type : `minecraft:${type}`) : undefined,
                count: Number.isFinite(cnt) ? cnt : undefined
            });
            break;
        }
        case "rvb:combat_stop":
            stopCombatTest(player);
            break;
        case "rvb:trees_stop":
            stopTreesTest(player);
            break;
        case "rvb:tunnel_stop":
            stopTunnelTest(player);
            break;
        default:
            player.sendMessage(`§c[RVB]§r 不明なコマンド ${ev.id}\n${HELP}`);
    }
});
