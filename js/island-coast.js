/* =====================================================================
   js/island-coast.js  — 島ごとの海岸線(海・砂浜・陸地)の「地形データ」を作る(第5段階・海岸修正)

   役割(これだけ):
     島ID(island-1〜island-5)の固定Seedから、その島の輪郭(海岸線)を決め、
       ・海   (SEA)   : 侵入不可。建築・柵・農地・苗木なども置けない
       ・砂浜 (BEACH) : 歩行可能。海岸に沿った帯(幅 BEACH_W タイル)
       ・陸地 (LAND)  : 従来どおりの内陸(従来の草地・茂み・森・山のバイオームをそのまま使う)
     を、座標 (x,z) から判定する純粋関数群を提供する。
     Three.js・DOM・ゲームのグローバルに一切触れない(試験が Node.js から直接読み込める)。

   座標系: 原点(0,0)が島の中心(開始地点付近)。1タイル=1ユニット。

   海岸線の決め方:
     海岸線 = 中心から角度θ方向の距離 R(θ)。R(θ) は「基準半径 + 低い周波数の波(1〜3次)+ 小さなゆらぎ」。
       signed(x,z) = R(θ) - r   … 正なら島の内側(海岸線からの距離)、0以下なら海。
       海   : signed <= 0
       砂浜 : 0 < signed <= BEACH_W
       陸地 : signed >  BEACH_W
     R(θ) は R_MIN〜R_MAX に収める。これにより
       ・島は必ず中心を含む一つのかたまり(中心から見て星形)=島の内側が必ず連結し、陸続きの別の島ができない
       ・砂浜は海岸線に沿って必ず陸地と海の間に入る(幅は海岸線全周で一定=途切れない)
       ・海は島の外側すべて(島どうしは別のマップなので、もともと陸続きにならない)
     になる。

   高さ:
     従来の地形の高さ(landH)を、海岸線付近だけ滑らかに低くする(blendHeight)。
       内陸(signed >= BEACH_W+BLEND_W): landH そのまま(内陸の山・起伏は変えない)
       砂浜〜その内側のゆるい坂: 砂浜の高さへ向かって下がる
       海: 海面より下へ沈む(海底)
     高さを下げるだけで、古い「高山の壁」を高さでも取り除く。

   再現性:
     乱数は IslandManager.Seed の「coast」用の子Seedだけを使う(Math.random は使わない)。
     同じ島ID・同じ固定Seedなら、毎回まったく同じ海岸線になる。他の用途(木・岩など)の乱数列は変わらない。
   ===================================================================== */
