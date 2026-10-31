/* =====================================================================
   js/fishing.js — ルアーフィッシングの「釣りの流れ(状態管理)」
   (ドラゴンハンター「ルアーフィッシングモード」)

   役割(これだけ):
     釣りモードの進行(待機 → キャスト → ルアーを引く → 魚が追う → ヒット → ファイト → 釣り上げ/逃げられる)を
     状態として管理する。Three.js・DOM・ゲームのグローバルには直接触れない。必要なものはすべて
     「環境 env」として外から渡してもらう(js/fishing-ui.js が本物の env を作る。試験は偽物の env を渡す)。
       env.nowMs()                       … 実時間(ミリ秒)
       env.hero()                        … { x, y, z, fx, fz }  勇者の位置と向き
       env.coast() / env.waterOffset()   … いまいる島の海岸データ / 見た目の水際までの距離
       env.waterY() / env.rodTip()       … 水面の高さ / 竿の先の位置 { x, y, z }
       env.gateContext()                 … { blocked, stationary } 確認を出してよい状況か(他のUIが開いている等)
       env.fishReady()                   … 魚影の機能が動いているか
       env.fish                          … { list(), take(id), move(id,x,z,heading,swim), release(id,mode) }
       env.inventory                     … { canAddFish(size), addFish(size) }
       env.pose(name, fade)              … 勇者のポーズ('ready'|'cast2'|'retrieve'|'hit'|'swingR'|'swingL'|'land')
       env.enter(hero) / env.leave(why)  … 釣りモードに入る/出る(操作の隔離・カメラ・画面)
       env.stillValid(hero)              … 勇者の位置・島が釣り開始時のままか
       env.showConfirm() / env.hideConfirm() / env.toast(text, ms) / env.fx(name, x, z)
     ※ 魚影(js/fish.js)の見た目用データは壊さない。魚は Fish.takeFish で「借りて」動かし、終わったら返す。

   釣り専用のタイマー・状態はすべてこのオブジェクトの中にあり、stop() で必ず初期化される。
   釣り中の状態はセーブしない(保存するのは累計キャスト回数と、受け取り待ちの魚だけ)。
   ===================================================================== */
