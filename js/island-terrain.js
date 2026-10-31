/* =====================================================================
   js/island-terrain.js  — 島ごとの地形(木・岩・結晶・地面の色)の「配置計画」を作る(第5段階)

   役割(これだけ):
     第4段階の島設定(IslandManager.Config)と島ごとの固定Seedから、
     「どこに木・岩・結晶を置くか」「地面をどんな色味にするか」という“計画(データ)”を作る。
     計画は純粋なデータで、Three.js・DOM・ゲームのグローバル変数に一切触れない。
     実際のメッシュ作成・表示切替は game.html 側(島の装飾セット)が行う。

   やらないこと:
     ・島間移動・紫水晶・敵・ボス・農業・牧場・メイド・領民・時間・経済・セーブ形式の変更
     ・Math.random() の使用(Seed付き乱数だけを使う。グローバルの乱数関数にも触れない)
     ・地形の高さ(heightAt)・バイオーム(biomeAt)の変更(建物・柵・農地の高さと整合させるため)

   再現性の作り方:
     ・乱数は IslandManager.Seed.createRng(IslandManager.Seed.deriveSeed(島ID, 用途名)) で用途別に分離する
       (trees / rocks / cliffs / crystals / clearings / paths / ground)。
       ある用途の乱数を使う量が変わっても、他の用途の乱数列は変わらない。
     ・候補地点は「必ず一定個数の乱数を引く」形で作り、保護領域(建物・通路など)による除外は
       “後から”フィルタするだけにする。保護領域が変わっても、別の木の位置はずれない
       (木のIDは島ID+位置なので、伐採記録が別の木へずれる事故を防ぐ)。

   島設定が使えないとき(欠損・不正・island-1 の旧マップ):
     mode:'legacy' を返す。呼び出し側は「既存の木・岩・地面」をそのまま使う(安全な既存挙動)。
   ===================================================================== */
