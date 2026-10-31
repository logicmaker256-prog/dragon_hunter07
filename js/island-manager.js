/* =====================================================================
   js/island-manager.js  — 島管理モジュール(オープンワールド化 第1段階)

   役割(これだけ):
     1. 島ID(island-1〜island-5)と、島ごとの固定Seedを管理する
     2. 島ごとの状態データ(島データ)の初期化・取得・保存用の複製を安全に行う
     3. 旧セーブ(島情報なし)を、島データへ「読み取り専用」で変換する関数を提供する
     4. 再現性のある乱数(Seed付き)を、既存の乱数とは完全に分離して提供する

   やらないこと(今回の段階では意図的に未実装):
     ・地形生成 / 木・岩の配置 / 戦闘 / 農業 / 牧場 / メイド / 領民の処理の移植
     ・既存のグローバル変数(CONFIG / currentFloor / floorWorldStates など)の読み書き
     ・既存の mulberry32 / decorationRandom / Math.random の置き換え
     ・ゲームプレイ状態(柵・農地・牧場・ボス・領民など)を島単位へ移して保存すること
       (第2段階でも移していない。正の保存場所は従来のキーのまま。ISLAND_SAVE_DESIGN.md 参照)

   第2段階で追加したもの(セーブデータへ任意の「島メタデータ」1キーを足すための純粋関数):
     ・buildSaveMeta(opts) … 保存用の島メタデータ(islandMeta)を作る
     ・readSaveMeta(raw, ctx) … ロードしたセーブの islandMeta を検証して取り込む
       (どちらも入力を書き換えず、例外を投げない。呼び出し側は game.html の
        gatherIslandMetaSafe / restoreIslandMetaSafe)

   第3段階で追加したもの(島ごとの状態を分離して保存できる基盤。詳細は ISLAND_STATE_DESIGN.md):
     ・TreeId … 伐採済みの木を「生成順の番号」ではなく「島ID+位置」由来の安定IDで識別する関数群
     ・島データに world.choppedTreeIds / world.choppedTreeIdVersion を追加(旧 world.choppedTrees は
       「旧方式の番号」として互換のために残す)
     ・ストアに update / setCurrent / getCurrent / updateCurrent を追加(島IDの省略は常に失敗扱い)
     ・buildStatesSave / readStatesSave … 全島の状態をセーブ用に書き出す/検証して読み込む
       (セーブの任意キー islandStates。実ゲームで実際に接続しているのは「伐採済みの木」だけ)
     ・不正な島ID・型・巨大な配列に対する上限(LIMITS)

   安全方針:
     ・グローバルに追加する名前は IslandManager ただ1つ(IIFE内に閉じ込める)
     ・ブラウザ固有のAPI(DOM / THREE / window.*)に依存しない(Node.jsでもテスト可能)
     ・どの公開関数も例外を外へ投げない(不正入力は null / false / 既定値で返す)
     ・取得(get)・保存(set)は常に深い複製を介し、島どうしで参照を共有しない
   ===================================================================== */
