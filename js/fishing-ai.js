/* =====================================================================
   js/fishing-ai.js — ルアーフィッシングの「ルール(純粋ロジック)」
   (ドラゴンハンター「ルアーフィッシングモード」)

   役割(これだけ):
     釣りの数値・計算式・判定ルールをまとめる。Three.js・DOM・ゲームのグローバルには一切触れない
     (Node.js からそのまま試験できる)。
       ・CONFIG        : 釣りの数値(速度・距離・確率・サイズの重み・ファイトの強さ・価格 …)をすべてここに集める
       ・createRng     : 釣り専用の乱数(島のSeed・木や岩の乱数列には一切影響しない。試験では固定・注入できる)
       ・castErrorTiles: 累計キャスト回数 → 着水の誤差(±3/±2/±1マス)
       ・rollFishSize  : 魚のサイズ(20〜100cm。大きいほど出にくい重み付き抽選)
       ・fishPrice     : 魚の売値(5 + 995×((サイズ-20)/80)^2 を整数に丸める)
       ・fightBaseTime : サイズ別の基準格闘時間(20cm=5秒 〜 100cm=30秒の線形補間)
       ・facingSea     : 「海に面して立っているか」を島の海岸データ(signed)から判定する
       ・PromptGate    : 「釣りをしますか?」の確認の出し方(1回だけ・「いいえ」後10秒は出さない)
       ・HitClock      : 実時間1秒ごとのヒット判定の時計(フレーム数に依存しない)
       ・Fight         : ヒット後のファイト(魚が左右に走る・竿を同じ向きに倒す・進行度/逃走リスク)
       ・resolveLanding/lureAt/bearingOf/steerAlpha: キャスト着水・ルアーの位置・竿の左右での進路変更

   座標系: ゲームのマップ座標(1マス=1ユニット)。(x,z)平面。
   勇者の向き f=(fx,fz)、勇者の右 r=(-fz,fx)(勇者の後ろから見たときの画面の右と同じ向き)。
   ===================================================================== */
