// RVB 設定値。数値はここに集めて、コード側に直書きしない。

// 実機でどの版が動いているか見分けるための表示。manifestのバージョンと揃える。
export const RVB_VERSION = "0.0.17";

export const TUNNEL = {
    // 坑道の断面(横×高さ)。横は奇数
    WIDTH: 3,
    HEIGHT: 3,

    // 階段(下り)の断面(横×高さ)。横は奇数
    STAIR_WIDTH: 3,
    STAIR_HEIGHT: 5,

    // 坑道を掘る高さ(村人の足元のY)。仕様:Y=16
    TARGET_Y: 16,
    MIN_TARGET_Y: -60,

    // 階段の右壁に松明を置く間隔(階段のセル数)
    STAIR_TORCH_INTERVAL: 4,
    // 松明は、近くに松明が無い(升目上の距離がこの値以上)セルの右壁に置く
    TORCH_INTERVAL: 4,
    // 壁の松明の向きの初期値。true=「壁から通路側へ向く方角」を torch_facing_direction に入れる。
    // 実機で最初の松明が落ちたら自動で反転して判定し直す(以降はその向きを使う)。
    TORCH_FACING_FROM_WALL: false,
    // 置いてから、落ちていないか確認するまでのtick
    TORCH_CHECK_TICKS: 3,

    // 歩く速さ(ブロック/tick)。サンプルアドオンの0.22に合わせた
    WALK_SPEED: 0.22,
    // 1セルを掘るまでの待ち(tick)
    DIG_TICKS: 12,
    // 帰還の合格判定:出発点からこの距離以内
    RETURN_TOLERANCE: 1.5,
    // 暴走防止:基本tick + 階段1段あたり + 坑道1セルあたり を超えたら強制終了
    MAX_TICKS_BASE: 3000,
    MAX_TICKS_PER_STAIR: 40,
    MAX_TICKS_PER_CELL: 120,

    PICKAXE_ITEM_ID: "minecraft:iron_pickaxe",
    VILLAGER_TYPE_ID: "minecraft:villager_v2",
    VILLAGER_TAG: "rvb_miner",
    VILLAGER_NAME: "RVB Miner",

    // 掘ってはいけないブロック(村の建物・岩盤など)。typeId に含まれていたら、そのセルは掘らない。
    PROTECTED_KEYWORDS: [
        "bedrock", "obsidian", "spawner", "chest", "barrel", "bed", "door",
        "bell", "furnace", "smoker", "table", "grindstone", "loom", "lectern",
        "composter", "cauldron", "stonecutter", "barrier", "end_portal",
        "command_block", "sign", "banner"
    ]
};

// 升目(格子)状の坑道。入口を原点に、前方=u、右=v とする。
// u,v が PITCH の倍数の線が坑道になる(線の幅は TUNNEL.WIDTH)。
export const GRID = {
    PITCH: 7,
    // rvb:tunnel_test の既定。前方に何マス、左右に何マスまで広げるか
    DEFAULT_LENGTH: 14,
    MAX_LENGTH: 42,
    DEFAULT_SIDE: 14,
    MAX_SIDE: 28
};

// 鉄鉱石。掘るセルの中の鉄は必ず回収する。壁・天井に見えている鉄は、同じ鉱脈の続きまで少し掘る。
export const ORE = {
    IDS: ["minecraft:iron_ore", "minecraft:deepslate_iron_ore"],
    DROP_ITEM_ID: "minecraft:raw_iron",
    // 坑道の壁・天井に露出した鉄(と、つながった鉱脈)も掘るか
    MINE_EXPOSED: true,
    // 1セルを掘ったときに、露出した鉄の鉱脈で追加で掘る上限(ブロック数)
    VEIN_MAX_PER_CELL: 16,
    // 鉄以外のブロックのドロップ。false=掘ったら消える(丸石の山で床が埋まらない)。段2で建築材が要るときに true へ
    RUBBLE_DROPS: false
};

// 拠点(ベルとチェスト)
export const BASE = {
    BELL_ID: "minecraft:bell",
    // テスト開始時にプレイヤーの周りでベルを探す範囲
    BELL_SEARCH_RADIUS: 16,
    BELL_SEARCH_UP: 12,
    BELL_SEARCH_DOWN: 8,
    CHEST_ID: "minecraft:chest"
};