(function (root) {
  'use strict';

  var SCHEMA_VERSION = 1;

  /* ---------------------------------------------------------------
     島の定義(固定値)。
     ・id: 内部ID。表示名(displayName)とは別。
     ・legacyFloor: 旧来のフロア番号との対応(初期段階の1対1対応。意味が同じとは限らない)。
     ・seed: 固定Seed。毎回変わってはいけない値なので、実行時に乱数から作らない。
       island-1 のSeedは、既存の木・岩の配置に使われている固定シード(20260101)と同じ値に
       してある。将来、配置処理を接続したとき island-1 が現行の配置を再現できる余地を残すため。
       他の島のSeedは任意の固定値。一度公開したら変更しないこと(変更すると島の形が変わる)。
     --------------------------------------------------------------- */
  var ISLAND_DEFS = Object.freeze([
    Object.freeze({ id: 'island-1', legacyFloor: 1, seed: 20260101, defaultName: '第1の島' }),
    Object.freeze({ id: 'island-2', legacyFloor: 2, seed: 20260202, defaultName: '第2の島' }),
    Object.freeze({ id: 'island-3', legacyFloor: 3, seed: 20260303, defaultName: '第3の島' }),
    Object.freeze({ id: 'island-4', legacyFloor: 4, seed: 20260404, defaultName: '第4の島' }),
    Object.freeze({ id: 'island-5', legacyFloor: 5, seed: 20260505, defaultName: '第5の島' })
  ]);

  var BOSS_STATES = ['unspawned', 'alive', 'waiting'];

  // 第3段階: 異常に大きいデータでロードが重くならない/壊れないための上限。
  // 実際のマップは1島あたり木が最大900本なので、十分な余裕を持たせた値にしてある。
  var LIMITS = Object.freeze({
    MAX_TREE_IDS: 20000,        // 1島の伐採済みの木ID(または旧番号)の最大件数
    MAX_RECORDS: 20000,         // 柵・農地などオブジェクト配列1本の最大件数
    MAX_STATES_CHARS: 4000000,  // islandStates 全体をJSON文字列にしたときの最大長
    MAX_ID_LENGTH: 64           // 木IDの最大文字数
  });

  /* ---------------------------------------------------------------
     小さなユーティリティ(すべて例外を投げない)
     --------------------------------------------------------------- */
  function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }
  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }
  function isFiniteNumber(v) {
    return typeof v === 'number' && isFinite(v);
  }
  // JSONで表せる値だけを深く複製する(参照共有を断つ)。失敗したら fallback を返す。
  function cloneJson(v, fallback) {
    try {
      if (v === undefined) return fallback;
      return JSON.parse(JSON.stringify(v));
    } catch (e) {
      return fallback;
    }
  }
  function cloneObjectArray(arr) {
    if (!Array.isArray(arr)) return [];
    var out = [];
    var n = Math.min(arr.length, LIMITS.MAX_RECORDS); // 第3段階: 異常に大きい配列は先頭から上限件数までだけ読む
    for (var i = 0; i < n; i++) {
      if (isPlainObject(arr[i])) {
        var c = cloneJson(arr[i], null);
        if (c !== null) out.push(c);
      }
    }
    return out;
  }
  function findDef(id) {
    if (typeof id !== 'string') return null;
    for (var i = 0; i < ISLAND_DEFS.length; i++) {
      if (ISLAND_DEFS[i].id === id) return ISLAND_DEFS[i];
    }
    return null;
  }

  /* ---------------------------------------------------------------
     島IDの検証・変換
     --------------------------------------------------------------- */
  function isValidIslandId(id) { return findDef(id) !== null; }
  function listIslandIds() { return ISLAND_DEFS.map(function (d) { return d.id; }); }
  function getSeed(id) { var d = findDef(id); return d ? d.seed : null; }
  function getDefaultName(id) { var d = findDef(id); return d ? d.defaultName : null; }
  function getDefinition(id) {
    var d = findDef(id);
    return d ? { id: d.id, legacyFloor: d.legacyFloor, seed: d.seed, defaultName: d.defaultName } : null;
  }
  // 旧フロア番号 → 島ID(初期段階の対応表。範囲外・不正値は null)
  function legacyFloorToIslandId(floor) {
    if (typeof floor !== 'number' || floor !== Math.floor(floor)) return null;
    for (var i = 0; i < ISLAND_DEFS.length; i++) {
      if (ISLAND_DEFS[i].legacyFloor === floor) return ISLAND_DEFS[i].id;
    }
    return null;
  }
  function islandIdToLegacyFloor(id) { var d = findDef(id); return d ? d.legacyFloor : null; }

  /* ---------------------------------------------------------------
     Seed付き乱数(既存の乱数とは別。Math.random / mulberry32 / decorationRandom には触らない)
     ・mulberry32 と同じ算法を、この名前空間の中に独立して持つ。
     ・同じSeedなら必ず同じ数列、異なるSeedなら異なる数列になる。
     --------------------------------------------------------------- */
  function createRng(seed) {
    var s = (typeof seed === 'number' && isFinite(seed)) ? (seed | 0) : 0;
    return function () {
      s = (s + 0x6D2B79F5) | 0;
      var t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  // 文字列 → 32bit符号なし整数(FNV-1a)。島Seedから用途別の子Seedを作るときに使う。
  function hashString(str) {
    var h = 0x811C9DC5;
    var s = String(str);
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }
  // 島Seed + 用途名("terrain" / "trees" など)から、固定の子Seedを得る。不正な島IDは null。
  function deriveSeed(id, label) {
    var seed = getSeed(id);
    if (seed === null) return null;
    return hashString(seed + ':' + String(label));
  }
  // 試験用: Seedから先頭n個の値を取り出す
  function sampleSequence(seed, n) {
    var rng = createRng(seed);
    var count = (typeof n === 'number' && n > 0 && n <= 100000) ? Math.floor(n) : 0;
    var out = [];
    for (var i = 0; i < count; i++) out.push(rng());
    return out;
  }


  /* ---------------------------------------------------------------
     伐採済みの木の「安定ID」(第3段階)
     ・旧方式: 木を「何番目に生成されたか(treeData の添字)」だけで識別していた。
       Seed・建物の除外エリア・乱数の使い方が少し変わると番号がずれ、別の木が切られた扱いになる。
     ・新方式: ID = 島ID + 木の位置(1cm単位に丸めた x,z)。
         例) island-1:tree:-1234_5678      (x=-12.34, z=56.78 付近の木)
       - 同じ島・同じSeed・同じ木なら、読み込み直しても必ず同じID(位置は固定Seedの乱数から決まる)。
       - 生成順・配列の並び替え・他の木が増減しても、その木のIDは変わらない(順番を使わない)。
       - 島IDを含むので、別の島の同じ位置の木とは別のIDになる。
       - 丸めは Math.round(値*100)。座標は固定Seedから決まる値で、加減乗算だけで作られるため
         環境が変わっても同じ値になる。1cm未満のずれ(浮動小数点の誤差)は同じIDに丸められる。
       - 同じ1cmマスに2本以上の木が重なる極めてまれな場合だけ、木自身の値(scale→rotY→入力順)で
         決まる順に「~2」「~3」を付ける。通常のIDは入力順に依存しない。
     ・どの関数も例外を投げない。不正な入力は null / false を返す。
     --------------------------------------------------------------- */
  var TREE_ID_GRID = 100; // 1cm
  var TREE_ID_PATTERN = /^(island-\d{1,3}):tree:(-?\d{1,9})_(-?\d{1,9})(?:~(\d{1,3}))?$/;

  function quantizeCoord(v) {
    if (typeof v !== 'number' || !isFinite(v)) return null;
    var q = Math.round(v * TREE_ID_GRID);
    if (Math.abs(q) > 999999999) return null;
    return q === 0 ? 0 : q; // -0 を 0 にそろえる
  }
  function formatTreeId(islandId, qx, qz, dup) {
    return islandId + ':tree:' + qx + '_' + qz + (dup >= 2 ? '~' + dup : '');
  }
  // 島IDと位置から木のIDを作る。島IDが不正・座標が数値でないときは null。
  function makeTreeId(islandId, x, z, dup) {
    if (!isValidIslandId(islandId)) return null;
    var qx = quantizeCoord(x), qz = quantizeCoord(z);
    if (qx === null || qz === null) return null;
    var d = (typeof dup === 'number' && dup >= 2 && dup === Math.floor(dup) && dup <= 999) ? dup : 0;
    return formatTreeId(islandId, qx, qz, d);
  }
  // IDを分解する。形式が正しくない・島IDが存在しない・正規の書き方でない(例: 先頭の0や -0)ときは null。
  function parseTreeId(id) {
    if (typeof id !== 'string' || id.length > LIMITS.MAX_ID_LENGTH) return null;
    var m = TREE_ID_PATTERN.exec(id);
    if (!m || !isValidIslandId(m[1])) return null;
    var qx = Number(m[2]), qz = Number(m[3]), dup = m[4] === undefined ? 0 : Number(m[4]);
    if (m[4] !== undefined && dup < 2) return null;
    if (formatTreeId(m[1], qx, qz, dup) !== id) return null; // 正規形だけを認める
    return { islandId: m[1], qx: qx, qz: qz, dup: dup };
  }
  function isTreeId(id, islandId) {
    var p = parseTreeId(id);
    return p !== null && (islandId === undefined || p.islandId === islandId);
  }
  // 木の配列(各要素に x, z があり、あれば scale, rotY も使う)から、同じ長さのID配列を作る。
  // 戻り値: { ids: [...](作れない要素は null), collisions: 重なった木の本数, invalid: IDを作れなかった本数 }
  // trees の中身は書き換えない。出力は入力の並び順に依存しない(重なりの順位づけも木自身の値で決める)。
  function assignTreeIds(islandId, trees) {
    var out = { ids: [], collisions: 0, invalid: 0 };
    if (!isValidIslandId(islandId) || !Array.isArray(trees)) return out;
    var groups = Object.create(null);
    var base = [];
    for (var i = 0; i < trees.length; i++) {
      var t = trees[i];
      var b = (t && typeof t === 'object') ? makeTreeId(islandId, t.x, t.z, 0) : null;
      base.push(b);
      if (b === null) { out.invalid++; continue; }
      (groups[b] || (groups[b] = [])).push(i);
    }
    out.ids = base.slice();
    var keys = Object.keys(groups);
    for (var k = 0; k < keys.length; k++) {
      var g = groups[keys[k]];
      if (g.length < 2) continue;
      out.collisions += g.length - 1;
      var rank = function (idx) {
        var tr = trees[idx];
        var sc = isFiniteNumber(tr.scale) ? Math.round(tr.scale * 1e6) : 0;
        var ro = isFiniteNumber(tr.rotY) ? Math.round(tr.rotY * 1e6) : 0;
        return [sc, ro, idx];
      };
      g.sort(function (a, b2) {
        var ra = rank(a), rb = rank(b2);
        for (var q = 0; q < 3; q++) if (ra[q] !== rb[q]) return ra[q] - rb[q];
        return 0;
      });
      for (var j = 1; j < g.length; j++) {
        var parsed = parseTreeId(keys[k]);
        out.ids[g[j]] = parsed ? formatTreeId(parsed.islandId, parsed.qx, parsed.qz, j + 1) : null;
      }
    }
    return out;
  }
  // 伐採済みの木IDの一覧を整える: 文字列・正規形・指定した島のID・重複なし・上限件数。並びは辞書順にそろえる。
  // 別の島のIDが混ざっていても、その島のものとしては採用しない(別の島の木へ当てはめない)。
  function sanitizeTreeIdList(islandId, arr) {
    var res = { ids: [], dropped: 0, truncated: false, notArray: false };
    if (!Array.isArray(arr)) { res.notArray = (arr !== undefined && arr !== null); return res; }
    var n = Math.min(arr.length, LIMITS.MAX_TREE_IDS);
    res.truncated = arr.length > LIMITS.MAX_TREE_IDS;
    var seen = Object.create(null);
    for (var i = 0; i < n; i++) {
      var v = arr[i];
      var p = parseTreeId(v);
      if (p === null || p.islandId !== islandId || seen[v]) { res.dropped++; continue; }
      seen[v] = true;
      res.ids.push(v);
    }
    res.ids.sort();
    return res;
  }
  // 旧セーブの伐採情報(treeData の添字の配列)を、いまの木の配置(idsByIndex: 添字→ID)で安定IDへ変換する。
  // ・変換できた分は ids、変換できなかった旧番号は unresolved に残す(捨てない)。
  // ・番号が木の本数を超えているものが1つでもあれば、「保存時と配置が違う」と見なして
  //   全件を変換しない(別の木へ当てはめない)。reason に理由を入れる。
  // reason: 'ok' | 'partial' | 'empty' | 'nothing-valid' | 'not-array' | 'no-layout' | 'out-of-range'
  function fromLegacyIndices(indices, idsByIndex) {
    var res = { ids: [], unresolved: [], reason: 'ok' };
    if (!Array.isArray(indices)) { res.reason = 'not-array'; return res; }
    var clean = [], seen = Object.create(null);
    var n = Math.min(indices.length, LIMITS.MAX_TREE_IDS);
    for (var i = 0; i < n; i++) {
      var v = indices[i];
      if (typeof v === 'number' && isFinite(v) && v >= 0 && v === Math.floor(v) && !seen[v]) { seen[v] = true; clean.push(v); }
    }
    clean.sort(function (a, b) { return a - b; });
    if (clean.length === 0) { res.reason = indices.length === 0 ? 'empty' : 'nothing-valid'; return res; }
    if (!Array.isArray(idsByIndex) || idsByIndex.length === 0) { res.unresolved = clean; res.reason = 'no-layout'; return res; }
    if (clean[clean.length - 1] >= idsByIndex.length) { res.unresolved = clean; res.reason = 'out-of-range'; return res; }
    var dup = Object.create(null);
    for (var j = 0; j < clean.length; j++) {
      var id = idsByIndex[clean[j]];
      if (typeof id === 'string' && !dup[id]) { dup[id] = true; res.ids.push(id); }
      else if (typeof id !== 'string') res.unresolved.push(clean[j]);
    }
    res.ids.sort();
    if (res.unresolved.length > 0) res.reason = 'partial';
    return res;
  }
  var TreeId = {
    GRID: TREE_ID_GRID,
    quantize: quantizeCoord,
    make: makeTreeId,
    parse: parseTreeId,
    isValid: isTreeId,
    assign: assignTreeIds,
    sanitizeList: sanitizeTreeIdList,
    fromLegacyIndices: fromLegacyIndices
  };

  /* ---------------------------------------------------------------
     島データ(1島分)の形
     ・どのセクションも「その島だけの状態」。全島共通のデータ(所持金・レベル・装備・
       インベントリ・空腹度・ゲーム内時間・王家仕送り等)はここに入れない(設計書参照)。
     ・terrain は将来の地形生成用の予約枠。今回は中身を使わない。
     --------------------------------------------------------------- */
  function createEmptyIslandData(id) {
    var d = findDef(id);
    if (!d) return null;
    return {
      schemaVersion: SCHEMA_VERSION,
      id: d.id,
      seed: d.seed,
      legacyFloor: d.legacyFloor,
      displayName: d.defaultName,
      player: null, // { x, z, rotY } 島を離れた時の位置。null = 既定の出現位置を使う
      terrain: { generatorVersion: null, params: null }, // 予約枠(今回は未使用)
      world: {
        // choppedTrees は「旧方式の番号(生成順の添字)」。第3段階以降は、旧セーブから変換できなかった番号の
        // 持ち越し用(捨てないための置き場)としてだけ使う。新しい伐採情報は choppedTreeIds に持つ。
        choppedTrees: [],
        // 第3段階: 伐採済みの木の安定ID(島ID+位置)。choppedTreeIdVersion が 1 のときだけ「この一覧が正」
        // (null = まだ記録していない。空の一覧と「未記録」を区別するため)。
        choppedTreeIds: [], choppedTreeIdVersion: null,
        saplings: [], fences: [], farmlands: [],
        ranches: [], buildings: [], guestHouses: []
      },
      monsters: {
        boss: { state: 'unspawned', zakoKillCount: 0, respawnAt: null },
        bossDefeatCount: 0,
        cleared: false
      },
      npcs: { maids: [], villagers: [] },
      time: { lastVisitedAt: null }
    };
  }

  // 任意の入力(壊れている/欠けている可能性あり)を、正しい形の島データへ整える。
  // id / seed / legacyFloor は常に定義表の値で上書きする(入力側の値は信用しない)。
  // 不正な島IDなら null。例外は投げない。
  function sanitizeIslandData(id, raw) {
    var base = createEmptyIslandData(id);
    if (!base) return null;
    if (!isPlainObject(raw)) return base;

    if (typeof raw.displayName === 'string' && raw.displayName.length > 0 && raw.displayName.length <= 40) {
      base.displayName = raw.displayName;
    }

    var p = raw.player;
    if (isPlainObject(p) && isFiniteNumber(p.x) && isFiniteNumber(p.z)) {
      base.player = { x: p.x, z: p.z, rotY: isFiniteNumber(p.rotY) ? p.rotY : 0 };
    }

    var t = raw.terrain;
    if (isPlainObject(t)) {
      base.terrain.generatorVersion = isFiniteNumber(t.generatorVersion) ? t.generatorVersion : null;
      base.terrain.params = isPlainObject(t.params) ? cloneJson(t.params, null) : null;
    }

    var w = raw.world;
    if (isPlainObject(w)) {
      if (Array.isArray(w.choppedTrees)) {
        var seen = {};
        var lim = Math.min(w.choppedTrees.length, LIMITS.MAX_TREE_IDS);
        for (var i = 0; i < lim; i++) {
          var n = w.choppedTrees[i];
          if (typeof n === 'number' && isFinite(n) && n >= 0 && n === Math.floor(n) && !hasOwn(seen, n)) {
            seen[n] = true;
            base.world.choppedTrees.push(n);
          }
        }
      }
      base.world.choppedTreeIds = sanitizeTreeIdList(id, w.choppedTreeIds).ids;
      base.world.choppedTreeIdVersion = (w.choppedTreeIdVersion === 1) ? 1 : null;
      base.world.saplings = cloneObjectArray(w.saplings);
      base.world.fences = cloneObjectArray(w.fences);
      base.world.farmlands = cloneObjectArray(w.farmlands);
      base.world.ranches = cloneObjectArray(w.ranches);
      base.world.buildings = cloneObjectArray(w.buildings);
      base.world.guestHouses = cloneObjectArray(w.guestHouses);
    }

    var m = raw.monsters;
    if (isPlainObject(m)) {
      var b = m.boss;
      if (isPlainObject(b)) {
        base.monsters.boss.state = BOSS_STATES.indexOf(b.state) >= 0 ? b.state : 'unspawned';
        base.monsters.boss.zakoKillCount = (isFiniteNumber(b.zakoKillCount) && b.zakoKillCount >= 0) ? b.zakoKillCount : 0;
        base.monsters.boss.respawnAt = isFiniteNumber(b.respawnAt) ? b.respawnAt : null;
        // 「リポップ待ち」なのに予定時刻が無い場合は、既存ロード処理(applySaveData)と同じく
        // 「予定時刻不明 = 即リポップ扱い」に倒すため、ここでは値を捏造せず状態を安全側に戻す。
        if (base.monsters.boss.state === 'waiting' && base.monsters.boss.respawnAt === null) {
          base.monsters.boss.state = 'unspawned';
        }
      }
      base.monsters.bossDefeatCount = (isFiniteNumber(m.bossDefeatCount) && m.bossDefeatCount >= 0)
        ? Math.floor(m.bossDefeatCount) : 0;
      base.monsters.cleared = m.cleared === true;
    }

    var np = raw.npcs;
    if (isPlainObject(np)) {
      base.npcs.maids = cloneObjectArray(np.maids);
      base.npcs.villagers = cloneObjectArray(np.villagers);
    }

    var tm = raw.time;
    if (isPlainObject(tm) && isFiniteNumber(tm.lastVisitedAt)) base.time.lastVisitedAt = tm.lastVisitedAt;

    return base;
  }

  /* ---------------------------------------------------------------
     島データの保管庫(ストア)
     ・get は「複製」を返し、set は「整えた複製」を保存する。呼び出し側が受け取った
       オブジェクトを書き換えても、保管庫の中身や他の島には影響しない。
     ・未知の島ID / 不正データでも例外を投げない。
     ・ストアはインスタンスごとに独立(グローバルな共有状態を持たない)。
     --------------------------------------------------------------- */
  function createStore() {
    var data = {}; // { [島ID]: 島データ }
    var ids = listIslandIds();
    for (var i = 0; i < ids.length; i++) data[ids[i]] = createEmptyIslandData(ids[i]);
    // 第3段階: 「現在の島」は、明示的に setCurrent したときだけ存在する(初期値は null)。
    // get / set / update / reset は島IDを省略すると必ず失敗(null / false)する。
    // 現在の島を使いたいときは getCurrent / updateCurrent を使う(別の名前の別の関数にして、取り違えを防ぐ)。
    var currentId = null;

    // 1つの島の状態を mutator で書き換える(下の update / updateCurrent の共通処理)
    function doUpdate(id, mutator) {
      if (!isValidIslandId(id) || typeof mutator !== 'function') return false;
      var draft = cloneJson(data[id], null);
      if (draft === null) return false;
      try {
        var ret = mutator(draft);
        if (ret !== undefined) {
          if (!isPlainObject(ret)) return false;
          draft = ret;
        }
      } catch (e) {
        return false;
      }
      var clean = sanitizeIslandData(id, draft);
      if (!clean) return false;
      data[id] = clean;
      return true;
    }

    return {
      has: function (id) { return isValidIslandId(id); },
      ids: function () { return listIslandIds(); },
      // 島データの複製を返す。未知の島IDは null。
      get: function (id) {
        if (!isValidIslandId(id)) return null;
        return cloneJson(data[id], createEmptyIslandData(id));
      },
      // 島データを保存する(整えてから複製を保管)。成功したら true。
      set: function (id, island) {
        if (!isValidIslandId(id)) return false;
        var clean = sanitizeIslandData(id, island);
        if (!clean) return false;
        data[id] = clean;
        return true;
      },
      // 第3段階: 1つの島の状態を、関数 mutator で書き換える。
      //   ・mutator には島データの「複製」が渡される。書き換えた後に整形(sanitize)してから保存する。
      //   ・mutator が例外を投げた/不正な値を返した/島IDが不正なら、何も変えずに false。
      //   ・id・seed・legacyFloor は常に定義表の値に戻る(mutator で変えられない)。
      //   ・他の島のデータには一切触れない。
      update: doUpdate,
      // 第3段階: 現在の島の指定・取得・更新(明示的に指定されたときだけ使える)
      setCurrent: function (id) {
        if (!isValidIslandId(id)) return false;
        currentId = id;
        return true;
      },
      clearCurrent: function () { currentId = null; },
      getCurrentId: function () { return currentId; },
      getCurrent: function () {
        if (currentId === null) return null;
        return cloneJson(data[currentId], createEmptyIslandData(currentId));
      },
      updateCurrent: function (mutator) {
        if (currentId === null || typeof mutator !== 'function') return false;
        var target = currentId; // 呼び出し時点の島を固定して使う(途中で変わっても別の島へ書かない)
        return doUpdate(target, mutator);
      },
      // 1つの島を初期状態へ戻す。他の島には触れない。
      reset: function (id) {
        if (!isValidIslandId(id)) return false;
        data[id] = createEmptyIslandData(id);
        return true;
      },
      // 保存用の全島スナップショット(複製)。
      snapshot: function () {
        var out = { schemaVersion: SCHEMA_VERSION, islands: {} };
        for (var j = 0; j < ids.length; j++) out.islands[ids[j]] = cloneJson(data[ids[j]], createEmptyIslandData(ids[j]));
        return out;
      },
      // スナップショットから復元する。欠けた島・壊れた島は既定値のまま(クラッシュしない)。
      // 戻り値: 復元に使えた島の数。
      restore: function (snap) {
        for (var k = 0; k < ids.length; k++) data[ids[k]] = createEmptyIslandData(ids[k]);
        if (!isPlainObject(snap) || !isPlainObject(snap.islands)) return 0;
        var used = 0;
        for (var m = 0; m < ids.length; m++) {
          var rec = hasOwn(snap.islands, ids[m]) ? snap.islands[ids[m]] : undefined;
          if (isPlainObject(rec)) { data[ids[m]] = sanitizeIslandData(ids[m], rec); used++; }
        }
        return used;
      }
    };
  }

  /* ---------------------------------------------------------------
     旧セーブ(島情報なし)→ 島データへの変換(読み取り専用・純粋関数)
     ・入力のセーブデータは一切書き換えない(複製してから使う)。
     ・旧セーブの仕様(SAVE_VERSION=1)に基づく:
         worldState.floorWorldStates[階] … 柵・農地・牧場(階別)
         worldState.fences/farmlands/ranches … 階別化以前の形式。セーブ時にいた階のデータ
         floorBossState[階] / floorCleared[階] / bossDefeatCount[階]
         worldState.guestHouses[] / villagers[] … それぞれ floor を持つ
         worldState.choppedTrees / saplings … 階に属さない「全階共通」のデータ
     ・全階共通の木データは island-1 にだけ入れる(理由は OPEN_WORLD_DESIGN.md)。
     ・戻り値 report に、判断した内容と捨てたデータを文字列で残す(黙って捨てない)。
     --------------------------------------------------------------- */
  function migrateFromLegacySave(save) {
    var report = [];
    var result = { islands: {}, currentIslandId: null, report: report };
    var ids = listIslandIds();
    for (var i = 0; i < ids.length; i++) result.islands[ids[i]] = createEmptyIslandData(ids[i]);

    if (!isPlainObject(save)) {
      report.push('入力がセーブデータとして扱えないため、全島を初期状態にした');
      return result;
    }
    if (isPlainObject(save.islands)) {
      report.push('既に島情報(islands)を持つセーブなので、旧形式の変換は行わない');
      return result;
    }

    var ws = isPlainObject(save.worldState) ? save.worldState : {};
    var curFloor = (typeof save.currentFloor === 'number') ? save.currentFloor : 1;
    var curId = legacyFloorToIslandId(curFloor);
    if (curId === null) {
      report.push('currentFloor=' + String(curFloor) + ' は島に対応しないため island-1 として扱う');
      curId = 'island-1';
    }
    result.currentIslandId = curId;

    // 柵・農地・牧場(階別)
    var perFloor = isPlainObject(ws.floorWorldStates) ? ws.floorWorldStates : null;
    for (var a = 0; a < ids.length; a++) {
      var id = ids[a];
      var fl = islandIdToLegacyFloor(id);
      var isl = result.islands[id];
      var st = null;
      if (perFloor && isPlainObject(perFloor[fl])) {
        st = perFloor[fl];
      } else if (!perFloor && id === curId &&
                 (Array.isArray(ws.fences) || Array.isArray(ws.farmlands) || Array.isArray(ws.ranches))) {
        st = ws; // 階別化以前の形式 = セーブ時にいた階のデータ
        report.push(id + ': 階別化以前の形式の柵・農地・牧場を、セーブ時にいた島のデータとして読み込んだ');
      }
      if (st) {
        isl.world.fences = cloneObjectArray(st.fences);
        isl.world.farmlands = cloneObjectArray(st.farmlands);
        isl.world.ranches = cloneObjectArray(st.ranches);
      }
    }
    if (perFloor) {
      var keys = Object.keys(perFloor);
      for (var q = 0; q < keys.length; q++) {
        var kf = Number(keys[q]);
        if (legacyFloorToIslandId(kf) === null) report.push('floorWorldStates[' + keys[q] + '] は対応する島が無いため取り込まなかった');
      }
    }

    // ボス状態・クリア記録・撃破回数(階別)
    var fbs = isPlainObject(save.floorBossState) ? save.floorBossState : {};
    var fcl = isPlainObject(save.floorCleared) ? save.floorCleared : {};
    var bdc = isPlainObject(save.bossDefeatCount) ? save.bossDefeatCount : {};
    for (var b = 0; b < ids.length; b++) {
      var iid = ids[b], f2 = islandIdToLegacyFloor(iid);
      var target = result.islands[iid];
      var tmp = sanitizeIslandData(iid, {
        monsters: {
          boss: isPlainObject(fbs[f2]) ? fbs[f2] : undefined,
          bossDefeatCount: bdc[f2],
          cleared: fcl[f2] === true
        }
      });
      target.monsters = tmp.monsters;
    }

    // ゲストハウス・領民(それぞれfloorを持つ)
    var ghs = Array.isArray(ws.guestHouses) ? ws.guestHouses : [];
    var vls = Array.isArray(ws.villagers) ? ws.villagers : [];
    var lostGh = 0, lostVl = 0;
    ghs.forEach(function (g) {
      var tid = isPlainObject(g) ? legacyFloorToIslandId(g.floor) : null;
      if (tid) result.islands[tid].world.guestHouses.push(cloneJson(g, {})); else lostGh++;
    });
    vls.forEach(function (v) {
      var tid = isPlainObject(v) ? legacyFloorToIslandId(v.floor) : null;
      if (tid) result.islands[tid].npcs.villagers.push(cloneJson(v, {})); else lostVl++;
    });
    if (lostGh) report.push('島に対応しないゲストハウス ' + lostGh + ' 件は取り込まなかった');
    if (lostVl) report.push('島に対応しない領民 ' + lostVl + ' 人は取り込まなかった');

    // 木(全階共通)→ island-1 のみ
    var chopped = Array.isArray(ws.choppedTrees) ? ws.choppedTrees : [];
    var sap = Array.isArray(ws.saplings) ? ws.saplings : [];
    var first = sanitizeIslandData('island-1', { world: { choppedTrees: chopped, saplings: sap } });
    result.islands['island-1'].world.choppedTrees = first.world.choppedTrees;
    result.islands['island-1'].world.saplings = first.world.saplings;
    if (chopped.length || sap.length) {
      report.push('伐採済みの木 ' + first.world.choppedTrees.length + ' 本・苗木 ' + first.world.saplings.length +
        ' 本は旧仕様で全階共通だったため island-1 に割り当てた');
    }

    // 最終訪問時刻(分かるのはセーブ時にいた島だけ)
    if (isFiniteNumber(save.savedAt)) result.islands[curId].time.lastVisitedAt = save.savedAt;

    // 念のため全島を整形し直す(不正値の混入防止)
    for (var z = 0; z < ids.length; z++) result.islands[ids[z]] = sanitizeIslandData(ids[z], result.islands[ids[z]]);
    return result;
  }

  /* ---------------------------------------------------------------
     島メタデータ(セーブデータの任意キー islandMeta)  — 第2段階
     ・目的: 将来「島」が保存の単位になったとき、旧セーブも新セーブも安全に読めるように、
       セーブに「島の版・島ID・固定Seed」を先に記録しておく。ゲームプレイ状態は含めない。
       (柵・農地・牧場・ボス・領民などの正の保存場所は、従来のキーのまま変えていない)
     ・キー名を islands にしなかった理由: migrateFromLegacySave は「islands を持つセーブ =
       変換済み」と見なして変換をスキップする。メタデータだけの islands を作ると、将来
       旧データの変換が黙って省かれる危険があるため、別名 islandMeta にした。
     ・形(metaVersion: 1):
         { metaVersion: 1,
           currentIslandId: 'island-N',     // 保存時の currentFloor から導いた参考値(正は currentFloor)
           islands: { 'island-N': { seed, generatorVersion, displayName } ... 5島分 },
           rejectedRaw?: <読み込めなかった旧 islandMeta の原文(最初の1件だけ・64KBまで)> }
     ・Seed は常に定義表の値を書く。読み込んだ値が定義表と違えば notes に残す(黙って直さない)。
     ・読めない islandMeta は捨てずに rejectedRaw として保持し、再保存しても失われない。
     --------------------------------------------------------------- */
  var META_VERSION = 1;
  var META_MAX_PRESERVE_CHARS = 65536;

  function defaultIslandIdFor(floor) {
    var id = legacyFloorToIslandId(floor);
    return id === null ? 'island-1' : id;
  }
  function createDefaultMeta(floor) {
    var meta = { metaVersion: META_VERSION, currentIslandId: defaultIslandIdFor(floor), islands: {} };
    var ids = listIslandIds();
    for (var i = 0; i < ids.length; i++) {
      var d = findDef(ids[i]);
      meta.islands[ids[i]] = { seed: d.seed, generatorVersion: null, displayName: d.defaultName };
    }
    return meta;
  }
  // 原文を保持用に複製する。JSONにできない/大きすぎる場合は null(理由は呼び出し側が notes に残す)。
  function clonePreserved(raw) {
    try {
      var text = JSON.stringify(raw);
      if (typeof text !== 'string' || text.length > META_MAX_PRESERVE_CHARS) return null;
      return JSON.parse(text);
    } catch (e) {
      return null;
    }
  }

  // ロードしたセーブの islandMeta(raw: 無い/壊れている可能性あり)を取り込む。
  // ctx.floor: セーブ時にいた階(ゲーム側の currentFloor。こちらを正とする)。
  // 戻り値: { meta, status, notes, seedMismatch }
  //   status: 'absent'(旧セーブ・キー無し) | 'ok' | 'invalid'(使えない形) | 'future'(未知の新しい版) | 'error'
  //   meta は常に正しい形。rawは書き換えない。例外は投げない。
  function readSaveMeta(raw, ctx) {
    var cf = (ctx && typeof ctx === 'object') ? ctx.floor : undefined;
    var out = { meta: createDefaultMeta(cf), status: 'error', notes: [], seedMismatch: [] };
    try {
      if (raw === undefined || raw === null) {
        out.status = 'absent';
        out.notes.push('islandMeta が無い(旧セーブ)。既存のゲーム状態は変えず、初期メタデータを用意した');
        return out;
      }
      var reject = function (status, why) {
        out.status = status;
        out.notes.push(why);
        var kept = clonePreserved(raw);
        if (kept !== null) out.meta.rejectedRaw = kept;
        else out.notes.push('原文を保持できなかった(JSONにできない、または' + META_MAX_PRESERVE_CHARS + '文字超)');
        return out;
      };
      if (!isPlainObject(raw)) return reject('invalid', 'islandMeta がオブジェクトではないため使わない(原文は保持)');
      if (typeof raw.metaVersion !== 'number' || raw.metaVersion !== Math.floor(raw.metaVersion) || raw.metaVersion < 1) {
        return reject('invalid', 'islandMeta.metaVersion が不正なため使わない(原文は保持)');
      }
      if (raw.metaVersion > META_VERSION) {
        return reject('future', 'islandMeta.metaVersion=' + raw.metaVersion + ' は未対応の新しい版のため解釈しない(原文は保持)');
      }
      if (!isPlainObject(raw.islands)) return reject('invalid', 'islandMeta.islands が不正なため使わない(原文は保持)');

      var ids = listIslandIds();
      for (var i = 0; i < ids.length; i++) {
        var id = ids[i];
        var rec = hasOwn(raw.islands, id) ? raw.islands[id] : undefined;
        var dst = out.meta.islands[id];
        if (rec === undefined) { out.notes.push(id + ': 記録なし(既定値を使用)'); continue; }
        if (!isPlainObject(rec)) { out.notes.push(id + ': 記録が不正な型のため既定値を使用'); continue; }
        if (!isFiniteNumber(rec.seed)) {
          out.notes.push(id + ': Seed が欠損/不正のため定義表の値を使用');
        } else if (rec.seed !== dst.seed) {
          out.seedMismatch.push(id);
          out.notes.push(id + ': 保存されたSeed(' + rec.seed + ')が定義表(' + dst.seed + ')と異なる。定義表の値を使う(島の再現性に注意)');
        }
        if (isFiniteNumber(rec.generatorVersion)) dst.generatorVersion = rec.generatorVersion;
        if (typeof rec.displayName === 'string' && rec.displayName.length > 0 && rec.displayName.length <= 40) {
          dst.displayName = rec.displayName;
        }
      }
      var extra = Object.keys(raw.islands).filter(function (k) { return ids.indexOf(k) < 0; });
      if (extra.length > 0) out.notes.push('未知の島ID ' + extra.length + ' 件は取り込まなかった');

      var legacyId = legacyFloorToIslandId(cf);
      if (typeof raw.currentIslandId === 'string' && legacyId !== null && raw.currentIslandId !== legacyId) {
        out.notes.push('currentIslandId(' + raw.currentIslandId + ')と currentFloor から導いた島(' + legacyId + ')が違う。currentFloor を優先');
      }
      // 以前に読めなかった原文の持ち越し(入れ子にしない。最初の1件だけ保持)
      if (hasOwn(raw, 'rejectedRaw') && raw.rejectedRaw !== undefined && raw.rejectedRaw !== null) {
        var carried = clonePreserved(raw.rejectedRaw);
        if (carried !== null) out.meta.rejectedRaw = carried;
        else out.notes.push('持ち越しの rejectedRaw が保持できない形だったため捨てた');
      }
      out.status = 'ok';
      return out;
    } catch (e) {
      out.meta = createDefaultMeta(cf);
      out.status = 'error';
      out.notes.push('islandMeta の取り込み中に例外: ' + (e && e.message ? e.message : String(e)));
      return out;
    }
  }

  // 保存用の islandMeta を作る。opts.floor: 今いる階(ゲーム側の currentFloor) / opts.previous: 直近に取り込んだ meta(任意)。
  // previous は検証し直してから複製して使う(元は書き換えない)。失敗時は null(呼び出し側は
  // キーを付けずに保存を続ける)。例外は投げない。
  function buildSaveMeta(opts) {
    try {
      var cf = (opts && typeof opts === 'object') ? opts.floor : undefined;
      var prev = (opts && typeof opts === 'object') ? opts.previous : undefined;
      var base;
      if (prev === undefined || prev === null) {
        base = createDefaultMeta(cf);
      } else {
        var r = readSaveMeta(prev, { floor: cf });
        // previous が使えない形(status が ok 以外)なら、メタデータを作り直さず既定で始める
        base = (r.status === 'ok') ? r.meta : createDefaultMeta(cf);
      }
      var legacyId = legacyFloorToIslandId(cf);
      if (legacyId !== null) base.currentIslandId = legacyId; // 階が範囲外なら既定の island-1(migrateFromLegacySave と同じ扱い。参考値であり正は currentFloor)
      return cloneJson(base, null);
    } catch (e) {
      return null;
    }
  }


  /* ---------------------------------------------------------------
     全島の状態のセーブ/ロード(セーブデータの任意キー islandStates)  — 第3段階
     ・形(stateVersion: 1):
         { stateVersion: 1,
           islands: { 'island-1': <島データ>, ... 5島分 },   // 島データの形は createEmptyIslandData を参照
           connected: ['world.choppedTreeIds'],              // 実ゲームが実際に書き込んでいる項目(情報用)
           rejectedRaw?: <読めなかった旧 islandStates の原文(64KBまで)> }
     ・キー名を islands にしなかった理由: migrateFromLegacySave は「ルートに islands を持つセーブ =
       変換済み」と見なす。それと紛れないよう、ルートのキーは islandStates にした。
     ・connected に無い項目(柵・農地・牧場・ボス・領民など)は、まだ実ゲームが書いていない。
       その項目が空でも「その島に何も無い」という意味ではない(正の保存場所は従来のキーのまま)。
     ・読み込み(readStatesSave)は検証だけを行い、ゲームもストアも書き換えない。
       呼び出し側が「検証 → すべて問題なければ反映」の順に使えるようにするため。
     ・島の並び・オブジェクトのプロパティ順には依存しない(listIslandIds の順で読み書きする)。
     --------------------------------------------------------------- */
  var STATES_VERSION = 1;

  function normalizeConnected(list) {
    var out = [];
    if (!Array.isArray(list)) return out;
    for (var i = 0; i < list.length && out.length < 50; i++) {
      if (typeof list[i] === 'string' && list[i].length > 0 && list[i].length <= 64 && out.indexOf(list[i]) < 0) out.push(list[i]);
    }
    return out;
  }

  // ストアの全島スナップショットから、セーブ用の islandStates を作る。失敗時は null(呼び出し側はキーを付けない)。
  function buildStatesSave(store, opts) {
    try {
      if (!store || typeof store.snapshot !== 'function') return null;
      var snap = store.snapshot();
      var out = { stateVersion: STATES_VERSION, islands: {}, connected: normalizeConnected(opts && opts.connected) };
      var ids = listIslandIds();
      for (var i = 0; i < ids.length; i++) {
        var rec = (snap && isPlainObject(snap.islands) && hasOwn(snap.islands, ids[i])) ? snap.islands[ids[i]] : undefined;
        out.islands[ids[i]] = sanitizeIslandData(ids[i], rec);
      }
      if (opts && opts.rejectedRaw !== undefined && opts.rejectedRaw !== null) {
        var kept = clonePreserved(opts.rejectedRaw);
        if (kept !== null) out.rejectedRaw = kept;
      }
      return cloneJson(out, null);
    } catch (e) {
      return null;
    }
  }

  // ロードしたセーブの islandStates(raw: 無い/壊れている可能性あり)を検証して、ストアに入れられる形にする。
  // 戻り値: { status, snapshot, notes, connected, rejectedRaw }
  //   status: 'absent'(旧セーブ・キー無し) | 'ok' | 'invalid' | 'future'(未知の新しい版) | 'too-large' | 'error'
  //   snapshot: status が 'ok' のときだけ { schemaVersion, islands }(全5島ぶん・整形済み)。それ以外は null。
  //   rejectedRaw: 読めなかった原文(保持できる大きさのときだけ)。再保存で失わないために使う。
  // raw は書き換えない。例外は投げない。
  function readStatesSave(raw) {
    var out = { status: 'error', snapshot: null, notes: [], connected: [], rejectedRaw: null };
    try {
      if (raw === undefined || raw === null) {
        out.status = 'absent';
        out.notes.push('islandStates が無い(旧セーブ)。島ごとの状態は初期値から始める');
        return out;
      }
      var reject = function (status, why, preserve) {
        out.status = status;
        out.notes.push(why);
        if (preserve) {
          var kept = clonePreserved(raw);
          if (kept !== null) out.rejectedRaw = kept;
          else out.notes.push('原文を保持できなかった(JSONにできない、または' + META_MAX_PRESERVE_CHARS + '文字超)');
        }
        return out;
      };
      if (!isPlainObject(raw)) return reject('invalid', 'islandStates がオブジェクトではないため使わない(原文は保持)', true);
      if (typeof raw.stateVersion !== 'number' || raw.stateVersion !== Math.floor(raw.stateVersion) || raw.stateVersion < 1) {
        return reject('invalid', 'islandStates.stateVersion が不正なため使わない(原文は保持)', true);
      }
      if (raw.stateVersion > STATES_VERSION) {
        return reject('future', 'islandStates.stateVersion=' + raw.stateVersion + ' は未対応の新しい版のため解釈しない(原文は保持)', true);
      }
      if (!isPlainObject(raw.islands)) return reject('invalid', 'islandStates.islands が不正なため使わない(原文は保持)', true);
      var text = JSON.stringify(raw);
      if (typeof text !== 'string' || text.length > LIMITS.MAX_STATES_CHARS) {
        return reject('too-large', 'islandStates が大きすぎる(' + LIMITS.MAX_STATES_CHARS + '文字超)ため使わない', false);
      }

      var snap = { schemaVersion: SCHEMA_VERSION, islands: {} };
      var ids = listIslandIds();
      for (var i = 0; i < ids.length; i++) {
        var id = ids[i];
        var rec = hasOwn(raw.islands, id) ? raw.islands[id] : undefined;
        if (rec === undefined) { out.notes.push(id + ': 記録なし(既定値を使用)'); snap.islands[id] = createEmptyIslandData(id); continue; }
        if (!isPlainObject(rec)) { out.notes.push(id + ': 記録が不正な型のため既定値を使用'); snap.islands[id] = createEmptyIslandData(id); continue; }
        if (isFiniteNumber(rec.seed) && rec.seed !== getSeed(id)) {
          out.notes.push(id + ': 保存されたSeed(' + rec.seed + ')が定義表(' + getSeed(id) + ')と異なる。定義表の値を使う');
        }
        var w = isPlainObject(rec.world) ? rec.world : null;
        if (w) {
          if (hasOwn(w, 'choppedTreeIds')) {
            var d = sanitizeTreeIdList(id, w.choppedTreeIds);
            if (d.notArray) out.notes.push(id + ': choppedTreeIds が配列ではないため空として扱う');
            if (d.dropped > 0) out.notes.push(id + ': choppedTreeIds のうち ' + d.dropped + ' 件は不正・重複・別の島のIDのため取り込まなかった');
            if (d.truncated) out.notes.push(id + ': choppedTreeIds が' + LIMITS.MAX_TREE_IDS + '件を超えているため先頭からだけ取り込んだ');
          }
          ['saplings', 'fences', 'farmlands', 'ranches', 'buildings', 'guestHouses'].forEach(function (k) {
            if (Array.isArray(w[k]) && w[k].length > LIMITS.MAX_RECORDS) out.notes.push(id + ': world.' + k + ' が' + LIMITS.MAX_RECORDS + '件を超えているため先頭からだけ取り込んだ');
          });
        }
        snap.islands[id] = sanitizeIslandData(id, rec);
      }
      var extra = Object.keys(raw.islands).filter(function (k) { return ids.indexOf(k) < 0; });
      if (extra.length > 0) out.notes.push('未知の島ID ' + extra.length + ' 件は取り込まなかった');

      out.connected = normalizeConnected(raw.connected);
      // 以前に読めなかった原文の持ち越し(入れ子にしない。最初の1件だけ保持)
      if (hasOwn(raw, 'rejectedRaw') && raw.rejectedRaw !== undefined && raw.rejectedRaw !== null) {
        var carried = clonePreserved(raw.rejectedRaw);
        if (carried !== null) out.rejectedRaw = carried;
        else out.notes.push('持ち越しの rejectedRaw が保持できない形だったため捨てた');
      }
      out.snapshot = snap;
      out.status = 'ok';
      return out;
    } catch (e) {
      out.snapshot = null;
      out.status = 'error';
      out.notes.push('islandStates の取り込み中に例外: ' + (e && e.message ? e.message : String(e)));
      return out;
    }
  }

  /* ---------------------------------------------------------------
     島の設定データ(島タイプ・生成パラメータ・生成方式の版)  — 第4段階
     ・目的: 5つの島の「種類」を、Seedだけに任せず、islandType と生成パラメータで明示する。
       この段階では【設定の参照と検証だけ】。地形・木・岩・結晶の生成、島間移動、保存形式の変更は行わない。
     ・読み取り専用: ゲームの状態・マップ・セーブデータ・島の状態ストアには一切触れない
       (ゲーム本編はまだこの設定を呼んでいない)。
     ・島IDは第3段階までの 'island-1'〜'island-5' をそのまま使う。
       理由: セーブの islandMeta / islandStates のキー、木の安定ID('island-1:tree:…')がすでにこのIDに
       依存しているため。企画書の推奨名(starter / rocky / forest / arid / crystal)は別の項目 key として持ち、
       key から島IDを引ける(toIslandId)ようにした。
     ・表示名は title に持つ。第3段階までの defaultName('第N の島')と、セーブに入る displayName は
       変えない(セーブとの互換のため)。
     ・Seed は既存の ISLAND_DEFS の値を getSeed で引いて使う(同じ値を2か所に書かない。getSeed と常に同じ値)。
     ・generatorVersion は「地形生成方式の版」。セーブ形式の版(SAVE_VERSION / SCHEMA_VERSION)とは別物。
         0 = 旧マップ(生成していない。island-1 だけ)
         1 = 地形生成の最初の方式(第5段階以降で実装予定。今回は未実装)
     ・params は将来の地形生成が読む値(すべて 0〜1 の割合)。島タイプごとに「その島らしさ」を保つ範囲を
       決めてあり、範囲から外れた値は検証で弾く。
     ・どの関数も例外を投げない。不正な入力は null / false / エラー一覧で返す。
       取得(get など)は常に複製を返し、元の設定表(深く凍結済み)や他の島へ影響しない。
     --------------------------------------------------------------- */
  var CONFIG_VERSION = 1;               // この設定表の形の版(セーブには書かない)
  var GENERATOR_VERSION_LEGACY = 0;     // 旧マップ(生成していない)
  var GENERATOR_VERSION_CURRENT = 1;    // 地形生成方式の最初の版(未実装。予約)
  var TERRAIN_GENERATION_IMPLEMENTED = false; // 第4段階では地形を作る処理は無い

  var MAP_POLICIES = Object.freeze(['legacy', 'generated']);

  function deepFreeze(o) {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) {
      Object.freeze(o);
      var keys = Object.keys(o);
      for (var i = 0; i < keys.length; i++) deepFreeze(o[keys[i]]);
    }
    return o;
  }
  function range(min, max) { return Object.freeze({ min: min, max: max }); }

  /* 島タイプごとの決まり。
     ・mapPolicy: 'legacy' = 既存マップを維持(生成しない) / 'generated' = 将来生成する島
     ・signature: その島を特徴づける最重要パラメータ(下限以上で、その島のパラメータの中で最大であること)
     ・params: 持つべきパラメータ名と、許される値の範囲(0〜1の中でさらに絞ってある)
       範囲を絞る理由: 値を1つ書き換えただけで別の島のような性格にならないようにする。
       また、空き地・道が 0 にならない下限を置き、将来の生成で通れない島ができるのを防ぐ。 */
  var TYPE_SPECS = deepFreeze({
    legacy_starter: { mapPolicy: 'legacy', signature: null, params: null },
    rocky: {
      mapPolicy: 'generated', signature: 'rockDensity',
      params: { rockDensity: range(0.6, 1), treeDensity: range(0, 0.25), openAreaRatio: range(0.05, 0.4), cliffDensity: range(0.2, 0.8) }
    },
    forest: {
      mapPolicy: 'generated', signature: 'treeDensity',
      params: { treeDensity: range(0.6, 1), rockDensity: range(0, 0.3), clearingRatio: range(0.05, 0.3), pathDensity: range(0.1, 0.6) }
    },
    arid: {
      mapPolicy: 'generated', signature: 'sandRatio',
      params: { sandRatio: range(0.6, 1), treeDensity: range(0, 0.15), rockDensity: range(0, 0.4), openAreaRatio: range(0.5, 1) }
    },
    crystal: {
      mapPolicy: 'generated', signature: 'crystalDensity',
      params: { crystalDensity: range(0.4, 1), rockDensity: range(0.2, 0.7), treeDensity: range(0, 0.25), glowIntensity: range(0.2, 0.9) }
    }
  });
  var SIGNATURE_MIN = 0.4; // signature の下限(crystal の 0.4 に合わせた共通の最低ライン)

  /* 5島の設定表(島タイプ・生成パラメータの唯一の定義場所)。島IDは ISLAND_DEFS と同じ並び、Seed は ISLAND_DEFS から引く。
     Seed は一度公開したら変更しないこと(変更すると島の形が変わる。変更するなら ISLAND_DEFS 側で)。 */
  var ISLAND_SETTINGS = deepFreeze([
    {
      islandId: 'island-1', key: 'starter', islandType: 'legacy_starter',
      title: '緑の開拓島',
      description: '従来のゲーム世界と過去のセーブを守る始まりの島。既存マップを維持し、新しい地形生成では上書きしない。',
      seed: getSeed('island-1'), generatorVersion: GENERATOR_VERSION_LEGACY,
      mapPolicy: 'legacy', keepLegacyMap: true,
      params: null
    },
    {
      islandId: 'island-2', key: 'rocky', islandType: 'rocky',
      title: '砕けた巨岩島',
      description: '岩や岩山が多く木が少ない島。通れる道と小さな平地を確保する。',
      seed: getSeed('island-2'), generatorVersion: GENERATOR_VERSION_CURRENT,
      mapPolicy: 'generated', keepLegacyMap: false,
      params: { rockDensity: 0.75, treeDensity: 0.08, openAreaRatio: 0.2, cliffDensity: 0.45 }
    },
    {
      islandId: 'island-3', key: 'forest', islandType: 'forest',
      title: '翠影の森島',
      description: '木々が密集し、森の中に空き地と自然の道がある島。',
      seed: getSeed('island-3'), generatorVersion: GENERATOR_VERSION_CURRENT,
      mapPolicy: 'generated', keepLegacyMap: false,
      params: { treeDensity: 0.85, rockDensity: 0.12, clearingRatio: 0.15, pathDensity: 0.3 }
    },
    {
      islandId: 'island-4', key: 'arid', islandType: 'arid',
      title: '風紋の荒野島',
      description: '砂地や乾いた地面が多く、植生が少なく見通しのよい島。',
      seed: getSeed('island-4'), generatorVersion: GENERATOR_VERSION_CURRENT,
      mapPolicy: 'generated', keepLegacyMap: false,
      params: { sandRatio: 0.8, treeDensity: 0.05, rockDensity: 0.2, openAreaRatio: 0.75 }
    },
    {
      islandId: 'island-5', key: 'crystal', islandType: 'crystal',
      title: '晶脈の神秘島',
      description: '紫水晶や特殊な岩が多い、神秘的な景観の島。',
      seed: getSeed('island-5'), generatorVersion: GENERATOR_VERSION_CURRENT,
      mapPolicy: 'generated', keepLegacyMap: false,
      params: { crystalDensity: 0.7, rockDensity: 0.45, treeDensity: 0.1, glowIntensity: 0.6 }
    }
  ]);

  function findSetting(id) {
    if (typeof id !== 'string') return null;
    for (var i = 0; i < ISLAND_SETTINGS.length; i++) {
      if (ISLAND_SETTINGS[i].islandId === id) return ISLAND_SETTINGS[i];
    }
    return null;
  }
  function findSettingByKey(key) {
    if (typeof key !== 'string') return null;
    for (var i = 0; i < ISLAND_SETTINGS.length; i++) {
      if (ISLAND_SETTINGS[i].key === key) return ISLAND_SETTINGS[i];
    }
    return null;
  }
  function typeSpecOf(type) {
    return (typeof type === 'string' && hasOwn(TYPE_SPECS, type)) ? TYPE_SPECS[type] : null;
  }

  // 1つの島設定(def)を検証する。def は書き換えない。戻り値: { valid, errors: [文字列...] }
  // 設定表そのものだけでなく、複製して編集した設定や、外から来た不正な値の検査にも使える。
  function validateIslandSetting(def) {
    var errors = [];
    try {
      if (!isPlainObject(def)) return { valid: false, errors: ['設定がオブジェクトではない'] };
      if (typeof def.islandId !== 'string' || !isValidIslandId(def.islandId)) errors.push('islandId が未知または不正: ' + String(def.islandId));
      if (typeof def.key !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/.test(def.key)) errors.push('key が不正(英小文字で始まる32文字以内の英数字と_)');
      if (typeof def.title !== 'string' || def.title.length < 1 || def.title.length > 40) errors.push('title が不正(1〜40文字の文字列)');
      if (typeof def.description !== 'string' || def.description.length < 1 || def.description.length > 200) errors.push('description が不正(1〜200文字の文字列)');
      if (!(typeof def.seed === 'number' && isFinite(def.seed) && def.seed === Math.floor(def.seed) && def.seed > 0 && def.seed <= 2147483647)) {
        errors.push('seed が不正(1〜2147483647の整数)');
      } else if (typeof def.islandId === 'string' && isValidIslandId(def.islandId) && def.seed !== getSeed(def.islandId)) {
        errors.push('seed が島の固定Seed(' + getSeed(def.islandId) + ')と違う');
      }
      var spec = typeSpecOf(def.islandType);
      if (!spec) {
        errors.push('islandType が未知または不正: ' + String(def.islandType));
      } else {
        if (def.mapPolicy !== spec.mapPolicy) errors.push('mapPolicy が島タイプ ' + def.islandType + ' の決まり(' + spec.mapPolicy + ')と違う');
        if (MAP_POLICIES.indexOf(def.mapPolicy) < 0) errors.push('mapPolicy が不正');
        if (def.keepLegacyMap !== (spec.mapPolicy === 'legacy')) errors.push('keepLegacyMap が mapPolicy と合わない');
        var gv = def.generatorVersion;
        if (!(typeof gv === 'number' && isFinite(gv) && gv === Math.floor(gv) && gv >= 0 && gv <= 999)) {
          errors.push('generatorVersion が不正(0〜999の整数)');
        } else if (spec.mapPolicy === 'legacy' && gv !== GENERATOR_VERSION_LEGACY) {
          errors.push('旧マップの島の generatorVersion は ' + GENERATOR_VERSION_LEGACY + ' でなければならない');
        } else if (spec.mapPolicy === 'generated' && gv < 1) {
          errors.push('生成する島の generatorVersion は 1 以上でなければならない');
        }
        if (spec.params === null) {
          if (def.params !== null) errors.push('旧マップの島は params を持たない(null)');
        } else if (!isPlainObject(def.params)) {
          errors.push('params がオブジェクトではない');
        } else {
          var names = Object.keys(spec.params);
          for (var i = 0; i < names.length; i++) {
            var v = hasOwn(def.params, names[i]) ? def.params[names[i]] : undefined;
            var r = spec.params[names[i]];
            if (typeof v !== 'number' || !isFinite(v)) { errors.push('params.' + names[i] + ' が数値ではない/欠けている'); continue; }
            if (v < r.min || v > r.max) errors.push('params.' + names[i] + '=' + v + ' が許される範囲(' + r.min + '〜' + r.max + ')の外');
          }
          Object.keys(def.params).forEach(function (k) {
            if (names.indexOf(k) < 0) errors.push('params.' + k + ' は島タイプ ' + def.islandType + ' に無いパラメータ');
          });
          var sg = spec.signature;
          if (sg && typeof def.params[sg] === 'number') {
            if (def.params[sg] < SIGNATURE_MIN) errors.push('特徴を表す params.' + sg + ' が低すぎる(' + SIGNATURE_MIN + '以上)');
            names.forEach(function (k) {
              if (typeof def.params[k] === 'number' && def.params[k] > def.params[sg]) errors.push('params.' + k + ' が特徴を表す params.' + sg + ' より大きい');
            });
          }
        }
      }
    } catch (e) {
      errors.push('検証中に例外: ' + (e && e.message ? e.message : String(e)));
    }
    return { valid: errors.length === 0, errors: errors };
  }

  // 設定表全体の検証(島IDの一意・key/Seed/titleの一意・ISLAND_DEFS との一致・各島の検証・旧マップ維持の島が1つだけ)
  // list を省略すると本物の設定表を検証する。複製して編集した一覧を渡して検査することもできる(書き換えない)。
  function validateAllIslandSettings(list) {
    var errors = [];
    var perIsland = {};
    try {
      var arr = (list === undefined) ? ISLAND_SETTINGS : list;
      if (!Array.isArray(arr)) return { valid: false, errors: ['設定の一覧が配列ではない'], perIsland: perIsland };
      var seenId = {}, seenKey = {}, seenSeed = {}, seenTitle = {};
      var legacyCount = 0, firstOk = false;
      for (var i = 0; i < arr.length; i++) {
        var s = arr[i];
        var label = (isPlainObject(s) && typeof s.islandId === 'string') ? s.islandId : '#' + i;
        var r = validateIslandSetting(s);
        perIsland[label] = r;
        r.errors.forEach(function (m) { errors.push(label + ': ' + m); });
        if (!isPlainObject(s)) continue;
        if (hasOwn(seenId, s.islandId)) errors.push('islandId が重複: ' + String(s.islandId));
        if (hasOwn(seenKey, s.key)) errors.push('key が重複: ' + String(s.key));
        if (hasOwn(seenSeed, s.seed)) errors.push('seed が重複: ' + String(s.seed));
        if (hasOwn(seenTitle, s.title)) errors.push('title が重複: ' + String(s.title));
        seenId[s.islandId] = true; seenKey[s.key] = true; seenSeed[s.seed] = true; seenTitle[s.title] = true;
        if (s.keepLegacyMap === true) { legacyCount++; if (s.islandId === 'island-1') firstOk = true; }
      }
      var defIds = listIslandIds();
      if (defIds.length !== arr.length) errors.push('島の数が ISLAND_DEFS(' + defIds.length + ')と設定の一覧(' + arr.length + ')で違う');
      for (var j = 0; j < defIds.length; j++) {
        if (!hasOwn(seenId, defIds[j])) errors.push(defIds[j] + ': 設定の一覧に無い');
      }
      if (legacyCount !== 1) errors.push('旧マップを維持する島はちょうど1つでなければならない(現在 ' + legacyCount + ')');
      if (!firstOk) errors.push('island-1 は旧マップ維持でなければならない');
    } catch (e) {
      errors.push('検証中に例外: ' + (e && e.message ? e.message : String(e)));
    }
    return { valid: errors.length === 0, errors: errors, perIsland: perIsland };
  }

  // 島ID または key('rocky' など)から、正規の島IDを得る。未知・不正な型は null(別の島へ読み替えない)。
  function toIslandId(idOrKey) {
    if (typeof idOrKey !== 'string') return null;
    var s = findSetting(idOrKey);
    if (s) return s.islandId;
    var k = findSettingByKey(idOrKey);
    return k ? k.islandId : null;
  }

  // 保存済みの generatorVersion(recorded。無い/壊れている可能性あり)から、「その島の版」を決める。
  // ・保存された値が正しければ、そのまま尊重する(新しい設定値で上書きしない)。
  // ・無い/不正なとき: 旧マップの島は 0(旧マップ扱い)、生成する島は null(まだ生成していない)。
  // どの場合も、地形の再生成をすすめる結果にはならない(この段階には生成処理が無い)。
  // 未知の島IDは null。
  function resolveSavedGeneratorVersion(islandId, recorded) {
    var s = findSetting(islandId);
    if (!s) return null;
    if (typeof recorded === 'number' && isFinite(recorded) && recorded === Math.floor(recorded) && recorded >= 0 && recorded <= 999) {
      return { generatorVersion: recorded, source: 'recorded' };
    }
    if (s.keepLegacyMap === true) return { generatorVersion: GENERATOR_VERSION_LEGACY, source: 'legacy-default' };
    return { generatorVersion: null, source: 'unrecorded' };
  }

  var Config = {
    VERSION: CONFIG_VERSION,
    GENERATOR_VERSION_LEGACY: GENERATOR_VERSION_LEGACY,
    GENERATOR_VERSION_CURRENT: GENERATOR_VERSION_CURRENT,
    TERRAIN_GENERATION_IMPLEMENTED: TERRAIN_GENERATION_IMPLEMENTED,
    // 島IDの一覧(ISLAND_DEFS と同じ順)
    listIds: function () { return ISLAND_SETTINGS.map(function (s) { return s.islandId; }); },
    // 島の設定の複製(未知の島ID・型違いは null)。複製を編集しても設定表・他の島には影響しない。
    get: function (islandId) { var s = findSetting(islandId); return s ? cloneJson(s, null) : null; },
    getByKey: function (key) { var s = findSettingByKey(key); return s ? cloneJson(s, null) : null; },
    // 全島の設定の複製(島の並びは listIds と同じ)
    getAll: function () { return cloneJson(ISLAND_SETTINGS, []); },
    // 島タイプに合う島の設定の複製の配列(未知の島タイプは空配列)
    getByType: function (type) {
      if (typeof type !== 'string') return [];
      return ISLAND_SETTINGS.filter(function (s) { return s.islandType === type; }).map(function (s) { return cloneJson(s, null); });
    },
    listTypes: function () { return Object.keys(TYPE_SPECS); },
    isKnownType: function (type) { return typeSpecOf(type) !== null; },
    // 島タイプの決まり(パラメータ名と許される範囲)の複製。未知の島タイプは null。
    getTypeSpec: function (type) { var sp = typeSpecOf(type); return sp ? cloneJson(sp, null) : null; },
    isLegacyMap: function (islandId) { var s = findSetting(islandId); return s ? s.keepLegacyMap === true : false; },
    toIslandId: toIslandId,
    validate: validateIslandSetting,
    validateAll: validateAllIslandSettings,
    resolveSavedGeneratorVersion: resolveSavedGeneratorVersion
  };

  /* ---------------------------------------------------------------
     公開API(グローバルに追加する名前は IslandManager のみ)
     --------------------------------------------------------------- */
  var api = {
    SCHEMA_VERSION: SCHEMA_VERSION,
    isValidIslandId: isValidIslandId,
    listIslandIds: listIslandIds,
    getSeed: getSeed,
    getDefaultName: getDefaultName,
    getDefinition: getDefinition,
    legacyFloorToIslandId: legacyFloorToIslandId,
    islandIdToLegacyFloor: islandIdToLegacyFloor,
    createEmptyIslandData: createEmptyIslandData,
    sanitizeIslandData: sanitizeIslandData,
    createStore: createStore,
    migrateFromLegacySave: migrateFromLegacySave,
    // 第2段階: セーブデータの任意キー islandMeta(島メタデータ)
    META_VERSION: META_VERSION,
    buildSaveMeta: buildSaveMeta,
    readSaveMeta: readSaveMeta,
    // 第3段階: 伐採済みの木の安定ID / 全島の状態のセーブ・ロード / 上限値
    TreeId: TreeId,
    STATES_VERSION: STATES_VERSION,
    LIMITS: LIMITS,
    buildStatesSave: buildStatesSave,
    readStatesSave: readStatesSave,
    // 第4段階: 島の設定データ(島タイプ・Seed・生成方式の版・生成パラメータ)の参照と検証だけ。地形生成はしない
    Config: Config,
    // Seed付き乱数(既存の乱数とは別系統)
    Seed: {
      createRng: createRng,
      hashString: hashString,
      deriveSeed: deriveSeed,
      sampleSequence: sampleSequence
    }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api; // Node.jsでの試験用
  if (root) root.IslandManager = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
