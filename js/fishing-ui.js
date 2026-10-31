/* =====================================================================
   js/fishing-ui.js — ルアーフィッシングの「画面・操作・ゲーム本編との接続」
   (ドラゴンハンター「ルアーフィッシングモード」)

   役割:
     ・js/fishing.js(釣りの流れ)に、本物の環境(勇者・島の海岸・魚影・インベントリ・アニメーション)を渡す。
     ・釣り専用の画面(全画面のタップ受け皿・やめるボタン・速度ボタン・ファイトの表示・確認ダイアログ)を作る。
       画面全体を覆う透明な受け皿(#fishingOverlay)が、釣り中のタップをすべて受け取るため、
       タップは既存のゲーム操作(移動・攻撃・採取・建築など)へ伝わらない。専用UI以外のボタンも押せない。
     ・釣り用のカメラ(勇者の後ろから海を見る。勇者の右=画面の右)、ルアー・糸・波紋の描画。
     ・終了時に、タイマー・リスナー・Three.jsオブジェクト・カメラ・勇者の向き・ポーズを元に戻す。
   game.html からは window.Fishing(下の窓口)だけを使う: isActive / update / stop / reset / getSaveData / applySave

   読み込み順: game.html 本編(player・camera・scene・playPose 等を定義するscript)より後。
   何か例外が起きたら釣りだけを止めて、ゲーム本編は止めない。
   ===================================================================== */