// 倉庫(段2)。屋根付きの小屋。長辺に沿って WIDTH、奥行き DEPTH(偶数。屋根の棟を階段2列で作るため)。
// 壁は下から COBBLE_LAYERS 層が丸石、残りが板材。屋根は階段ブロック。
export const WAREHOUSE = {
    WIDTH: 7,
    DEPTH: 6,
    WALL_LAYERS: 4,
    COBBLE_LAYERS: 1,
    // 板材・階段の木の種類(minecraft:<WOOD>_planks / minecraft:<WOOD>_stairs)
    WOOD: "oak",
    // 中に並べるチェストの数(奥の壁沿い、1マスおき)。チェスト1個=板材8枚を支給する
    // チェストは「ラージチェスト(チェスト2個を横に並べて同じ向きに置く)」を、縦に CHEST_STACK 段積んで列にする。
    // ラージチェストの長い辺は奥行き方向(壁に沿う向き)。正面は通路側(左右の壁は中央向き、奥の列は+x側向き)。
    // CHEST_SIDE_ZL:左右の壁沿いの各列の、奥行き位置の始まり(手前の壁を0とした番号。2マス使う。室内は 1〜DEPTH-2)。
    // CHEST_BACK:奥の壁の中央にも1列置くか(奥行き DEPTH-3〜DEPTH-2 を使う)
    // 例:左右2列ずつ+奥1列=5列×3段=ラージチェスト15個=チェスト30個
    CHEST_STACK: 3,
    CHEST_SIDE_ZL: [1, 3],
    CHEST_BACK: true,
    PLANKS_PER_CHEST: 8,

    // 適地探索:基準点(ベル)からこの範囲。基準点に近すぎる所(MIN_DIST)は除く
    SEARCH_RADIUS: 20,
    MIN_DIST: 5,
    SEARCH_STEP: 2,
    // 1tickに調べる候補の数(探索でゲームを止めないため)
    CANDIDATES_PER_TICK: 3,
    // 地面の高さの許容差(±)。低い所は埋め、高い所は削る
    FLAT_TOLERANCE: 1,
    // 小屋の上に空けておく高さ(屋根の最高点まで)
    CLEARANCE: 8,

    // 1ブロック置くごとの間(tick)と、歩く速さ
    BUILD_TICKS_PER_BLOCK: 5,
    WALK_SPEED: 0.3,
    MAX_TICKS: 20000,

    // 階段ブロックの向き。weirdo_direction は「登っていく方角」の番号と想定。
    // 屋根の傾きが逆(谷型)になったら ROOF_STAIR_FLIP を true にする。
    STAIR_ASCEND_STATE: { east: 0, west: 1, south: 2, north: 3 },
    ROOF_STAIR_FLIP: false,

    PREP_FILL_BLOCK: "minecraft:dirt"
};

// 伐採(倉庫を建てる前に、区画の木を取って空きを作る)
export const TREES = {
    // 倉庫づくりの前に伐採するか
    ENABLED: true,
    // 基準点(ベル)からこの範囲の木を取る
    RADIUS: 14,
    // 探索する高さ(基準点のYから)
    SCAN_UP: 26,
    SCAN_DOWN: 3,
    // 1tickに調べる柱の数(探索でゲームを止めないため)
    SCAN_COLUMNS_PER_TICK: 12,
    // 木とみなす葉の範囲(原木から葉をたどる距離。バニラの葉が残る距離と同じ6)
    LEAF_RANGE: 6,
    // これより大きい塊は木とみなさない(建物の可能性)
    MAX_LOGS: 400,
    MAX_BLOCKS: 2500,
    // 壊す速さ(1tickあたりのブロック数)
    BLOCKS_PER_TICK: 8,
    // 壊してから、ドロップを拾うまでの待ち(tick)
    PICKUP_WAIT: 15,
    PICKUP_RADIUS_MARGIN: 3,
    // 拾うアイテム(typeId に一致したもの)
    PICKUP_REGEX: "(_log$|_sapling$|^minecraft:stick$|^minecraft:apple$)",
    // 原木に隣接していたら「人が建てたもの」とみなすブロック(typeId に含まれていたら)
    FOREIGN_REGEX: "(planks|cobble|brick|glass|door|fence|stairs|slab|_wall$|torch|lantern|chest|barrel|crafting_table|furnace|smoker|bed$|sign|ladder|trapdoor|carpet|wool|concrete|terracotta|polished|smooth_|chiseled|cut_|stripped|_wood$|bookshelf|lectern|loom|composter|grindstone|cartography|fletching|smithing|stonecutter|anvil|bell|campfire|hay_block|scaffolding|iron_bars|button|pressure_plate|lever|item_frame|banner|rail|cauldron|brewing|flower_pot|jukebox|note_block|tnt|obsidian|quartz|prismarine)"
};

// 村人の体(すべての移動はこの体の大きさで当たり判定をしてから動く)
export const BODY = {
    // 当たり判定の箱(幅×高さ)。村人は 0.6 × 1.95
    WIDTH: 0.6,
    HEIGHT: 1.95,
    // 体力。ブロックの中に体が入ると窒息ダメージが入り続けて死ぬ(ダメージ量は未検証。だから「入れない」を原則にする)
    HP: 20,
    // 1歩で登れる段差と、降りられる段差
    MAX_STEP_UP: 1,
    MAX_DROP: 3,
    // 経路探索で調べる最大セル数と、探索の外枠(目的地までの距離+この余白)
    PATH_MAX_NODES: 3000,
    PATH_MARGIN: 8,
    // 経路が見つからない/進めないとき、探し直すまでの間隔(tick)
    REPATH_TICKS: 8,
    // 進めない状態がこの長さ続いたら「到達不能」と報告する(tick)
    STUCK_TICKS: 60,
    // 埋まったときに救出先を探す範囲
    RESCUE_RADIUS: 8
};