(function (root) {
  'use strict';

  var COAST_VERSION = 1;
  var KIND = { SEA: 0, BEACH: 1, LAND: 2 };

  var BEACH_W = 4;        // 砂浜の幅(タイル)
  var BLEND_W = 9;        // 砂浜の内側で、従来の高さへ戻していく帯の幅(タイル)
  var R_MIN = 40.5;       // 海岸線の半径の下限(砂浜の内側の端 = R-BEACH_W >= 36.5。全フロアの建物・湧き枠はこの内側に収まる)
  var R_MAX = 45.5;       // 海岸線の半径の上限(軸方向でも従来の外周 cheb<46 に収まる)
  var SHORE_H = 0.55;     // 海岸線(波打ち際)の地面の高さ
  var BEACH_TOP_H = 1.15; // 砂浜の陸側の端の高さ(従来の草地の高さ=1 に近い)
  var SEA_FLOOR_H = -1.2; // 海底の高さ
  var WATER_Y = 0.28;     // 海面の高さ(波打ち際 SHORE_H より少し低い。海底は海面より下)

  // 島タイプごとの輪郭の性格(基準半径と、波の大きさ)。島の個性(見た目)に合わせた固定の表。
  //   amp: 1次・2次・3次の波の最大振幅 / jag: 細かいゆらぎの振幅
  var SHAPE = {
    legacy_starter: { base: 43.0, amp: [1.2, 0.8, 0.5], jag: 0.25 }, // 第1の島: おだやかな丸い島
    rocky:          { base: 42.5, amp: [2.0, 1.4, 1.0], jag: 0.60 }, // 岩の島: 入り組んだ海岸
    forest:         { base: 43.5, amp: [1.5, 1.0, 0.6], jag: 0.35 },
    arid:           { base: 44.0, amp: [1.0, 0.6, 0.4], jag: 0.20 }, // 荒野の島: 広くなだらか
    crystal:        { base: 42.0, amp: [1.8, 1.2, 0.8], jag: 0.45 }
  };
  var DEFAULT_SHAPE = SHAPE.legacy_starter;

  function getIM() {
    if (root && root.IslandManager) return root.IslandManager;
    if (typeof require === 'function') { try { return require('./island-manager.js'); } catch (e) { return null; } }
    return null;
  }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function smooth(e0, e1, x) { var t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); }
  function round3(v) { return Math.round(v * 1000) / 1000; }

  // 島IDから島タイプを調べる(設定が無い・読めないときは第1の島の形)
  function islandTypeOf(IM, islandId) {
    try {
      if (IM && IM.Config && typeof IM.Config.get === 'function') {
        var cfg = IM.Config.get(islandId);
        if (cfg && typeof cfg.islandType === 'string') return cfg.islandType;
      }
    } catch (e) { /* 既定の形を使う */ }
    return 'legacy_starter';
  }

  /* ---------- 海岸線の作成 ---------- */
  // 戻り値: 海岸オブジェクト、または島IDが不正・Seedが取れないときは null(呼び出し側は従来の地形のまま動く)
  function create(islandId) {
    var IM = getIM();
    if (!IM || !IM.Seed || typeof IM.Seed.deriveSeed !== 'function' || typeof IM.Seed.createRng !== 'function') return null;
    var seed = IM.Seed.deriveSeed(islandId, 'coast');
    if (seed === null || seed === undefined) return null;
    var rng = IM.Seed.createRng(seed);
    var shape = SHAPE[islandTypeOf(IM, islandId)] || DEFAULT_SHAPE;

    // 乱数は用途ごとに決まった個数を、決まった順で必ず引く(値の使い方が変わっても列がずれない)
    var waves = [];
    for (var k = 1; k <= 3; k++) {
      var a = (0.5 + 0.5 * rng()) * shape.amp[k - 1]; // 振幅(最大の半分〜最大)
      var ph = rng() * Math.PI * 2;                    // 位相
      waves.push({ k: k, a: a, ph: ph });
    }
    var jags = [];
    for (var j = 0; j < 3; j++) {
      var jf = 5 + j * 2;                              // 5, 7, 9 次の細かいゆらぎ
      jags.push({ k: jf, a: (0.4 + 0.6 * rng()) * shape.jag / (j + 1), ph: rng() * Math.PI * 2 });
    }
    var bias = (rng() * 2 - 1) * 0.6;                  // 基準半径の島ごとの微調整

    function radiusAt(theta) {
      var r = shape.base + bias;
      for (var i = 0; i < waves.length; i++) r += waves[i].a * Math.cos(waves[i].k * theta + waves[i].ph);
      for (var m = 0; m < jags.length; m++) r += jags[m].a * Math.cos(jags[m].k * theta + jags[m].ph);
      return clamp(r, R_MIN, R_MAX);
    }
    // 海岸線からの距離(正=島の内側)
    function signed(x, z) {
      var r = Math.sqrt(x * x + z * z);
      if (r < 1e-9) return R_MAX; // 中心(角度が定まらない)は必ず島の内側
      return radiusAt(Math.atan2(z, x)) - r;
    }
    function kindAt(x, z) {
      if (!isNum(x) || !isNum(z)) return KIND.SEA; // 不正な座標は海扱い(=歩けない)
      var s = signed(x, z);
      if (s <= 0) return KIND.SEA;
      if (s <= BEACH_W) return KIND.BEACH;
      return KIND.LAND;
    }
    // 従来の高さ landH(と、0..1 のゆらぎ用ノイズ n)を、海岸線に合わせて補正する
    function blendHeight(landH, x, z, n) {
      var s = signed(x, z);
      var nn = isNum(n) ? n : 0.5;
      if (s >= BEACH_W + BLEND_W) return landH;           // 内陸: 従来どおり
      if (s <= 0) {                                        // 海: 波打ち際から海底へ沈む
        return SHORE_H + (SEA_FLOOR_H - SHORE_H) * smooth(0, 2.5, -s);
      }
      var beachH = SHORE_H + (BEACH_TOP_H - SHORE_H) * smooth(0, BEACH_W, s) + (nn - 0.5) * 0.10 * smooth(0, 1, s);
      if (s <= BEACH_W) return beachH;                     // 砂浜
      var t = smooth(BEACH_W, BEACH_W + BLEND_W, s);       // 砂浜の内側: 従来の高さへゆるやかに戻す
      return beachH + (landH - beachH) * t;
    }
    // 試験・描画用: 海岸線の点列(角度ごとの半径)
    function outline(steps) {
      var n = (isNum(steps) && steps >= 8) ? Math.floor(steps) : 360, out = [];
      for (var i = 0; i < n; i++) {
        var th = (i / n) * Math.PI * 2 - Math.PI;
        out.push({ theta: round3(th), r: round3(radiusAt(th)) });
      }
      return out;
    }
    return {
      version: COAST_VERSION, islandId: islandId,
      radiusAt: radiusAt, signed: signed, kindAt: kindAt, blendHeight: blendHeight, outline: outline
    };
  }

  var api = {
    COAST_VERSION: COAST_VERSION,
    KIND: KIND,
    BEACH_W: BEACH_W, BLEND_W: BLEND_W, R_MIN: R_MIN, R_MAX: R_MAX,
    SHORE_H: SHORE_H, BEACH_TOP_H: BEACH_TOP_H, SEA_FLOOR_H: SEA_FLOOR_H, WATER_Y: WATER_Y,
    create: create
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.IslandCoast = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