(function (root) {
  'use strict';

  var AI = (root && root.FishingAI) || (typeof require === 'function' ? require('./fishing-ai.js') : null);
  var CONFIG = AI.CONFIG;

  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  function Controller(env, opts) {
    opts = opts || {};
    this.env = env;
    this.cfg = opts.cfg || CONFIG;
    // 釣り専用の乱数(島のSeed・木や岩・魚影の乱数列には影響しない)。試験では固定・注入できる。
    this.rng = opts.rng || AI.createRng(((Date.now() ^ 0x5bd1e995) >>> 0) + Math.floor((typeof performance !== 'undefined' ? performance.now() : 0) * 1000));
    this.gate = new AI.PromptGate(this.cfg);
    this.castCount = 0;      // 累計キャスト回数(5つの島で共通・セーブ対象)
    this.pending = [];       // インベントリに入らず保持中の魚のサイズ(セーブ対象。消失させない)
    this.speedKey = this.cfg.defaultSpeed;
    this.time = 0;           // 釣りの時計(実時間の積み上げ。ゲーム内時間とは無関係)
    this.gateAcc = 0;
    this.pendingAcc = 0;
    this.hintOverride = null;
    this._resetSession();
    this.mode = 'off';
  }

  // 釣りモード1回分の状態をすべて初期化する
  Controller.prototype._resetSession = function () {
    this.mode = this.mode === 'off' || this.mode === undefined ? 'off' : this.mode;
    this.modeT = 0;
    this.hero = null;
    this.lure = { active: false, inWater: false, x: 0, y: 0, z: 0 };
    this.castTarget = null;
    this.castReleased = false;
    this.flight = null;
    this.landing = null;
    this.alpha0 = 0; this.alpha = 0; this.d = 0; this.settle = 0;
    this.steerUntil = 0; this.steerSide = 0;
    this.chasers = [];       // 追跡中の魚 [{ id, x, z, age, clock }]
    this.fleers = [];        // 逃走中の魚 [{ id, x, z, fx, fz, t, ang }]
    this.ignore = {};        // 魚ID → この時刻(釣りの時計)まで、ルアーに反応しない
    this.globalCooldownUntil = 0;
    this.hook = null;        // ヒットした魚 { id, size, fight, d, alpha, resolved }
    this.curPose = null; this.poseAt = -10;
    this.lastCastInfo = null;
  };

  Controller.prototype.isActive = function () { return this.mode !== 'off'; };
  Controller.prototype.speedDef = function () {
    var sp = this.cfg.speeds;
    for (var i = 0; i < sp.length; i++) if (sp[i].key === this.speedKey) return sp[i];
    return sp[1];
  };
  Controller.prototype.accuracyTiles = function () { return AI.castErrorTiles(this.castCount, this.cfg); };

  /* ---------------- 確認(「釣りをしますか?」) ---------------- */
  Controller.prototype.canStartHere = function () {
    var env = this.env;
    if (!env.fishReady()) return false;
    var h = env.hero(), coast = env.coast();
    if (!h || !coast) return false;
    return AI.facingSea(coast, h.x, h.z, h.fx, h.fz, env.waterOffset(), this.cfg).ok;
  };
  Controller.prototype._updateGate = function (dt) {
    this.gateAcc += dt;
    if (this.gateAcc < 0.1) return;
    var step = this.gateAcc; this.gateAcc = 0;
    var ctx = this.env.gateContext() || {};
    var canFish = !ctx.blocked && this.canStartHere();
    var act = this.gate.update(step, { nowMs: this.env.nowMs(), canFish: canFish, stationary: !!ctx.stationary });
    if (act === 'show') this.env.showConfirm();
    else if (act === 'hide') this.env.hideConfirm();
  };
  Controller.prototype.answerYes = function () {
    this.gate.answerYes();
    this.env.hideConfirm();
    return this.start();
  };
  Controller.prototype.answerNo = function () {
    this.gate.answerNo(this.env.nowMs());
    this.env.hideConfirm();
  };

  /* ---------------- 開始・終了 ---------------- */
  Controller.prototype.start = function () {
    if (this.mode !== 'off') return false;
    var env = this.env, h = env.hero();
    if (!h || !this.canStartHere()) return false;
    var len = Math.hypot(h.fx, h.fz) || 1, fx = h.fx / len, fz = h.fz / len;
    this._resetSession();
    this.hero = { x: h.x, y: h.y, z: h.z, fx: fx, fz: fz, rx: -fz, rz: fx };
    this.mode = 'idle'; this.modeT = 0;
    try {
      env.enter(this.hero);
    } catch (e) {
      console.error('釣りモードを始められませんでした(通常のゲームに戻ります):', e);
      this.mode = 'off';
      try { env.leave('error'); } catch (e2) { /* 何もしない */ }
      this._resetSession();
      return false;
    }
    this._applyPose(true);
    this._flushPending(true);
    return true;
  };

  Controller.prototype.stop = function (reason) {
    if (this.mode === 'off') return;
    var env = this.env;
    try { this._releaseAllFish(); } catch (e) { console.error('釣り終了: 魚を戻せませんでした(続行):', e); }
    this.mode = 'off';
    this._resetSession();
    this.gate.suppress(env.nowMs()); // 終わった直後に、すぐ確認を出し直さない
    try { env.hideConfirm(); } catch (e) { /* 何もしない */ }
    try { env.leave(reason || 'stop'); } catch (e) { console.error('釣り終了処理でエラー(続行):', e); }
  };

  // セーブ/ロードなどの前に呼ぶ。釣り中なら終了し、確認の状態も初期化する
  Controller.prototype.reset = function (reason) {
    this.stop(reason || 'reset');
    this.gate.reset();
    this.gateAcc = 0;
    try { this.env.hideConfirm(); } catch (e) { /* 何もしない */ }
  };

  Controller.prototype._releaseAllFish = function () {
    var f = this.env.fish, i;
    for (i = 0; i < this.chasers.length; i++) f.release(this.chasers[i].id, 'keep');
    for (i = 0; i < this.fleers.length; i++) f.release(this.fleers[i].id, 'keep');
    if (this.hook && !this.hook.resolved) f.release(this.hook.id, 'keep');
    else if (this.hook) f.release(this.hook.id, 'remove');
    this.chasers = []; this.fleers = []; this.hook = null;
  };

  /* ---------------- 毎フレーム ---------------- */
  // dt は実時間(秒)。内部では 0.05 秒以下の刻みに分けて進める(フレームレートで結果が変わらないように)。
  Controller.prototype.update = function (dt) {
    if (!isNum(dt) || dt <= 0) return;
    dt = Math.min(dt, 0.5);
    this.pendingAcc += dt;
    if (this.pendingAcc >= 1) { this.pendingAcc = 0; this._flushPending(false); }
    if (this.mode === 'off') { this._updateGate(dt); return; }
    var left = dt;
    while (left > 1e-9 && this.mode !== 'off') {
      var step = Math.min(left, 0.05);
      left -= step;
      try {
        this._step(step);
      } catch (e) {
        console.error('釣りでエラーが起きたため、釣りモードだけを終了します(ゲームは続行):', e);
        this.stop('error');
        return;
      }
    }
  };

  Controller.prototype._step = function (dt) {
    var env = this.env;
    this.time += dt; this.modeT += dt;
    if (!env.stillValid(this.hero)) { this.stop('moved'); return; }
    this._updateFleers(dt);
    switch (this.mode) {
      case 'casting': this._stepCasting(dt); break;
      case 'flying': this._stepFlying(dt); break;
      case 'retrieving': this._stepRetrieving(dt); break;
      case 'hit': this._stepHit(dt); break;
      case 'fighting': this._stepFighting(dt); break;
      case 'landing': if (this.modeT >= this.cfg.landPoseTime) this._toIdle(); break;
      case 'escaped': if (this.modeT >= this.cfg.escapePoseTime) this._toIdle(); break;
      default: break;
    }
    if (this.mode !== 'off') this._applyPose(false);
  };

  Controller.prototype._setMode = function (m) { this.mode = m; this.modeT = 0; };
  Controller.prototype._toIdle = function () {
    this.lure.active = false; this.lure.inWater = false;
    this.castTarget = null; this.flight = null; this.hook = null;
    this._setMode('idle');
  };

  /* ---------------- ポーズ(アニメーション) ---------------- */
  // 状態から「いま見せるポーズ」を決める。短時間に切り替わり続けてちらつかないよう、最短の保持時間を設ける。
  Controller.prototype._desiredPose = function () {
    switch (this.mode) {
      case 'idle': return 'ready';
      case 'casting': return this.modeT < this.cfg.castWindup ? 'ready' : 'cast2';
      case 'flying': return 'cast2';
      case 'retrieving': return this.steerUntil > this.time ? (this.steerSide > 0 ? 'swingR' : 'swingL') : 'retrieve';
      case 'hit': return 'hit';
      case 'fighting':
        if (this.hook && this.hook.fight && this.hook.fight.rodHold > 0) return this.hook.fight.rodDir > 0 ? 'swingR' : 'swingL';
        return 'hit';
      case 'landing': return 'land';
      case 'escaped': return 'retrieve';
      default: return 'ready';
    }
  };
  Controller.prototype._applyPose = function (force) {
    var want = this._desiredPose();
    if (want === this.curPose) return;
    var bigChange = want === 'hit' || want === 'land' || want === 'cast2' || want === 'ready' || this.curPose === null;
    if (!force && !bigChange && this.time - this.poseAt < 0.12) return; // 左右の振りがちらつかないように
    this.curPose = want; this.poseAt = this.time;
    try { this.env.pose(want, 0.1); } catch (e) { console.error('ポーズの切替でエラー(続行):', e); }
  };

  /* ---------------- 入力(タップ) ---------------- */
  // ev: { side: -1(勇者の左)/+1(勇者の右), target: {x,z} | null(海の上をタップしていない) }
  Controller.prototype.onTap = function (ev) {
    if (this.mode === 'off' || !ev) return { ok: false };
    var side = ev.side === 1 ? 1 : (ev.side === -1 ? -1 : 0);
    switch (this.mode) {
      case 'idle': return this._tryCast(ev.target);
      case 'retrieving': return side ? this._steer(side) : { ok: false };
      case 'hit': case 'fighting':
        if (side && this.hook && this.hook.fight) { this.hook.fight.pull(side); return { ok: true }; }
        return { ok: false };
      default: return { ok: false }; // キャスト中・飛行中などの連続タップは無視(多重キャスト防止)
    }
  };

  Controller.prototype.setSpeed = function (key) {
    var sp = this.cfg.speeds;
    for (var i = 0; i < sp.length; i++) if (sp[i].key === key) { this.speedKey = key; return true; }
    return false;
  };

  /* ---------------- キャスト ---------------- */
  Controller.prototype._tryCast = function (target) {
    var env = this.env, cfg = this.cfg, h = this.hero;
    if (this.pending.length > 0) { env.toast('インベントリがいっぱいです(魚は保持中)', 1800); return { ok: false, reason: 'pending' }; }
    if (!target || !isNum(target.x) || !isNum(target.z)) { env.toast('海の上をタップしてね', 1400); return { ok: false, reason: 'notsea' }; }
    if (!AI.isSeaPoint(env.coast(), target.x, target.z, env.waterOffset(), cfg)) { env.toast('そこは海ではありません', 1400); return { ok: false, reason: 'notsea' }; }
    var dist = Math.hypot(target.x - h.x, target.z - h.z);
    if (dist < cfg.castMinDist) { env.toast('近すぎます', 1200); return { ok: false, reason: 'near' }; }
    if (dist > cfg.castMaxDist) { env.toast('遠すぎます', 1200); return { ok: false, reason: 'far' }; }
    this.castTarget = { x: target.x, z: target.z };
    this.castReleased = false;
    this._setMode('casting');
    return { ok: true };
  };

  Controller.prototype._stepCasting = function () {
    if (this.castReleased || this.modeT < this.cfg.castWindup + this.cfg.castSwing) return;
    this._releaseLure();
  };

  // ルアーが手を離れる瞬間: キャスト回数を1回だけ加算し、着水位置(誤差つき)を決める
  Controller.prototype._releaseLure = function () {
    var env = this.env, cfg = this.cfg;
    this.castReleased = true;
    var err = AI.castErrorTiles(this.castCount, cfg);
    var coast = env.coast(), off = env.waterOffset();
    var land = AI.resolveLanding(this.castTarget, err, this.rng, function (x, z) { return AI.isSeaPoint(coast, x, z, off, cfg); }, this.hero, cfg);
    this.castCount += 1;
    this.lastCastInfo = { err: err, target: this.castTarget, landing: land };
    this.landing = { x: land.x, z: land.z };
    var tip = env.rodTip() || { x: this.hero.x, y: this.hero.y + 1.6, z: this.hero.z };
    var dist = Math.hypot(land.x - tip.x, land.z - tip.z);
    var dur = Math.min(cfg.castFlightMax, Math.max(cfg.castFlightMin, dist / cfg.castFlightSpeed));
    this.flight = { sx: tip.x, sy: tip.y, sz: tip.z, ex: land.x, ez: land.z, dur: dur, t: 0 };
    this.lure.active = true; this.lure.inWater = false;
    this.lure.x = tip.x; this.lure.y = tip.y; this.lure.z = tip.z;
    this._setMode('flying');
  };

  Controller.prototype._stepFlying = function (dt) {
    var fl = this.flight, env = this.env;
    fl.t += dt;
    var u = Math.min(1, fl.t / fl.dur), wy = env.waterY();
    this.lure.x = fl.sx + (fl.ex - fl.sx) * u;
    this.lure.z = fl.sz + (fl.ez - fl.sz) * u;
    this.lure.y = fl.sy + (wy - fl.sy) * u + this.cfg.castArcHeight * Math.sin(Math.PI * u);
    if (u >= 1) {
      this.lure.x = fl.ex; this.lure.z = fl.ez; this.lure.y = wy; this.lure.inWater = true;
      try { env.fx('splash', fl.ex, fl.ez); } catch (e) { /* 演出だけ。続行 */ }
      var b = AI.bearingOf(this.hero, { x: fl.ex, z: fl.ez });
      this.d = b.d; this.alpha0 = b.alpha; this.alpha = b.alpha;
      this.settle = this.cfg.landingSettle;
      this._setMode('retrieving');
    }
  };

  /* ---------------- ルアーを引く ---------------- */
  Controller.prototype._steer = function (side) {
    var cfg = this.cfg, env = this.env;
    var na = AI.steerAlpha(this.alpha0, this.alpha, side, cfg);
    var p = AI.lureAt(this.hero, this.d, na);
    // ルアーがいま水の上にいるときは、動かした先も海上でなければ動かさない(陸地・島の中へ引かない)
    if (!this.lure.inWater || AI.isSeaPoint(env.coast(), p.x, p.z, env.waterOffset(), cfg)) this.alpha = na;
    this.steerSide = side; this.steerUntil = this.time + cfg.steerPoseTime;
    return { ok: true };
  };

  Controller.prototype._stepRetrieving = function (dt) {
    var env = this.env, cfg = this.cfg;
    if (this.modeT > this.settle) this.d -= this.speedDef().speed * dt;
    var p = AI.lureAt(this.hero, Math.max(0, this.d), this.alpha);
    this.lure.x = p.x; this.lure.z = p.z; this.lure.y = env.waterY();
    this.lure.inWater = AI.isSeaPoint(env.coast(), p.x, p.z, env.waterOffset(), cfg);
    if (this.d <= cfg.recoverDist) { this._recoverLure(); return; }
    this._updateChasers(dt);
  };

  Controller.prototype._recoverLure = function () {
    for (var i = 0; i < this.chasers.length; i++) {
      this.env.fish.release(this.chasers[i].id, 'keep');
      this.ignore[this.chasers[i].id] = this.time + 2;
    }
    this.chasers = [];
    this._toIdle();
  };

  /* ---------------- 魚の追跡とヒット ---------------- */
  Controller.prototype._updateChasers = function (dt) {
    var env = this.env, cfg = this.cfg, fishApi = env.fish, i;
    var lure = this.lure;
    if (!lure.inWater) { // ルアーが水から出た(岸の近く): 魚は追えない
      for (i = 0; i < this.chasers.length; i++) { fishApi.release(this.chasers[i].id, 'keep'); this.ignore[this.chasers[i].id] = this.time + 2; }
      this.chasers = [];
      return;
    }
    // 近くを通った魚が、ルアーを見つけて追いかけ始める
    if (this.time >= this.globalCooldownUntil) {
      var list = fishApi.list();
      for (i = 0; i < list.length; i++) {
        var fi = list[i];
        if ((this.ignore[fi.id] || 0) > this.time) continue;
        if (this._isChasing(fi.id)) continue;
        if (Math.hypot(fi.x - lure.x, fi.z - lure.z) > cfg.detectRadius) continue;
        if (fishApi.take(fi.id)) this.chasers.push({ id: fi.id, x: fi.x, z: fi.z, age: 0, clock: new AI.HitClock(cfg.hitInterval) });
        else this.ignore[fi.id] = this.time + 1;
      }
    }
    // 追跡中の魚を動かす
    var hitId = null;
    for (i = this.chasers.length - 1; i >= 0; i--) {
      var c = this.chasers[i];
      var st = AI.chaseStep(c, lure, dt, cfg);
      if (AI.isSeaPoint(env.coast(), st.x, st.z, env.waterOffset(), cfg)) { c.x = st.x; c.z = st.z; }
      var dist = Math.hypot(lure.x - c.x, lure.z - c.z);
      c.age += dt;
      fishApi.move(c.id, c.x, c.z, st.heading, true);
      if (dist > cfg.chaseLoseDist || c.age > cfg.chaseGiveUp) { // 追いつけない/追いきれない: あきらめる
        fishApi.release(c.id, 'keep');
        this.ignore[c.id] = this.time + cfg.lostCooldown;
        this.chasers.splice(i, 1);
        continue;
      }
      // ヒット判定: 追跡開始から実時間1秒ごとに30%(フレーム数に依存しない)
      var rolls = c.clock.advance(dt);
      for (var r = 0; r < rolls && hitId === null; r++) {
        if (this.rng() < cfg.hitChance) hitId = c.id;
      }
    }
    if (hitId !== null) this._onHit(hitId);
  };
  Controller.prototype._isChasing = function (id) {
    for (var i = 0; i < this.chasers.length; i++) if (this.chasers[i].id === id) return true;
    return false;
  };

  Controller.prototype._onHit = function (id) {
    var env = this.env, cfg = this.cfg, i;
    var hooked = null;
    for (i = 0; i < this.chasers.length; i++) if (this.chasers[i].id === id) { hooked = this.chasers[i]; break; }
    if (!hooked) return;
    var size = AI.rollFishSize(this.rng, cfg);
    var b = AI.bearingOf(this.hero, { x: this.lure.x, z: this.lure.z });
    this.hook = { id: id, size: size, fight: new AI.Fight(size, this.rng, cfg), d: Math.max(b.d, cfg.recoverDist + 1), alpha: b.alpha, resolved: false, x: this.lure.x, z: this.lure.z };
    var from = { x: this.lure.x, z: this.lure.z };
    // 1匹がヒットしたら、その釣りの間は周囲の魚を逃走状態にする(他の島の魚・魚影全体には触れない)
    for (i = 0; i < this.chasers.length; i++) {
      if (this.chasers[i].id !== id) this._startFlee(this.chasers[i], from);
    }
    this.chasers = [];
    var list = env.fish.list();
    for (i = 0; i < list.length; i++) {
      var fi = list[i];
      this.ignore[fi.id] = this.time + cfg.fledCooldown; // 遠くの魚も、しばらくルアーに反応しない
      if (Math.hypot(fi.x - from.x, fi.z - from.z) <= cfg.fleeRadius && env.fish.take(fi.id)) this._startFlee({ id: fi.id, x: fi.x, z: fi.z }, from);
    }
    this.ignore[id] = this.time + cfg.fledCooldown;
    this.globalCooldownUntil = this.time + cfg.fledCooldown;
    this._setMode('hit');
    try { env.toast('ヒット!', 900); } catch (e) { /* 表示だけ */ }
  };

  Controller.prototype._startFlee = function (c, from) {
    this.fleers.push({ id: c.id, x: c.x, z: c.z, fx: from.x, fz: from.z, t: 0, ang: this.rng() * Math.PI * 2 });
    this.ignore[c.id] = this.time + this.cfg.fledCooldown;
  };
  Controller.prototype._updateFleers = function (dt) {
    if (!this.fleers.length) return;
    var env = this.env, cfg = this.cfg;
    for (var i = this.fleers.length - 1; i >= 0; i--) {
      var f = this.fleers[i];
      f.t += dt;
      var st = AI.fleeStep(f, { x: f.fx, z: f.fz }, dt, cfg, f.ang);
      if (AI.isSeaPoint(env.coast(), st.x, st.z, env.waterOffset(), cfg)) { f.x = st.x; f.z = st.z; }
      env.fish.move(f.id, f.x, f.z, st.heading, true);
      if (f.t >= cfg.fleeTime) { env.fish.release(f.id, 'keep'); this.fleers.splice(i, 1); }
    }
  };

  /* ---------------- ファイト ---------------- */
  Controller.prototype._stepHit = function (dt) {
    this._placeHooked();
    if (this.modeT >= this.cfg.hitPoseTime) this._setMode('fighting');
  };

  Controller.prototype._placeHooked = function () {
    var hk = this.hook, env = this.env, f = hk.fight;
    var dNow = hk.d * (1 - this.cfg.pullInMax * f.progress);
    var base = AI.lureAt(this.hero, dNow, hk.alpha);
    var lat = f.run * f.runAmp();
    var px = base.x + this.hero.rx * lat, pz = base.z + this.hero.rz * lat;
    // 横に走った先が海でなければ、振れ幅を縮めて海の上に収める
    for (var i = 0; i < 6 && !AI.isSeaPoint(env.coast(), px, pz, env.waterOffset(), this.cfg); i++) {
      lat *= 0.5; px = base.x + this.hero.rx * lat; pz = base.z + this.hero.rz * lat;
    }
    if (!AI.isSeaPoint(env.coast(), px, pz, env.waterOffset(), this.cfg)) { px = hk.x; pz = hk.z; } // それでもだめなら前の位置
    hk.x = px; hk.z = pz;
    this.lure.x = px; this.lure.z = pz; this.lure.y = env.waterY(); this.lure.inWater = true;
    var heading = Math.atan2(-(this.hero.rz * f.dir), this.hero.rx * f.dir); // 魚影は +x が頭。走る向きへ向ける
    env.fish.move(hk.id, px, pz, heading, true);
  };

  Controller.prototype._stepFighting = function (dt) {
    var hk = this.hook;
    if (!hk) { this._toIdle(); return; }
    var res = hk.fight.update(dt);
    this._placeHooked();
    if (res === 'landed') this._onLanded();
    else if (res === 'escaped') this._onEscaped();
  };

  Controller.prototype._onLanded = function () {
    var hk = this.hook;
    if (!hk || hk.resolved) return; // 二重収納しない
    hk.resolved = true;
    this.env.fish.release(hk.id, 'remove'); // 釣り上げた魚影はフェードアウトして消える(魚影全体は消さない)
    this.lure.active = false; this.lure.inWater = false;
    this._resolveCatch(hk.size);
    this._setMode('landing');
  };

  Controller.prototype._onEscaped = function () {
    var hk = this.hook, env = this.env;
    if (!hk) return;
    hk.resolved = true;
    // 逃げた魚は、ルアーのそばから泳ぎ去る。インベントリには入らない
    this._startFlee({ id: hk.id, x: hk.x, z: hk.z }, { x: this.lure.x, z: this.lure.z });
    this.hook = null;
    this.lure.active = false; this.lure.inWater = false;
    this.globalCooldownUntil = this.time + this.cfg.escapeCooldown;
    try { env.toast('魚に逃げられた…', 1500); } catch (e) { /* 表示だけ */ }
    this._setMode('escaped');
  };

  /* ---------------- 釣った魚の収納 ---------------- */
  // 空きがあれば収納。満杯なら消さずに保持(pending)し、空きができたら自動で入れる/釣り画面で再試行できる。
  Controller.prototype._resolveCatch = function (size) {
    var env = this.env, inv = env.inventory;
    if (inv.canAddFish(size) && inv.addFish(size)) {
      try { env.toast('🐟 ' + size + 'cmの魚を釣った!', 2200); } catch (e) { /* 表示だけ */ }
      return true;
    }
    if (this.pending.length < this.cfg.maxPending) this.pending.push(size);
    try { env.toast('インベントリがいっぱいです(魚は保持中)', 2400); } catch (e) { /* 表示だけ */ }
    return false;
  };
  Controller.prototype._flushPending = function (quiet) {
    if (!this.pending.length) return 0;
    var inv = this.env.inventory, n = 0;
    while (this.pending.length > 0 && inv.canAddFish(this.pending[0])) {
      var s = this.pending[0];
      if (!inv.addFish(s)) break;
      this.pending.shift(); n++; // 入ったことを確かめてから取り除く(二重収納・消失を防ぐ)
    }
    if (n > 0 && !quiet) { try { this.env.toast('🐟 保持していた魚をインベントリに入れました', 2000); } catch (e) { /* 表示だけ */ } }
    return n;
  };
  Controller.prototype.retryPending = function () {
    var n = this._flushPending(true);
    if (this.pending.length > 0) { try { this.env.toast('インベントリがいっぱいです', 1500); } catch (e) { /* 表示だけ */ } }
    return n;
  };
  // 保持中の魚を、プレイヤーの操作で逃がす(自動では絶対に捨てない)
  Controller.prototype.releasePending = function () { var n = this.pending.length; this.pending = []; return n; };

  /* ---------------- セーブ / ロード ---------------- */
  Controller.prototype.getSaveData = function () {
    return { v: 1, castCount: this.castCount, pending: this.pending.slice() };
  };
  // data: セーブデータの fishing 項目(旧セーブには無い → 初期値)
  Controller.prototype.applySave = function (data) {
    var cc = 0, pend = [];
    if (data && typeof data === 'object') {
      var n = Number(data.castCount);
      if (isNum(n) && n > 0) cc = Math.min(1e9, Math.floor(n));
      if (Array.isArray(data.pending)) {
        for (var i = 0; i < data.pending.length && pend.length < this.cfg.maxPending; i++) {
          var s = AI.normalizeFishSize(Number(data.pending[i]), this.cfg);
          if (s !== null) pend.push(s);
        }
      }
    }
    this.castCount = cc;
    this.pending = pend;
  };

  /* ---------------- 画面用の情報 ---------------- */
  Controller.prototype._hint = function () {
    switch (this.mode) {
      case 'idle': return this.pending.length ? 'インベントリがいっぱいです(魚を保持中)' : '海の上をタップしてキャスト';
      case 'casting': return 'キャスト…';
      case 'flying': return 'キャスト…';
      case 'retrieving': return this.chasers.length ? '魚が追っている!' : '巻いています(左右タップで進路を少し変えられます)';
      case 'hit': return 'ヒット!';
      case 'fighting':
        return this.hook && this.hook.fight ? ('魚が' + (this.hook.fight.dir > 0 ? '右' : '左') + 'へ走る!竿を' + (this.hook.fight.dir > 0 ? '右' : '左') + 'へ') : '';
      case 'landing': return '釣り上げた!';
      case 'escaped': return '逃げられた…';
      default: return '';
    }
  };
  Controller.prototype.getView = function () {
    var hk = this.hook, f = hk && hk.fight;
    return {
      mode: this.mode,
      speedKey: this.speedKey,
      speeds: this.cfg.speeds,
      castCount: this.castCount,
      accuracyTiles: this.accuracyTiles(),
      hint: this._hint(),
      pending: this.pending.length,
      chasing: this.chasers.length,
      lure: { active: this.lure.active, inWater: this.lure.inWater, x: this.lure.x, y: this.lure.y, z: this.lure.z },
      fight: f ? { progress: f.progress, risk: f.risk, dir: f.dir, rodDir: f.rodDir, size: f.size, baseTime: f.baseTime, run: f.run } : null
    };
  };

  function create(env, opts) { return new Controller(env, opts); }

  var api = { create: create, Controller: Controller };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.FishingCore = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