// 道:倉庫のドアの前の広場(平らに均す)と、ベルまでの道。
export const ROAD = {
    ENABLED: true,
    // 道のブロック。最初に置けたものを使う(版によって名前が違うため)
    BLOCKS: ["minecraft:dirt_path", "minecraft:grass_path"],
    // ドアの前の広場:横幅(奇数)と奥行き。ドアの床の高さに揃える
    APRON_WIDTH: 5,
    APRON_DEPTH: 3,
    // ベルまでの道の幅(奇数)
    WIDTH: 3,
    // 道がベルに近づいたら止める距離(ブロック)
    STOP_DIST: 2,
    // 道の高さは1マスごとに最大これだけ上下する(坂)
    MAX_SLOPE: 1,
    // 1列(道の1断面)を置くごとの間(tick)と、村人の届く距離
    TICKS_PER_ROW: 6,
    REACH: 4.5,
    // 道の上に空けておく高さ
    CLEAR_ABOVE: 3,
    // 掘れない/上書きしないブロック(ここを含むセルは飛ばす)
    SKIP_KEYWORDS: ["bedrock", "chest", "barrel", "door", "bell", "planks", "cobblestone", "furnace", "table", "bed", "stairs", "slab", "torch", "water", "lava"]
};

// 戦闘(マイルストーン3:1対1)。盾+斧で近接、離れたらクロスボウ。ダメージはバニラ準拠(ゲームの計算に任せる)。
export const COMBAT = {
    FIGHTER_TAG: "rvb_fighter",
    FIGHTER_NAME: "RVB Fighter",
    TARGET_TAG: "rvb_target",
    // 装備(replaceitem で持たせる。見た目用。実際の攻撃はスクリプトが行う)
    AXE_ITEM: "minecraft:iron_axe",
    SHIELD_ITEM: "minecraft:shield",
    CROSSBOW_ITEM: "minecraft:crossbow",
    ARROW_ITEM: "minecraft:arrow",
    ARROWS: 32,

    // テスト用の敵
    TARGET_TYPE: "minecraft:zombie",
    TARGET_COUNT: 1,
    SPAWN_DIST: 14,
    // 敵を探す範囲(モンスター族のうち近い順)
    DETECT_RANGE: 24,

    // 距離の切り替え(ヒステリシス):近づいたら近接、遠ざかったらクロスボウ
    MELEE_ENTER: 3.2,
    MELEE_EXIT: 5.5,
    // 近接は「捕まえて斧で倒す」:敵がこの距離(水平)まで近づいたら捕まえる。来なければ寄っていく
    GRAB_REACH: 1.7,
    // 捕まえている間、敵を村人の正面このマス先に固定する。村人は無敵(耐性エフェクト)+盾の防御は向き無視
    HOLD_DIST: 1.1,
    HOLD_MAX_TICKS: 400,
    // 斧の1撃のダメージ(applyDamage に渡す。防具などはゲーム側が計算)。鉄の斧=9
    AXE_DAMAGE: 9,
    ATTACK_INTERVAL: 22,
    // 最初の1撃までの間(捕まえた直後)
    FIRST_SWING_DELAY: 8,
    // 盾:捕まえていないとき、正面の半円(村人の向きと攻撃元の向きの内積がこれ以上)から来た攻撃を防ぐ
    SHIELD_DOT_MIN: 0.0,
    SHIELD_SOUND: "item.shield.block",

    // 狙う敵の条件:自分の足元よりこれ以上低い所の敵は狙わない(床を撃たない)
    MAX_BELOW: 1.5,
    // 撃つ距離の上限
    RANGE_MAX: 26,
    // 矢の軌道が地形に当たって届かない敵は、この間(tick)狙わず、また調べ直す
    UNREACHABLE_RETRY: 40,
    // 届かない敵しか残っていない状態がこの間続いたら、テストを終える(tick)
    NO_TARGET_END: 120,

    // クロスボウ
    CROSSBOW_RELOAD: 25,
    ARROW_SPEED: 3.15,
    ARROW_GRAVITY: 0.05,
    EYE_HEIGHT: 1.62,
    AIM_HEIGHT: 1.0,

    WALK_SPEED: 0.2,
    MAX_TICKS: 6000,
    // 決着後、村人と敵の後始末までの待ち(tick)
    CLEANUP_TICKS: 120
};