(function (root) {
  'use strict';

  var GENERATOR_VERSION = 1; // 島設定の generatorVersion(=1: 地形生成の最初の方式)と一致させる

  // 描画・負荷の上限(InstancedMesh の容量。従来の木900・岩260と同程度に抑える)
  var CAPS = { trees: 900, rocks: 400, crystals: 160 };
  // 候補地点の数(固定。ここを変えると配置が変わるので generatorVersion を上げること)
  var CANDIDATES = { trees: 6000, rocks: 5000 };
  // 密度 1.0 のときの目標本数(密度×これ)
  var BASE = { trees: 900, rocks: 300, crystalClusters: 20, cliffClusters: 40 };

  var DEFAULT_CTX = {
    mapHalf: 50,
    band: { grass: 8, thicket: 18, forest: 32, mountain: 46 },
    reserved: [],     // [{x,z,r}] 何も置かない円(建物・開始地点・湧き枠など)
    corridors: [],    // [{x1,z1,x2,z2,w}] 何も置かない通路(幅w)
    extraReserved: [] // [{x,z,r}] 既存の柵・農地・ゲストハウス・苗木など(作り直さず、避けるだけ)
  };

  function getIM() {
    if (root && root.IslandManager) return root.IslandManager;
    if (typeof require === 'function') { try { return require('./island-manager.js'); } catch (e) { return null; } }
    return null;
  }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function cheb(x, z) { return Math.max(Math.abs(x), Math.abs(z)); }
  function round3(v) { return Math.round(v * 1000) / 1000; }

  /* ---------- 計画の対象になる島か(設定を検証する) ---------- */
  // 戻り値: { ok:true, cfg } | { ok:false, reason }
  function resolveSetting(islandId) {
    var IM = getIM();
    if (!IM || !IM.Config || typeof IM.Config.get !== 'function' || !IM.Seed) return { ok: false, reason: 'no-island-manager' };
    var cfg = null;
    try { cfg = IM.Config.get(islandId); } catch (e) { return { ok: false, reason: 'config-error' }; }
    if (!cfg) return { ok: false, reason: 'unknown-island' };
    if (cfg.mapPolicy !== 'generated' || cfg.keepLegacyMap === true) return { ok: false, reason: 'legacy-map' };
    if (cfg.generatorVersion !== GENERATOR_VERSION) return { ok: false, reason: 'generator-version-mismatch' };
    var v = null;
    try { v = IM.Config.validate(cfg); } catch (e) { return { ok: false, reason: 'validate-error' }; }
    if (!v || v.valid !== true) return { ok: false, reason: 'invalid-setting' };
    if (!cfg.params || typeof cfg.params !== 'object') return { ok: false, reason: 'no-params' };
    return { ok: true, cfg: cfg };
  }

  /* ---------- 保護領域の判定(後からフィルタするだけ) ---------- */
  function distToSegment(px, pz, x1, z1, x2, z2) {
    var dx = x2 - x1, dz = z2 - z1;
    var len2 = dx * dx + dz * dz;
    var t = len2 > 0 ? ((px - x1) * dx + (pz - z1) * dz) / len2 : 0;
    t = clamp(t, 0, 1);
    return Math.hypot(px - (x1 + t * dx), pz - (z1 + t * dz));
  }
  function inCircles(list, x, z, margin) {
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (Math.hypot(x - c.x, z - c.z) < c.r + margin) return true;
    }
    return false;
  }
  function inCorridors(list, x, z, margin) {
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (distToSegment(x, z, c.x1, c.z1, c.x2, c.z2) < c.w / 2 + margin) return true;
    }
    return false;
  }
  function inRegions(ctx, x, z, margin) {
    return inCircles(ctx.reserved, x, z, margin) || inCorridors(ctx.corridors, x, z, margin) || inCircles(ctx.extraReserved, x, z, margin);
  }

  /* ---------- ゲーム側の情報から保護領域つきの ctx を作る(純粋関数) ---------- */
  // info: { buildings:[{x,z}], board:{x,z}, start:{x,z}, zako:[{x,z}], boss:{x,z}, extra:[{x,z,r}] }
  function buildContext(info) {
    var ctx = {
      mapHalf: DEFAULT_CTX.mapHalf,
      band: { grass: DEFAULT_CTX.band.grass, thicket: DEFAULT_CTX.band.thicket, forest: DEFAULT_CTX.band.forest, mountain: DEFAULT_CTX.band.mountain },
      reserved: [], corridors: [], extraReserved: []
    };
    if (!info || typeof info !== 'object') return ctx;
    if (info.mapHalf && isNum(info.mapHalf)) ctx.mapHalf = info.mapHalf;
    if (info.band && typeof info.band === 'object') {
      ['grass', 'thicket', 'forest', 'mountain'].forEach(function (k) { if (isNum(info.band[k])) ctx.band[k] = info.band[k]; });
    }
    var start = (info.start && isNum(info.start.x) && isNum(info.start.z)) ? info.start : { x: 0, z: 2 };
    ctx.reserved.push({ x: start.x, z: start.z, r: 4 });
    function addPoint(p, r, corridor) {
      if (!p || !isNum(p.x) || !isNum(p.z)) return;
      ctx.reserved.push({ x: p.x, z: p.z, r: r });
      if (corridor) ctx.corridors.push({ x1: start.x, z1: start.z, x2: p.x, z2: p.z, w: 2.4 });
    }
    (Array.isArray(info.buildings) ? info.buildings : []).forEach(function (b) { addPoint(b, 6.5, true); });
    addPoint(info.board, 3.5, false);
    (Array.isArray(info.zako) ? info.zako : []).forEach(function (p) { addPoint(p, 6, true); });
    addPoint(info.boss, 6, true);
    (Array.isArray(info.extra) ? info.extra : []).forEach(function (e) {
      if (e && isNum(e.x) && isNum(e.z) && isNum(e.r)) ctx.extraReserved.push({ x: e.x, z: e.z, r: e.r });
    });
    // 海岸修正: (x,z) が「木・岩・結晶を置いてよい陸地」か(砂浜・海は false)。無ければ従来どおり制限しない。
    if (typeof info.onLand === 'function') ctx.onLand = info.onLand;
    return ctx;
  }

  /* ---------- 島ごとの「個性」の決まり(設定の項目をどう使うか) ---------- */
  // 地面の色味(hex)。mix は「元の地面色にどれだけ寄せるか」。
  var GROUND = {
    rocky:   { color: 0x8a7f72, hi: 0.85, lo: 0.25 },
    forest:  { color: 0x2a5a2e, hi: 0.55, lo: 0.15 },
    arid:    { color: 0xd9c48c, hi: 0.90, lo: 0.35, alt: 0xa5a25a },
    crystal: { color: 0x4b4670, hi: 0.70, lo: 0.30 }
  };
  // 保護領域より外側で、バイオーム帯ごとに置きやすさを変える(従来の草地・高山には置かない)
  function treeWeight(d, band) {
    if (d < band.grass || d >= band.mountain) return 0;
    if (d < band.thicket) return 0.8;
    if (d < band.forest) return 1.0;
    return 0.45;
  }
  function rockWeight(d, band) {
    if (d < band.grass + 2 || d >= band.mountain) return 0;
    if (d < band.forest) return 0.8;
    return 1.2;
  }
  function weightedArea(fn, band) {
    var sum = 0, half = 50;
    for (var iz = -half; iz < half; iz++) for (var ix = -half; ix < half; ix++) sum += fn(cheb(ix + 0.5, iz + 0.5), band);
    return sum;
  }

  function rngFor(IM, islandId, label) { return IM.Seed.createRng(IM.Seed.deriveSeed(islandId, label)); }

  /* ---------- 空き地・自然道(Seedだけで決まる。保護領域には依存しない) ---------- */
  function makeClearings(IM, islandId, cfg) {
    var p = cfg.params, out = [];
    var ratio = isNum(p.clearingRatio) ? p.clearingRatio : (isNum(p.openAreaRatio) ? p.openAreaRatio : 0);
    var count = Math.round(ratio * (isNum(p.clearingRatio) ? 40 : 30));
    var rng = rngFor(IM, islandId, 'clearings');
    for (var i = 0; i < count; i++) {
      var x = (rng() * 2 - 1) * 42, z = (rng() * 2 - 1) * 42, r = 3.5 + rng() * (isNum(p.clearingRatio) ? 3.5 : 4.5);
      out.push({ x: round3(x), z: round3(z), r: round3(r) });
    }
    return out;
  }
  function makePaths(IM, islandId, cfg) {
    var p = cfg.params, out = [];
    var count = isNum(p.pathDensity) ? Math.round(p.pathDensity * 10) : 0;
    var rng = rngFor(IM, islandId, 'paths');
    for (var i = 0; i < count; i++) {
      var ang = rng() * Math.PI * 2;
      var wob = (rng() * 2 - 1) * 0.35;
      var px = Math.cos(ang) * 8, pz = Math.sin(ang) * 8;
      for (var s = 1; s <= 8; s++) {
        var a2 = ang + wob * Math.sin(s * 0.9 + i);
        var rad = 8 + s * 4.8;
        var nx = Math.cos(a2) * rad, nz = Math.sin(a2) * rad;
        out.push({ x1: round3(px), z1: round3(pz), x2: round3(nx), z2: round3(nz), w: 1.8 });
        px = nx; pz = nz;
      }
    }
    return out;
  }

  /* ---------- 木 ---------- */
  function makeTrees(IM, islandId, cfg, ctx, clearings, paths, area) {
    var p = cfg.params;
    var density = isNum(p.treeDensity) ? p.treeDensity : 0;
    var target = density * BASE.trees;
    var rng = rngFor(IM, islandId, 'trees');
    var N = CANDIDATES.trees;
    var c = area > 0 ? target * 10000 / (N * area) : 0; // 期待本数が target になる受理率の係数
    var list = [];
    for (var i = 0; i < N; i++) {
      // 1候補につき必ず6個の乱数を引く(フィルタの結果で乱数の消費量を変えない)
      var rx = rng(), rz = rng(), acc = rng(), rs = rng(), rr = rng(), rh = rng();
      var x = (rx * 2 - 1) * ctx.mapHalf, z = (rz * 2 - 1) * ctx.mapHalf;
      var w = treeWeight(cheb(x, z), ctx.band);
      if (w <= 0) continue;
      if (ctx.onLand && !ctx.onLand(x, z)) continue; // 海岸修正: 砂浜・海には置かない(乱数は引いた後なので他の木はずれない)
      if (acc >= Math.min(1, c * w)) continue;
      if (inCircles(clearings, x, z, 0)) continue;
      if (inCorridors(paths, x, z, 0)) continue;
      if (inRegions(ctx, x, z, 1.0)) continue;
      list.push({ x: round3(x), z: round3(z), scale: round3(0.7 + rs * 0.7), rotY: round3(rr * Math.PI * 2), hpRoll: rh });
      if (list.length >= CAPS.trees) break;
    }
    return list;
  }

  /* ---------- 岩(通常の岩 + 崖・岩山の大きな岩) ---------- */
  function makeRocks(IM, islandId, cfg, ctx, clearings, area) {
    var p = cfg.params;
    var density = isNum(p.rockDensity) ? p.rockDensity : 0;
    var target = density * BASE.rocks;
    var rng = rngFor(IM, islandId, 'rocks');
    var N = CANDIDATES.rocks;
    var c = area > 0 ? target * 10000 / (N * area) : 0;
    var list = [];
    for (var i = 0; i < N; i++) {
      var rx = rng(), rz = rng(), acc = rng(), rs = rng(), rr = rng();
      var x = (rx * 2 - 1) * ctx.mapHalf, z = (rz * 2 - 1) * ctx.mapHalf;
      var w = rockWeight(cheb(x, z), ctx.band);
      if (w <= 0) continue;
      if (ctx.onLand && !ctx.onLand(x, z)) continue; // 海岸修正: 砂浜・海には置かない
      if (acc >= Math.min(1, c * w)) continue;
      // 空き地では岩も控えめ(完全には消さない): 決まった乱数 rs で一部だけ残す
      if (inCircles(clearings, x, z, 0) && rs > 0.3) continue;
      if (inRegions(ctx, x, z, 1.2)) continue;
      list.push({ x: round3(x), z: round3(z), scale: round3(0.6 + rs * 1.1), rotY: round3(rr * Math.PI * 2), big: false });
      if (list.length >= CAPS.rocks) break;
    }
    // 崖・岩山: 設定 cliffDensity がある島だけ。大きな岩を数個まとめて置く
    if (isNum(p.cliffDensity)) {
      var crng = rngFor(IM, islandId, 'cliffs');
      var clusters = Math.round(p.cliffDensity * BASE.cliffClusters);
      for (var k = 0; k < clusters; k++) {
        var ang = crng() * Math.PI * 2, rad = 14 + crng() * 28;
        var cx = Math.cos(ang) * rad, cz = Math.sin(ang) * rad;
        var m = 4 + Math.floor(crng() * 4);
        for (var j = 0; j < m; j++) { // 1つの岩につき必ず4個引く
          var a2 = crng() * Math.PI * 2, r2 = crng() * 3.2, sc = crng(), ro = crng();
          var x2 = cx + Math.cos(a2) * r2, z2 = cz + Math.sin(a2) * r2;
          if (cheb(x2, z2) < ctx.band.grass + 2 || cheb(x2, z2) >= ctx.band.mountain) continue;
          if (ctx.onLand && !ctx.onLand(x2, z2)) continue; // 海岸修正: 砂浜・海には置かない
          if (inRegions(ctx, x2, z2, 1.8)) continue;
          if (list.length >= CAPS.rocks) break;
          list.push({ x: round3(x2), z: round3(z2), scale: round3(1.8 + sc * 1.4), rotY: round3(ro * Math.PI * 2), big: true });
        }
      }
    }
    return list;
  }

  /* ---------- 結晶(crystalDensity を持つ島だけ) ---------- */
  function makeCrystals(IM, islandId, cfg, ctx) {
    var p = cfg.params;
    if (!isNum(p.crystalDensity)) return [];
    var rng = rngFor(IM, islandId, 'crystals');
    var clusters = Math.round(p.crystalDensity * BASE.crystalClusters);
    var list = [];
    for (var k = 0; k < clusters; k++) {
      var ang = rng() * Math.PI * 2, rad = 12 + rng() * 32;
      var cx = Math.cos(ang) * rad, cz = Math.sin(ang) * rad;
      var m = 5 + Math.floor(rng() * 5);
      for (var j = 0; j < m; j++) { // 1つの結晶につき必ず5個引く
        var a2 = rng() * Math.PI * 2, r2 = rng() * 2.4, sc = rng(), tilt = rng(), col = rng();
        var x = cx + Math.cos(a2) * r2, z = cz + Math.sin(a2) * r2;
        var d = cheb(x, z);
        if (d < ctx.band.grass + 2 || d >= ctx.band.mountain) continue;
        if (ctx.onLand && !ctx.onLand(x, z)) continue; // 海岸修正: 砂浜・海には置かない
        if (inRegions(ctx, x, z, 1.6)) continue;
        if (list.length >= CAPS.crystals) break;
        list.push({ x: round3(x), z: round3(z), scale: round3(0.8 + sc * 1.4), tilt: round3((tilt - 0.5) * 0.5), colorIndex: Math.min(2, Math.floor(col * 3)) });
      }
    }
    return list;
  }

  /* ---------- 地面の色味(ノイズ。島ごとのSeedで決まる) ---------- */
  function hashInt(ix, iz, seed) {
    var h = (Math.imul(ix | 0, 374761393) + Math.imul(iz | 0, 668265263) + Math.imul(seed | 0, 2147483647)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h = h ^ (h >>> 16);
    return (h >>> 0) / 4294967296;
  }
  function valueNoise(x, z, seed) {
    var xi = Math.floor(x), zi = Math.floor(z), xf = x - xi, zf = z - zi;
    var u = xf * xf * (3 - 2 * xf), v = zf * zf * (3 - 2 * zf);
    var a = hashInt(xi, zi, seed), b = hashInt(xi + 1, zi, seed), c = hashInt(xi, zi + 1, seed), d = hashInt(xi + 1, zi + 1, seed);
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
  }
  // 標準正規分布の累積分布関数(Abramowitz-Stegun 7.1.26 の近似。誤差 約1.5e-7)
  function normalCdf(z) {
    var sign = z < 0 ? -1 : 1, x = Math.abs(z) / Math.SQRT2;
    var tt = 1 / (1 + 0.3275911 * x);
    var y = 1 - (((((1.061405429 * tt - 1.453152027) * tt) + 1.421413741) * tt - 0.284496736) * tt + 0.254829592) * tt * Math.exp(-x * x);
    return 0.5 * (1 + sign * y);
  }
  function smooth(e0, e1, x) { var t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); }

  function groundRatio(type, p) {
    if (type === 'rocky') return clamp((p.rockDensity || 0) * 0.7 + (p.cliffDensity || 0) * 0.3, 0, 1);
    if (type === 'forest') return clamp(p.treeDensity || 0, 0, 1);
    if (type === 'arid') return clamp(p.sandRatio || 0, 0, 1);
    if (type === 'crystal') return clamp((p.rockDensity || 0) + (p.crystalDensity || 0) * 0.3, 0, 1);
    return 0;
  }
  // 地面の色味。計画が 'generated' のとき { color: hex, mix: 0..1 }、それ以外は null。
  function groundTint(plan, x, z) {
    if (!plan || plan.mode !== 'generated' || !plan.ground) return null;
    var g = plan.ground;
    var n = valueNoise(x * 0.08, z * 0.08, g.seed) * 0.7 + valueNoise(x * 0.23, z * 0.23, g.seed ^ 0x5bd1e995) * 0.3;
    // ノイズの値は中央(平均0.5・標準偏差約0.16)に偏るので、正規分布の累積分布で 0〜1 に均して
    // 「n < 割合」の面積が、設定の割合(sandRatio など)にほぼ一致するようにする。
    var u = normalCdf((n - 0.5) / 0.16);
    var k = smooth(g.ratio - 0.04, g.ratio + 0.04, u); // 0=主な色 / 1=元の地面に近い側
    var mix = g.hi + (g.lo - g.hi) * k;
    var color = g.color;
    if (k > 0.5 && g.alt !== undefined) color = g.alt;
    var d = cheb(x, z);
    var scale = d < plan.band.grass ? 0.85 : (d >= plan.band.mountain ? 0.6 : 1);
    return { color: color, mix: round3(mix * scale) };
  }

  /* ---------- 計画の作成(外から呼ぶ入口) ---------- */
  // 戻り値: { mode:'legacy', islandId, reason } | { mode:'generated', ... }
  function createPlan(islandId, ctxIn) {
    var res = resolveSetting(islandId);
    if (!res.ok) return { mode: 'legacy', islandId: islandId, reason: res.reason };
    try {
      var IM = getIM(), cfg = res.cfg;
      var ctx = ctxIn && typeof ctxIn === 'object' ? ctxIn : buildContext(null);
      ctx = {
        mapHalf: isNum(ctx.mapHalf) ? ctx.mapHalf : DEFAULT_CTX.mapHalf,
        band: ctx.band || DEFAULT_CTX.band,
        reserved: Array.isArray(ctx.reserved) ? ctx.reserved : [],
        corridors: Array.isArray(ctx.corridors) ? ctx.corridors : [],
        extraReserved: Array.isArray(ctx.extraReserved) ? ctx.extraReserved : [],
        onLand: typeof ctx.onLand === 'function' ? ctx.onLand : null
      };
      var treeArea = weightedArea(treeWeight, ctx.band), rockArea = weightedArea(rockWeight, ctx.band);
      var clearings = makeClearings(IM, islandId, cfg);
      var paths = makePaths(IM, islandId, cfg);
      var trees = makeTrees(IM, islandId, cfg, ctx, clearings, paths, treeArea);
      var rocks = makeRocks(IM, islandId, cfg, ctx, clearings, rockArea);
      var crystals = makeCrystals(IM, islandId, cfg, ctx);
      var spec = GROUND[cfg.islandType];
      var ground = spec ? {
        seed: IM.Seed.deriveSeed(islandId, 'ground') | 0, color: spec.color, alt: spec.alt,
        hi: spec.hi, lo: spec.lo, ratio: groundRatio(cfg.islandType, cfg.params)
      } : null;
      return {
        mode: 'generated', islandId: islandId, islandType: cfg.islandType, seed: cfg.seed,
        generatorVersion: cfg.generatorVersion, params: cfg.params, band: ctx.band,
        trees: trees, rocks: rocks, crystals: crystals,
        crystalGlow: isNum(cfg.params.glowIntensity) ? cfg.params.glowIntensity : 0,
        clearings: clearings, paths: paths, ground: ground
      };
    } catch (e) {
      // 計画づくりで失敗したときは「既存の挙動」に戻す(握りつぶして成功扱いにはせず、理由を返す)
      return { mode: 'legacy', islandId: islandId, reason: 'error', error: String(e && e.message || e) };
    }
  }

  function summarize(plan) {
    if (!plan || plan.mode !== 'generated') return { mode: plan ? plan.mode : null, reason: plan ? plan.reason : null };
    return {
      mode: 'generated', islandId: plan.islandId, islandType: plan.islandType,
      trees: plan.trees.length, rocks: plan.rocks.length, bigRocks: plan.rocks.filter(function (r) { return r.big; }).length,
      crystals: plan.crystals.length, clearings: plan.clearings.length, paths: plan.paths.length
    };
  }

  var api = {
    GENERATOR_VERSION: GENERATOR_VERSION,
    CAPS: CAPS,
    buildContext: buildContext,
    createPlan: createPlan,
    groundTint: groundTint,
    summarize: summarize,
    // 試験用: 保護領域の判定をそのまま公開する(描画側の判定と同じ関数)
    isReserved: function (ctx, x, z, margin) { return inRegions(ctx, x, z, margin || 0); }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.IslandTerrain = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