(function (root) {
  'use strict';
  var AI = root.FishingAI, Core = root.FishingCore;
  if (!AI || !Core) { console.error('釣り機能の読み込みに失敗しました(釣りなしで続行)'); return; }

  var CAM = { back: 6.5, up: 3.4, ahead: 5.5, lookY: 0.6, fov: 62, rate: 5 };
  var POSE_PREFIX = { ready: '釣り1', cast2: '釣り2', retrieve: '釣り3', hit: '釣り4', swingR: '釣り5', swingL: '釣り6', land: '釣り7' };

  /* ---------------- 釣り専用のCSS(釣り専用のID/classだけ) ---------------- */
  var CSS = [
    '#fishingOverlay{position:fixed;inset:0;z-index:18;display:none;touch-action:none;-webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent;}',
    '#fishingOverlay.on{display:block;}',
    '.fui{position:absolute;font-family:inherit;color:#fff;}',
    '.fuiBtn{min-width:44px;min-height:44px;border:1px solid rgba(255,255,255,0.55);border-radius:12px;background:rgba(20,40,70,0.78);color:#fff;font-size:14px;font-weight:bold;padding:6px 12px;-webkit-tap-highlight-color:transparent;}',
    '.fuiBtn:active{filter:brightness(1.35);}',
    '#fishingQuit{left:calc(10px + env(safe-area-inset-left,0px));bottom:calc(14px + env(safe-area-inset-bottom,0px));background:rgba(120,40,40,0.82);}',
    '#fishingSpeed{right:calc(6px + env(safe-area-inset-right,0px));top:50%;transform:translateY(-50%);display:flex;flex-direction:column;gap:6px;align-items:stretch;}',
    '#fishingSpeed .lbl{font-size:11px;text-align:center;text-shadow:1px 1px 2px #000;}',
    '#fishingSpeed .fuiBtn{min-width:56px;padding:6px 4px;}',
    '#fishingSpeed .fuiBtn.sel{background:#ffd34d;color:#3a2a00;border-color:#fff;}',
    '#fishingInfo{left:50%;transform:translateX(-50%);bottom:calc(76px + env(safe-area-inset-bottom,0px));max-width:min(88vw,420px);text-align:center;font-size:14px;font-weight:bold;text-shadow:1px 1px 3px #000;pointer-events:none;}',
    '#fishingInfo small{display:block;font-size:11px;font-weight:normal;opacity:0.85;}',
    '#fishingFight{left:50%;transform:translateX(-50%);bottom:calc(140px + env(safe-area-inset-bottom,0px));width:min(80vw,340px);display:none;pointer-events:none;text-align:center;}',
    '#fishingFight .arrow{font-size:26px;font-weight:bold;text-shadow:1px 1px 3px #000;margin-bottom:4px;}',
    '#fishingFight .row{display:flex;align-items:center;gap:6px;margin:3px 0;font-size:11px;text-shadow:1px 1px 2px #000;}',
    '#fishingFight .row b{width:46px;text-align:left;}',
    '#fishingFight .bar{flex:1;height:10px;border-radius:6px;background:rgba(0,0,0,0.55);overflow:hidden;border:1px solid rgba(255,255,255,0.4);}',
    '#fishingFight .bar i{display:block;height:100%;width:0;}',
    '#fishingProg{background:#5be37a;}#fishingRisk{background:#ff7a5a;}',
    '#fishingPending{left:50%;top:34%;transform:translateX(-50%);width:min(84vw,330px);display:none;padding:12px;border-radius:12px;background:rgba(0,0,0,0.78);border:1px solid rgba(255,255,255,0.5);text-align:center;font-size:14px;}',
    '#fishingPending .fuiBtn{margin:8px 4px 0;}',
    '#fishingConfirm{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(110px + env(safe-area-inset-bottom,0px));z-index:14;display:none;align-items:center;gap:10px;padding:10px 14px;border-radius:12px;background:rgba(0,0,0,0.78);border:1px solid rgba(255,255,255,0.5);color:#fff;font-size:15px;font-weight:bold;}',
    '#fishingConfirm.on{display:flex;}',
    '@media (max-height:460px){#fishingSpeed .fuiBtn{min-height:34px;}#fishingInfo{bottom:calc(60px + env(safe-area-inset-bottom,0px));}#fishingFight{bottom:calc(112px + env(safe-area-inset-bottom,0px));}}'
  ].join('\n');

  var ctrl = null, ui = null, vis = null, saved = null, camState = null;
  var lastT = 0, lastPos = null, confirmEl = null, startCoast = null, wOffCoast = null, wOffVal = 0, noAnimToastShown = false;
  var poseKeyCache = {};

  // 本編scriptのlet/const(player・camera など)を名前で読むための窓口。最初に1回だけ作り、毎回evalはしない。
  var G = null;
  function g(name) {
    if (!G) {
      try {
        G = (0, eval)('({player:function(){return player},playerModel:function(){return playerModel},camera:function(){return camera},scene:function(){return scene},' +
          'CONFIG:function(){return CONFIG},activeCoast:function(){return activeCoast},placementActive:function(){return placementActive},isBusy:function(){return isBusy},' +
          'isDodging:function(){return isDodging},isJumping:function(){return isJumping},playerDeadLock:function(){return playerDeadLock},enemies:function(){return enemies},' +
          'moveTarget:function(){return moveTarget},attackTarget:function(){return attackTarget},poseActions:function(){return poseActions},playPose:function(){return playPose},' +
          'POSE:function(){return POSE},showToast:function(){return showToast},moveMarker:function(){return moveMarker}})');
      } catch (e) { console.error('釣り: ゲーム本編の変数を読めません', e); G = {}; }
    }
    try { return G[name] ? G[name]() : undefined; } catch (e) { return undefined; }
  }
  function el(tag, id, cls, html) { var e = document.createElement(tag); if (id) e.id = id; if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; }

  /* ---------------- 環境(env) ---------------- */
  function heroInfo() {
    var p = g('player'); if (!p) return null;
    var off = g('CONFIG').characterForwardOffset || 0;
    return { x: p.position.x, y: p.position.y, z: p.position.z, fx: Math.sin(p.rotation.y - off), fz: Math.cos(p.rotation.y - off) };
  }
  function waterOffset() {
    var c = g('activeCoast');
    if (!c) return 0;
    if (c !== wOffCoast) {
      wOffCoast = c;
      try { wOffVal = (typeof Fish !== 'undefined') ? Fish.waterlineOffset() : 0; } catch (e) { wOffVal = 0; }
      if (!(wOffVal > 0)) { try { wOffVal = Fish.computeWaterlineOffset(c, root.IslandCoast.WATER_Y); } catch (e2) { wOffVal = 0; } }
    }
    return wOffVal;
  }
  function blockedByOtherUi() {
    var d = function (id) { var e = document.getElementById(id); return e && e.style.display && e.style.display !== 'none'; };
    var ls = document.getElementById('loadingScreen');
    if (ls && ls.style.display !== 'none') return true;
    if (d('modalBackdrop') || d('churchInteriorOverlay') || d('svOverlay')) return true;
    var mr = document.getElementById('maidReportOverlay');
    if (mr && getComputedStyle(mr).display !== 'none') return true;
    if (g('placementActive') || g('isBusy') || g('isDodging') || g('isJumping') || g('playerDeadLock')) return true;
    if (typeof Survival !== 'undefined' && Survival.isBusy()) return true;
    var pl = g('player'), en = g('enemies');
    if (pl && en) {
      for (var i = 0; i < en.length; i++) {
        var e = en[i];
        if (e && e.alive && e.mesh && e.mesh.visible !== false && Math.hypot(e.mesh.position.x - pl.position.x, e.mesh.position.z - pl.position.z) < 6) return true; // 近くに敵がいる間は誘わない
      }
    }
    return false;
  }
  function stationaryNow() {
    var p = g('player'); if (!p) return false;
    var moved = !lastPos || Math.hypot(p.position.x - lastPos.x, p.position.z - lastPos.z) > 0.02;
    lastPos = { x: p.position.x, z: p.position.z };
    // 立ち止まっているか = 位置が動いていないこと。海へ向かって歩こうとして岸で止まっている間(移動目標が残っている)も立ち止まりとみなす
    return !moved && !g('attackTarget');
  }
  function poseKey(name) {
    var pa = g('poseActions') || {};
    var pre = POSE_PREFIX[name];
    var c = poseKeyCache[name];
    if (c && pa[c]) return c;
    var ks = Object.keys(pa);
    for (var i = 0; i < ks.length; i++) if (ks[i].indexOf(pre) === 0) { poseKeyCache[name] = ks[i]; return ks[i]; }
    return null;
  }
  function hasFishingClips() { return !!poseKey('ready'); }

  // 竿の先(いま見えている竿の先端ノード)の世界座標
  var tipNodes = [];
  function collectTips() {
    tipNodes = [];
    var m = g('playerModel'); if (!m) return;
    m.traverse(function (o) { if (o.name === 'fishingRodTip') tipNodes.push(o); });
  }
  function rodTipPos() {
    if (!tipNodes.length) return null;
    var T = root.THREE, best = null, bs = 0.05, v = new T.Vector3(), w = new T.Vector3();
    for (var i = 0; i < tipNodes.length; i++) {
      var o = tipNodes[i];
      o.updateWorldMatrix(true, false);
      o.getWorldScale(w);
      if (w.length() > bs) { bs = w.length(); best = o; }
    }
    if (!best) return null;
    best.getWorldPosition(v);
    return { x: v.x, y: v.y, z: v.z };
  }

  function makeEnv() {
    return {
      nowMs: function () { return performance.now(); },
      hero: heroInfo,
      coast: function () { return g('activeCoast') || null; },
      waterOffset: waterOffset,
      waterY: function () { return root.IslandCoast ? root.IslandCoast.WATER_Y : 0.28; },
      rodTip: function () { try { return rodTipPos(); } catch (e) { return null; } },
      fishReady: function () { return typeof Fish !== 'undefined' && Fish.hasField(); },
      gateContext: function () { return { blocked: blockedByOtherUi() || ctrl.isActive(), stationary: stationaryNow() }; },
      fish: {
        list: function () { return Fish.listFish(); },
        take: function (id) { return Fish.takeFish(id); },
        move: function (id, x, z, h, s) { return Fish.moveFish(id, x, z, h, s); },
        release: function (id, mode) { return Fish.releaseFish(id, mode); }
      },
      inventory: {
        canAddFish: function (s) { return Inventory.canAddFish(s); },
        addFish: function (s) { return Inventory.addFish(s); }
      },
      pose: function (name, fade) { var k = poseKey(name); if (k) g('playPose')(k, fade); },
      toast: function (t, ms) { var f = g('showToast'); if (typeof f === 'function') f(t, ms || 1500); },
      fx: function (name, x, z) { if (vis) { vis.rippleT = 0; vis.rx = x; vis.rz = z; vis.ripBig = true; } },
      stillValid: function (hero) {
        var p = g('player');
        if (!p || g('playerDeadLock')) return false;
        if (Math.hypot(p.position.x - hero.x, p.position.z - hero.z) > 0.6) return false;
        return g('activeCoast') === startCoast;
      },
      showConfirm: function () { if (confirmEl) confirmEl.classList.add('on'); },
      hideConfirm: function () { if (confirmEl) confirmEl.classList.remove('on'); },
      enter: enterMode,
      leave: leaveMode
    };
  }

  /* ---------------- 入る / 出る ---------------- */
  function enterMode(hero) {
    var T = root.THREE, cam = g('camera'), scene = g('scene'), p = g('player');
    startCoast = g('activeCoast');
    saved = { rotY: p.rotation.y, fov: cam.fov };
    // 通常操作の隔離: 移動目標・攻撃ロック・入力をクリアし、勇者の位置と向きを固定する
    try { var mm = g('moveMarker'); if (mm) mm.visible = false; } catch (e) { /* 何もしない */ }
    (0, eval)('moveTarget = null; attackTarget = null; input.moveX = 0; input.moveZ = 0; input.justReleased = false; lastMoveSpeed = 0;');
    // Three.js の一時オブジェクト(釣りを終えるとき必ず破棄する。二重登録しない)
    if (vis) disposeVisuals();
    vis = { rippleT: 9, rx: 0, rz: 0, ripBig: false };
    vis.lure = new T.Mesh(new T.SphereGeometry(0.13, 12, 8), new T.MeshBasicMaterial({ color: 0xff7a2e }));
    vis.lure.visible = false; vis.lure.frustumCulled = false;
    var N = 14, pos = new Float32Array(N * 3);
    var lg = new T.BufferGeometry(); lg.setAttribute('position', new T.BufferAttribute(pos, 3));
    vis.line = new T.Line(lg, new T.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 }));
    vis.line.frustumCulled = false; vis.line.visible = false; vis.lineN = N;
    var rg = new T.RingGeometry(0.25, 0.32, 28); rg.rotateX(-Math.PI / 2);
    vis.ring = new T.Mesh(rg, new T.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6, depthWrite: false, side: T.DoubleSide }));
    vis.ring.visible = false; vis.ring.frustumCulled = false;
    scene.add(vis.lure); scene.add(vis.line); scene.add(vis.ring);
    // 釣り用カメラ(勇者の後ろから海を見る): いまのカメラから滑らかに移る
    var look0 = new T.Vector3(p.position.x, p.position.y + 1.2, p.position.z);
    camState = { pos: cam.position.clone(), look: look0, fov: cam.fov, hero: hero, blendOut: 0 };
    collectTips();
    ui.overlay.classList.add('on');
    updateSpeedButtons();
    if (!hasFishingClips() && !noAnimToastShown) {
      noAnimToastShown = true;
      var ts = g('showToast');
      if (typeof ts === 'function') ts('このモデルには釣りアニメがありません(3dmaker_save.glb を選ぶと竿を構えます)', 3600);
    }
  }

  function leaveMode(why) {
    var cam = g('camera'), p = g('player');
    try { if (ui) ui.overlay.classList.remove('on'); } catch (e) { /* 何もしない */ }
    try { disposeVisuals(); } catch (e) { console.error('釣り用オブジェクトの破棄でエラー(続行):', e); }
    try {
      if (p && saved) p.rotation.y = saved.rotY;         // 勇者の向きを元に戻す(位置は固定していたので変わっていない)
      var pl = g('playPose'), POSE = g('POSE');
      if (typeof pl === 'function' && POSE) pl(POSE.IDLE, 0.25); // 通常の待機ポーズへ
    } catch (e) { console.error('釣り終了: 勇者の復元でエラー(続行):', e); }
    try {
      if (camState) { camState.blendOut = 0.5; camState.hero = null; } // カメラは0.5秒かけて元の見下ろしへ戻る
      else if (cam && saved) { cam.fov = saved.fov; cam.updateProjectionMatrix(); }
    } catch (e) { /* 何もしない */ }
    try {
      (0, eval)('moveTarget = null; attackTarget = null; input.moveX = 0; input.moveZ = 0; input.justReleased = false;'); // 通常操作へ確実に復帰
    } catch (e) { /* 何もしない */ }
    if (why === 'moved' || why === 'error') { var ts = g('showToast'); if (typeof ts === 'function') ts('釣りを終了しました', 1600); }
  }

  function disposeVisuals() {
    if (!vis) return;
    var scene = g('scene');
    ['lure', 'line', 'ring'].forEach(function (k) {
      var o = vis[k]; if (!o) return;
      if (scene) scene.remove(o);
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    vis = null;
  }

  /* ---------------- 毎フレームの描画(ルアー・糸・波紋・カメラ) ---------------- */
  function updateVisuals(dt, view) {
    if (!vis) return;
    var lu = view.lure, pos = vis.line.geometry.attributes.position, N = vis.lineN, i;
    vis.lure.visible = !!lu.active;
    if (lu.active) {
      vis.lure.position.set(lu.x, lu.y + 0.08, lu.z);
      var tip = rodTipPos(), hero = camState && camState.hero;
      if (!tip && hero) tip = { x: hero.x + hero.fx * 0.6, y: hero.y + 1.6, z: hero.z + hero.fz * 0.6 };
      if (tip) {
        var mx = (tip.x + lu.x) / 2, mz = (tip.z + lu.z) / 2, dist = Math.hypot(lu.x - tip.x, lu.z - tip.z);
        var sag = lu.inWater ? Math.min(0.7, 0.04 * dist) : 0.1, my = (tip.y + lu.y) / 2 - sag;
        for (i = 0; i < N; i++) {
          var t = i / (N - 1), a = (1 - t) * (1 - t), b = 2 * (1 - t) * t, c = t * t;
          pos.setXYZ(i, a * tip.x + b * mx + c * lu.x, a * tip.y + b * my + c * (lu.y + 0.08), a * tip.z + b * mz + c * lu.z);
        }
        pos.needsUpdate = true; vis.line.visible = true;
      } else vis.line.visible = false;
    } else vis.line.visible = false;
    // 波紋: 着水の瞬間は大きく1回、巻いている間・ファイト中はルアーの位置で小さく繰り返す
    var showRing = false, sc = 1, op = 0;
    if (vis.rippleT < 1.0 && vis.ripBig) { vis.rippleT += dt; var u = vis.rippleT; showRing = true; sc = 1 + u * 4; op = 0.7 * (1 - u); vis.ring.position.set(vis.rx, view.lure.y + 0.04, vis.rz); }
    else if (lu.active && lu.inWater && (view.mode === 'retrieving' || view.mode === 'hit' || view.mode === 'fighting')) {
      vis.rippleT += dt; var ph = (vis.rippleT % 0.9) / 0.9; showRing = true; vis.ripBig = false;
      sc = 0.6 + ph * 1.6; op = 0.5 * (1 - ph); vis.ring.position.set(lu.x, lu.y + 0.04, lu.z);
    } else { vis.ripBig = false; if (vis.rippleT > 1.0) vis.rippleT = 9; }
    vis.ring.visible = showRing;
    if (showRing) { vis.ring.scale.set(sc, 1, sc); vis.ring.material.opacity = Math.max(0, op); }
  }

  function updateCameraFishing(dt) {
    if (!camState) return;
    var T = root.THREE, cam = g('camera'), h = camState.hero, dpos, dlook, dfov;
    var k = 1 - Math.exp(-(h ? CAM.rate : 9) * dt); // 終了後の戻りは少し速く(0.5秒でほぼ元の位置)
    if (h) {
      dpos = new T.Vector3(h.x - h.fx * CAM.back, h.y + CAM.up, h.z - h.fz * CAM.back);
      dlook = new T.Vector3(h.x + h.fx * CAM.ahead, h.y + CAM.lookY, h.z + h.fz * CAM.ahead);
      dfov = CAM.fov;
    } else { // 終了後: 通常の見下ろしカメラへ戻る(通常の位置は updateCamera() と同じ式)
      var p = g('player'), C = g('CONFIG');
      if (!p || !saved) { camState = null; return; }
      dpos = new T.Vector3(p.position.x, p.position.y + C.cameraHeight, p.position.z + C.cameraDist);
      dlook = new T.Vector3(p.position.x, p.position.y + 1.2, p.position.z);
      dfov = saved.fov;
      camState.blendOut -= dt;
      if (camState.blendOut <= 0) { cam.fov = saved.fov; cam.updateProjectionMatrix(); camState = null; return; }
    }
    camState.pos.lerp(dpos, k); camState.look.lerp(dlook, k);
    camState.fov += (dfov - camState.fov) * k;
    cam.position.copy(camState.pos); cam.lookAt(camState.look);
    if (Math.abs(cam.fov - camState.fov) > 0.01) { cam.fov = camState.fov; cam.updateProjectionMatrix(); }
  }

  /* ---------------- 画面(DOM)の組み立て ---------------- */
  function buildUi() {
    var st = document.createElement('style'); st.id = 'fishingStyle'; st.textContent = CSS; document.head.appendChild(st);
    var ov = el('div', 'fishingOverlay');
    var quit = el('button', 'fishingQuit', 'fui fuiBtn', '🎣 釣りをやめる');
    var speed = el('div', 'fishingSpeed', 'fui', '<div class="lbl">速度</div>');
    var sBtns = {};
    AI.CONFIG.speeds.forEach(function (s) {
      var b = el('button', null, 'fuiBtn', s.label); b.setAttribute('data-speed', s.key); speed.appendChild(b); sBtns[s.key] = b;
    });
    var info = el('div', 'fishingInfo', 'fui', '');
    var fight = el('div', 'fishingFight', 'fui',
      '<div class="arrow" id="fishingArrow"></div>' +
      '<div class="row"><b>釣り上げ</b><div class="bar"><i id="fishingProg"></i></div></div>' +
      '<div class="row"><b>逃げそう</b><div class="bar"><i id="fishingRisk"></i></div></div>');
    var pend = el('div', 'fishingPending', 'fui',
      '<div>インベントリがいっぱいです<br><small>釣った魚は保持しています</small></div>' +
      '<button class="fuiBtn" id="fishingRetry">もう一度入れる</button><button class="fuiBtn" id="fishingDrop">魚を逃がす</button>');
    [quit, speed, info, fight, pend].forEach(function (e) { ov.appendChild(e); });
    document.body.appendChild(ov);
    confirmEl = el('div', 'fishingConfirm', null,
      '<span>🎣 釣りをしますか？</span><button class="fuiBtn" id="fishingYes">はい</button><button class="fuiBtn" id="fishingNo">いいえ</button>');
    document.body.appendChild(confirmEl);
    ui = {
      overlay: ov, quit: quit, speed: speed, sBtns: sBtns, info: info, fight: fight, pend: pend,
      arrow: fight.querySelector('#fishingArrow'), prog: fight.querySelector('#fishingProg'), risk: fight.querySelector('#fishingRisk'),
      last: {}
    };
    // 釣り専用のイベント(ここだけ。ゲーム本編のリスナーには触れない)
    ov.addEventListener('pointerdown', onOverlayPointer);
    // 受け皿の上のタッチはブラウザの既定動作(拡大・スクロール)をさせない。ボタンの上は止めない(止めるとclickが来ないため)
    var onUiBtn = function (e) { return !!(e.target.closest && e.target.closest('.fuiBtn, #fishingSpeed, #fishingPending')); };
    ov.addEventListener('touchstart', function (e) { if (!onUiBtn(e)) e.preventDefault(); }, { passive: false });
    ov.addEventListener('touchmove', function (e) { if (!onUiBtn(e)) e.preventDefault(); }, { passive: false });
    quit.addEventListener('click', function (e) { e.stopPropagation(); ctrl.stop('user'); });
    speed.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('[data-speed]'); e.stopPropagation();
      if (b && ctrl.setSpeed(b.getAttribute('data-speed'))) updateSpeedButtons();
    });
    pend.querySelector('#fishingRetry').addEventListener('click', function (e) { e.stopPropagation(); ctrl.retryPending(); });
    pend.querySelector('#fishingDrop').addEventListener('click', function (e) { e.stopPropagation(); ctrl.releasePending(); });
    confirmEl.querySelector('#fishingYes').addEventListener('click', function (e) { e.stopPropagation(); ctrl.answerYes(); });
    confirmEl.querySelector('#fishingNo').addEventListener('click', function (e) { e.stopPropagation(); ctrl.answerNo(); });
    confirmEl.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
  }

  function updateSpeedButtons() {
    var v = ctrl.getView();
    AI.CONFIG.speeds.forEach(function (s) { ui.sBtns[s.key].classList.toggle('sel', s.key === v.speedKey); });
  }

  /* ---------------- タップ ---------------- */
  // 画面上の勇者の左右で、竿を引く向きを決める。海の上をタップしたときはキャストの目標地点にもなる。
  function onOverlayPointer(e) {
    if (e.target.closest && e.target.closest('.fuiBtn, #fishingSpeed, #fishingPending')) return; // ボタン・専用パネルの上は、そのUIが処理する
    e.preventDefault(); e.stopPropagation();
    try {
      var T = root.THREE, cam = g('camera'), h = heroInfo();
      if (!h) return;
      cam.updateMatrixWorld();
      var hv = new T.Vector3(h.x, h.y + 1.0, h.z).project(cam);
      var heroSX = (hv.x * 0.5 + 0.5) * window.innerWidth;
      var side = e.clientX < heroSX ? -1 : 1;
      var ndc = new T.Vector2((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
      var rc = new T.Raycaster(); rc.setFromCamera(ndc, cam);
      var plane = new T.Plane(new T.Vector3(0, 1, 0), -(root.IslandCoast ? root.IslandCoast.WATER_Y : 0.28));
      var out = new T.Vector3(), target = rc.ray.intersectPlane(plane, out) ? { x: out.x, z: out.z } : null;
      ctrl.onTap({ side: side, target: target });
    } catch (err) {
      console.error('釣りのタップ処理でエラー(釣りを終了します):', err);
      ctrl.stop('error');
    }
  }

  /* ---------------- 画面の更新 ---------------- */
  function setText(key, node, html) { if (ui.last[key] !== html) { ui.last[key] = html; node.innerHTML = html; } }
  function updateUi(view) {
    var acc = '精度 ±' + view.accuracyTiles + 'マス ・ キャスト ' + view.castCount + '回';
    setText('info', ui.info, view.hint + '<small>' + acc + '</small>');
    var f = view.fight, show = !!f && (view.mode === 'hit' || view.mode === 'fighting');
    if (ui.last.fightShow !== show) { ui.last.fightShow = show; ui.fight.style.display = show ? 'block' : 'none'; }
    if (show) {
      var arrow = f.dir > 0 ? '▶▶ 右へ!' : '◀◀ 左へ!';
      if (ui.last.arrow !== arrow) { ui.last.arrow = arrow; ui.arrow.textContent = arrow; }
      ui.prog.style.width = Math.round(f.progress * 100) + '%';
      ui.risk.style.width = Math.round(f.risk * 100) + '%';
    }
    var ps = view.pending > 0;
    if (ui.last.pend !== ps) { ui.last.pend = ps; ui.pend.style.display = ps ? 'block' : 'none'; }
    if (ui.last.speed !== view.speedKey) { ui.last.speed = view.speedKey; updateSpeedButtons(); }
  }

  /* ---------------- 窓口(game.html から使う) ---------------- */
  function init() {
    try {
      ctrl = Core.create(makeEnv());
      buildUi();
    } catch (e) {
      console.error('釣り機能を準備できませんでした(釣りなしで続行):', e);
      return null;
    }
    return {
      isActive: function () { return !!ctrl && ctrl.isActive(); },
      update: function (loopDt) {
        try {
          var now = performance.now(), dt = lastT ? Math.min(0.25, (now - lastT) / 1000) : 0; // 実時間(ループの補正とは別に測る)
          lastT = now;
          if (!(dt > 0)) return;
          ctrl.update(dt);
          if (ctrl.isActive()) {
            var v = ctrl.getView();
            updateCameraFishing(dt);
            updateVisuals(dt, v);
            updateUi(v);
          } else if (camState) updateCameraFishing(dt);
        } catch (e) {
          console.error('釣りの更新でエラー(釣りだけを止めます):', e);
          try { ctrl.stop('error'); } catch (e2) { /* 何もしない */ }
        }
      },
      stop: function (why) { try { ctrl.stop(why); } catch (e) { console.error(e); } },
      reset: function (why) { try { ctrl.reset(why); } catch (e) { console.error(e); } },
      getSaveData: function () { return ctrl.getSaveData(); },
      applySave: function (d) { ctrl.applySave(d); },
      controller: ctrl
    };
  }

  var facade = init();
  if (facade) root.Fishing = facade;
})(typeof window !== 'undefined' ? window : this);