(function (root) {
  'use strict';

  var CONFIG = {
    // ---------- 確認(「釣りをしますか?」) ----------
    confirmNoMs: 10000,       // 「いいえ」のあと、確認を出さない実時間(ミリ秒)
    confirmStable: 0.4,       // 条件を満たしたまま立ち止まっている時間(秒)。通りすがりで点滅しないため
    nearShoreDist: 3.0,       // 勇者の位置が、海岸線(signed=0)からこの距離以内なら「海辺」
    faceDist: 3.5,            // 勇者の向きの先、この距離以内に水面があれば「海に面している」
    openWaterAhead: 1.5,      // 水面のさらに先、この距離も水面であること(細い入り江・水たまりでは釣れない)
    seaMargin: 0.25,          // 「海上」とみなす余白(水際=見た目の波打ち際より、さらに沖側)

    // ---------- キャスト ----------
    castMinDist: 2.5,         // タップした海の場所が、勇者からこの距離より近ければ無効
    castMaxDist: 16,          // 同じく、この距離より遠ければ無効(糸の長さの上限)
    // 累計キャスト回数(5つの島で共通) → 着水位置の誤差(X/Z それぞれ ±err マス)
    accuracyTiers: [
      { fromCasts: 200, errTiles: 1 },
      { fromCasts: 100, errTiles: 2 },
      { fromCasts: 0,   errTiles: 3 }
    ],
    castWindup: 0.30,         // 「釣り1 ふりかぶり」を見せる時間(秒)
    castSwing: 0.18,          // 「釣り2 振り下ろし」から、ルアーが手を離れるまでの時間(秒)
    castFlightSpeed: 18,      // ルアーの飛ぶ速さ(マス/秒)
    castFlightMin: 0.45, castFlightMax: 1.0, // 飛んでいる時間の下限・上限(秒)
    castArcHeight: 1.4,       // 飛ぶ軌道の山の高さ
    landingMinDist: 1.0,      // 着水位置が勇者にこれより近い場合は、遠いほうへ補正する
    landingSettle: 0.6,       // 着水してから巻き始めるまでの間(秒)

    // ---------- ルアーを引く速さ(マス/秒) ----------
    speeds: [
      { key: 'slow', label: '低速', speed: 1.0 },
      { key: 'mid',  label: '中速', speed: 1.8 },
      { key: 'fast', label: '高速', speed: 3.4 }
    ],
    defaultSpeed: 'mid',
    recoverDist: 0.9,         // ルアーが勇者の足元(この距離)まで戻ったら回収完了
    // 竿の左右でルアーの進む向き(勇者から見た角度)を少し変える
    steerStepRad: 0.12,       // 1回のタップで変わる角度
    steerMaxRad: 0.5,         // キャストした向きから、変えられる最大の角度(糸の長さを超えて動かないための制限)
    steerAbsMax: 1.35,        // 勇者の正面から見た角度の上限(真横より後ろには引けない)
    steerPoseTime: 0.28,      // 進路を変えたときの「竿を振る」ポーズの時間(秒)

    // ---------- 魚の追跡・ヒット ----------
    detectRadius: 2.5,        // ルアーからこの距離以内を魚が通ると、ルアーを見つけて追いかける
    chaseSpeed: 2.6,          // 追跡中の魚の泳ぐ速さ(マス/秒)。ルアーがこれより速いと追いつけない
    chaseKeepDist: 0.45,      // 追いついた魚は、ルアーのこの距離まで近づく
    chaseLoseDist: 3.0,       // ルアーとの距離がこれを超えたら、魚は追跡をあきらめる
    chaseGiveUp: 15,          // 追跡を続ける最大の時間(秒)
    hitInterval: 1.0,         // ヒット判定の間隔(実時間・秒)。追跡開始から1秒ごと
    hitChance: 0.30,          // 1回の判定でヒットする確率
    fleeRadius: 10,           // 1匹ヒットしたとき、ルアーからこの距離以内の魚は逃走状態になる
    fleeSpeed: 3.6, fleeTime: 2.4, // 逃走中の速さ(マス/秒)と時間(秒)
    fledCooldown: 15,         // 逃走した魚が、ルアーに反応しない時間(秒)
    lostCooldown: 3,          // 追跡をあきらめた魚が、ルアーに反応しない時間(秒)
    escapeCooldown: 6,        // 魚に逃げられたあと、どの魚も新しく追いかけ始めない時間(秒)

    // ---------- 魚のサイズ(整数cm)と出やすさ(重み) ----------
    sizeMin: 20, sizeMax: 100,
    sizeBands: [
      { min: 20, max: 39,  weight: 50 },
      { min: 40, max: 59,  weight: 30 },
      { min: 60, max: 79,  weight: 15 },
      { min: 80, max: 100, weight: 5 }
    ],

    // ---------- ファイト ----------
    fightTimeMin: 5,          // 20cm の基準格闘時間(秒)。上手に操作した場合の目安(上限)
    fightTimeMax: 30,         // 100cm の基準格闘時間(秒)
    hitPoseTime: 0.7,         // ヒット直後の「あたり」を見せる時間(秒)
    landPoseTime: 1.3,        // 釣り上げの演出時間(秒)
    escapePoseTime: 0.9,      // 逃げられたあとの間(秒)
    fightStartProgress: 0.12, // ファイト開始時の進行度(0〜1)
    gainMult: 1.3,            // 正しい向きに倒している間の進行速度(基準時間 T に対し 1.3/T 毎秒 → 上手なら T より早い)
    wrongLossMult: 0.9,       // 逆向きに倒したときの進行度の減り(×サイズ倍率)
    idleLossMult: 0.25,       // 何もしないときの進行度の減り(×サイズ倍率)
    riskWrong: 0.55,          // 逆向きのときの逃走リスクの増え(毎秒。×サイズ倍率)
    riskIdle: 0.28,           // 何もしないときの逃走リスクの増え(毎秒。×サイズ倍率)
    riskRecover: 0.35,        // 正しい向きのときの逃走リスクの減り(毎秒)
    dirIntervalEasy: 2.2, dirIntervalHard: 0.9, // 魚が走る向きを変える間隔(秒)。大きい魚ほど短い
    dirGrace: 0.35,           // 向きが変わった直後の猶予(秒)。この間は有利にも不利にもならない
    rodHold: 0.45,            // 1回タップした竿の倒し状態を保つ時間(秒)。連打しなくても自然になる
    runAmpEasy: 1.2, runAmpHard: 3.2, // 魚が左右に走る距離(マス)。大きい魚ほど遠くへ
    runRateEasy: 1.8, runRateHard: 3.2, // 魚が左右へ振れる速さ(1.0=端から端までを1秒で、の倍率)
    pullInMax: 0.65,          // 進行度100%のとき、魚が勇者側へ寄ってくる割合

    // ---------- 農協の売値 ----------
    priceMin: 5, priceMax: 1000,

    // ---------- 保存 ----------
    maxPending: 40
  };

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }

  /* ---------- 釣り専用の乱数(mulberry32) ---------- */
  function createRng(seed) {
    var a = (isNum(seed) ? seed : 1) >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var x = a;
      x = Math.imul(x ^ (x >>> 15), x | 1);
      x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ---------- キャスト精度(累計キャスト回数 → 誤差マス) ---------- */
  function castErrorTiles(count, cfg) {
    cfg = cfg || CONFIG;
    var n = isNum(count) ? Math.max(0, Math.floor(count)) : 0;
    var tiers = cfg.accuracyTiers;
    for (var i = 0; i < tiers.length; i++) if (n >= tiers[i].fromCasts) return tiers[i].errTiles;
    return tiers[tiers.length - 1].errTiles;
  }

  /* ---------- 魚のサイズ ---------- */
  function normalizeFishSize(v, cfg) {
    cfg = cfg || CONFIG;
    if (!isNum(v)) return null;
    var s = Math.round(v);
    return (s >= cfg.sizeMin && s <= cfg.sizeMax) ? s : null;
  }
  // 重み付き抽選: まず帯を重みで選び、帯の中のサイズ(整数cm)は一様に選ぶ
  function rollFishSize(rng, cfg) {
    cfg = cfg || CONFIG;
    var bands = cfg.sizeBands, total = 0, i;
    for (i = 0; i < bands.length; i++) total += bands[i].weight;
    var r = rng() * total, acc = 0, band = bands[bands.length - 1];
    for (i = 0; i < bands.length; i++) { acc += bands[i].weight; if (r < acc) { band = bands[i]; break; } }
    var size = band.min + Math.floor(rng() * (band.max - band.min + 1));
    return clamp(size, cfg.sizeMin, cfg.sizeMax);
  }

  /* ---------- 売値 ---------- */
  function fishPrice(size, cfg) {
    cfg = cfg || CONFIG;
    var s = normalizeFishSize(size, cfg);
    if (s === null) return 0; // 不正なサイズは売れない
    var raw = cfg.priceMin + (cfg.priceMax - cfg.priceMin) * Math.pow((s - cfg.sizeMin) / (cfg.sizeMax - cfg.sizeMin), 2);
    return clamp(Math.round(raw), cfg.priceMin, cfg.priceMax);
  }

  /* ---------- 基準格闘時間(秒) ---------- */
  function fightBaseTime(size, cfg) {
    cfg = cfg || CONFIG;
    var t = clamp((size - cfg.sizeMin) / (cfg.sizeMax - cfg.sizeMin), 0, 1);
    return lerp(cfg.fightTimeMin, cfg.fightTimeMax, t);
  }

  /* ---------- 海・水面の判定(島の海岸データだけを使う) ---------- */
  // その点が「水面(海上)」か。waterOffset は、海岸線(signed=0)から見た目の水際までの沖側の距離(魚影と同じ値)
  function isSeaPoint(coast, x, z, waterOffset, cfg) {
    cfg = cfg || CONFIG;
    if (!coast || !isNum(x) || !isNum(z)) return false;
    var s = coast.signed(x, z);
    return isNum(s) && s < -((isNum(waterOffset) ? waterOffset : 0) + cfg.seaMargin);
  }
  // 勇者(x,z)が向き(fx,fz)で海に面して立っているか → { ok, reason, dist }
  function facingSea(coast, x, z, fx, fz, waterOffset, cfg) {
    cfg = cfg || CONFIG;
    if (!coast || !isNum(x) || !isNum(z) || !isNum(fx) || !isNum(fz)) return { ok: false, reason: 'nocoast' };
    var len = Math.hypot(fx, fz);
    if (!(len > 1e-6)) return { ok: false, reason: 'nodir' };
    fx /= len; fz /= len;
    var s0 = coast.signed(x, z);
    if (!isNum(s0) || s0 <= 0 || s0 > cfg.nearShoreDist) return { ok: false, reason: 'notshore' };
    for (var d = 0.5; d <= cfg.faceDist + 1e-9; d += 0.5) {
      if (isSeaPoint(coast, x + fx * d, z + fz * d, waterOffset, cfg)) {
        var far = d + cfg.openWaterAhead;
        if (isSeaPoint(coast, x + fx * far, z + fz * far, waterOffset, cfg)) return { ok: true, reason: 'ok', dist: d };
        return { ok: false, reason: 'shallow' };
      }
    }
    return { ok: false, reason: 'nosea' };
  }

  /* ---------- 「釣りをしますか?」の出し方 ---------- */
  // update() は 'show' / 'hide' / null を返す。条件を満たして立ち止まって一定時間たったら1回だけ 'show'。
  // 「いいえ」(answerNo)のあと confirmNoMs の間は出さない。その間も条件を満たしていれば時間をためておき、
  // 10秒たったらすぐ出せる(連続点滅・毎フレーム再表示はしない)。
  function PromptGate(cfg) {
    this.cfg = cfg || CONFIG;
    this.visible = false;
    this.noUntil = 0;
    this.stableT = 0;
  }
  PromptGate.prototype.update = function (dt, ctx) {
    if (!(ctx && ctx.canFish && ctx.stationary)) {
      this.stableT = 0;
      if (this.visible) { this.visible = false; return 'hide'; }
      return null;
    }
    if (this.visible) return null;
    this.stableT += dt;
    if (ctx.nowMs < this.noUntil) return null;
    if (this.stableT >= this.cfg.confirmStable) { this.visible = true; return 'show'; }
    return null;
  };
  PromptGate.prototype.answerNo = function (nowMs) { this.visible = false; this.noUntil = nowMs + this.cfg.confirmNoMs; this.stableT = 0; };
  PromptGate.prototype.answerYes = function () { this.visible = false; this.stableT = 0; };
  PromptGate.prototype.suppress = function (nowMs) { this.visible = false; this.noUntil = nowMs + this.cfg.confirmNoMs; this.stableT = 0; };
  PromptGate.prototype.reset = function () { this.visible = false; this.noUntil = 0; this.stableT = 0; };

  /* ---------- 実時間1秒ごとの判定の時計 ---------- */
  // advance(dt) は「今回の dt の間に、判定の時刻が何回来たか」を返す。dt の刻み方(フレームレート)によらず、
  // 経過時間が interval たまるごとにちょうど1回。
  function HitClock(interval) { this.interval = interval > 0 ? interval : CONFIG.hitInterval; this.acc = 0; }
  HitClock.prototype.advance = function (dt) {
    if (!(dt > 0)) return 0;
    this.acc += dt;
    var n = 0;
    while (this.acc >= this.interval - 1e-9) { this.acc -= this.interval; n++; }
    if (this.acc < 0) this.acc = 0;
    return n;
  };

  /* ---------- ルアーの位置・進路 ---------- */
  // hero: { x, z, fx, fz, rx, rz }。勇者から距離 d・正面から右へ alpha(ラジアン)の方向の点
  function lureAt(hero, d, alpha) {
    var c = Math.cos(alpha), s = Math.sin(alpha);
    return { x: hero.x + d * (hero.fx * c + hero.rx * s), z: hero.z + d * (hero.fz * c + hero.rz * s) };
  }
  function bearingOf(hero, p) {
    var dx = p.x - hero.x, dz = p.z - hero.z;
    var fwd = dx * hero.fx + dz * hero.fz, rgt = dx * hero.rx + dz * hero.rz;
    return { d: Math.hypot(dx, dz), alpha: Math.atan2(rgt, fwd) };
  }
  // 竿の左右(side=+1 右 / -1 左)で進路の角度を少し変える。キャストした向きから steerMaxRad を超えて変えられない。
  function steerAlpha(alpha0, alpha, side, cfg) {
    cfg = cfg || CONFIG;
    if (side !== 1 && side !== -1) return alpha;
    var lo = Math.max(alpha0 - cfg.steerMaxRad, -cfg.steerAbsMax), hi = Math.min(alpha0 + cfg.steerMaxRad, cfg.steerAbsMax);
    return clamp(alpha + side * cfg.steerStepRad, Math.min(lo, hi), Math.max(lo, hi));
  }

  /* ---------- キャストの着水位置 ---------- */
  // target: タップした海の場所。errTiles: 誤差(X/Z それぞれ ±errTiles)。isSea(x,z): 海上か。
  // 誤差を乗せた着水位置が海上でなければ、乱数で引き直し、それでもだめなら目標地点のほうへ寄せて海上に補正する。
  function resolveLanding(target, errTiles, rng, isSea, hero, cfg) {
    cfg = cfg || CONFIG;
    var i, p;
    function ok(q) { return isSea(q.x, q.z) && (!hero || Math.hypot(q.x - hero.x, q.z - hero.z) >= cfg.landingMinDist); }
    for (i = 0; i < 12; i++) {
      p = { x: target.x + (rng() * 2 - 1) * errTiles, z: target.z + (rng() * 2 - 1) * errTiles };
      if (ok(p)) return { x: p.x, z: p.z, corrected: i > 0 };
    }
    // 引き直しでも海上にならない(狭い海・岸ぎわ): 誤差を縮めていく
    var ox = (rng() * 2 - 1) * errTiles, oz = (rng() * 2 - 1) * errTiles;
    for (var k = 1; k <= 8; k++) {
      var sc = 1 - k / 8;
      p = { x: target.x + ox * sc, z: target.z + oz * sc };
      if (ok(p)) return { x: p.x, z: p.z, corrected: true };
    }
    return { x: target.x, z: target.z, corrected: true }; // 目標地点そのもの(呼び出し側で海上と確認済み)
  }

  /* ---------- 魚の動き(追跡・逃走) ---------- */
  function chaseStep(fish, lure, dt, cfg) {
    cfg = cfg || CONFIG;
    var dx = lure.x - fish.x, dz = lure.z - fish.z, dist = Math.hypot(dx, dz);
    var nx = fish.x, nz = fish.z;
    if (dist > cfg.chaseKeepDist) {
      var mv = Math.min(cfg.chaseSpeed * dt, dist - cfg.chaseKeepDist);
      nx += dx / dist * mv; nz += dz / dist * mv;
    }
    return { x: nx, z: nz, dist: Math.hypot(lure.x - nx, lure.z - nz), heading: dist > 1e-6 ? Math.atan2(-dz, dx) : 0 };
  }
  function fleeStep(fish, from, dt, cfg, angleIfOnTop) {
    cfg = cfg || CONFIG;
    var dx = fish.x - from.x, dz = fish.z - from.z, dist = Math.hypot(dx, dz);
    var ux, uz;
    if (dist > 1e-6) { ux = dx / dist; uz = dz / dist; } else { ux = Math.cos(angleIfOnTop || 0); uz = Math.sin(angleIfOnTop || 0); }
    return { x: fish.x + ux * cfg.fleeSpeed * dt, z: fish.z + uz * cfg.fleeSpeed * dt, heading: Math.atan2(-uz, ux) };
  }

  /* ---------- ファイト ----------
     魚が左右に(勇者の右 r を +1 として)走る。プレイヤーは魚が走る向きと同じ側へ竿を倒す。
       正しい向き: 進行度が増える(1.3/T 毎秒。T=基準格闘時間 → 上手なら T より早く釣れる)、逃走リスクが下がる
       逆向き    : 進行度が減る、逃走リスクが増える(サイズが大きいほど強く)
       何もしない: ゆっくり進行度が減り、逃走リスクが増える
       向きが変わった直後 dirGrace 秒は猶予(有利にも不利にもならない)
     進行度が1で釣り上げ成功('landed')、逃走リスクが1で逃げられる('escaped')。 */
  function Fight(size, rng, cfg) {
    this.cfg = cfg || CONFIG;
    this.rng = rng;
    this.size = size;
    this.k = clamp((size - this.cfg.sizeMin) / (this.cfg.sizeMax - this.cfg.sizeMin), 0, 1); // 0=小さい 1=大きい
    this.baseTime = fightBaseTime(size, this.cfg);
    this.progress = this.cfg.fightStartProgress;
    this.risk = 0;
    this.dir = rng() < 0.5 ? -1 : 1;     // 魚が今走っている向き(-1=左 / +1=右)
    this.dirTimer = this._nextInterval();
    this.grace = this.cfg.dirGrace;
    // 向きが変わった直後の猶予(dirGrace)の分だけ、正しく倒せる時間が減る。その分を進行速度で補い、
    // 「上手に操作すれば基準時間 T より早く釣れる」ようにする(魚が大きく切替が速いほど、補正が大きい)。
    var avgInt = lerp(this.cfg.dirIntervalEasy, this.cfg.dirIntervalHard, this.k);
    this.gainRate = this.cfg.gainMult / this.baseTime / clamp(1 - 0.7 * this.cfg.dirGrace / avgInt, 0.4, 1);
    this.run = this.dir;                 // 画面に出す魚の左右位置(-1〜+1)。dir に向かって滑らかに動く
    this.rodDir = 0;                     // 竿を倒している向き(0=倒していない)
    this.rodHold = 0;
    this.elapsed = 0;
    this.result = null;                  // 'landed' | 'escaped'
    this.correctTime = 0; this.wrongTime = 0; this.idleTime = 0;
  }
  Fight.prototype._nextInterval = function () {
    return lerp(this.cfg.dirIntervalEasy, this.cfg.dirIntervalHard, this.k) * (0.75 + 0.5 * this.rng());
  };
  Fight.prototype.runAmp = function () { return lerp(this.cfg.runAmpEasy, this.cfg.runAmpHard, this.k); };
  Fight.prototype.pull = function (side) {
    if (side !== 1 && side !== -1) return;
    this.rodDir = side; this.rodHold = this.cfg.rodHold;
  };
  Fight.prototype.update = function (dt) {
    if (this.result) return this.result;
    if (!(dt > 0)) return null;
    var c = this.cfg, k = this.k;
    this.elapsed += dt;
    // 魚が走る向き: 一定時間ごとに変わる(同じ向きのままになることもある)
    this.dirTimer -= dt;
    if (this.dirTimer <= 0) {
      if (this.rng() < 0.7) this.dir = -this.dir;
      this.dirTimer = this._nextInterval();
      this.grace = c.dirGrace;
    }
    var rate = lerp(c.runRateEasy, c.runRateHard, k);
    this.run += clamp(this.dir - this.run, -rate * dt, rate * dt);
    // 竿の倒し状態は短時間だけ保つ
    if (this.rodHold > 0) { this.rodHold -= dt; if (this.rodHold <= 0) { this.rodHold = 0; this.rodDir = 0; } }
    var resist = 1 + k, T = this.baseTime;
    if (this.grace > 0) {
      this.grace -= dt;
      this.risk = Math.max(0, this.risk - 0.1 * dt);
    } else if (this.rodDir === this.dir) {
      this.progress += this.gainRate * dt;
      this.risk -= c.riskRecover * dt;
      this.correctTime += dt;
    } else if (this.rodDir === -this.dir) {
      this.progress -= (c.wrongLossMult / T) * resist * dt;
      this.risk += c.riskWrong * resist * dt;
      this.wrongTime += dt;
    } else {
      this.progress -= (c.idleLossMult / T) * resist * dt;
      this.risk += c.riskIdle * resist * dt;
      this.idleTime += dt;
    }
    this.progress = clamp(this.progress, 0, 1);
    this.risk = clamp(this.risk, 0, 1);
    if (this.progress >= 1) this.result = 'landed';
    else if (this.risk >= 1) this.result = 'escaped';
    else if (this.elapsed > T * 4 + 4) this.result = 'escaped'; // 念のための上限(必ず終わる)
    return this.result;
  };

  var api = {
    CONFIG: CONFIG,
    createRng: createRng,
    castErrorTiles: castErrorTiles,
    normalizeFishSize: normalizeFishSize,
    rollFishSize: rollFishSize,
    fishPrice: fishPrice,
    fightBaseTime: fightBaseTime,
    isSeaPoint: isSeaPoint,
    facingSea: facingSea,
    PromptGate: PromptGate,
    HitClock: HitClock,
    lureAt: lureAt,
    bearingOf: bearingOf,
    steerAlpha: steerAlpha,
    resolveLanding: resolveLanding,
    chaseStep: chaseStep,
    fleeStep: fleeStep,
    Fight: Fight
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.FishingAI = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
