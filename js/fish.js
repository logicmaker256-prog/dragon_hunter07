/* =====================================================================
   js/fish.js  — 海の魚(魚影だけが見える)。将来の「釣り」の下地(第5段階・魚の追加)

   役割(これだけ):
     岸から5マス以内の海に、「魚影」(海面に映る暗い魚のシルエット)を出す。
       ・魚の本体は描かない(魚影だけ)。位置は論理データ(この島の魚リスト)として持つ。
       ・密度: 条件を満たす海のマスの 5%(CONFIG.density)に魚が1匹ずつ。1マスに2匹は入らない。
       ・5秒ごと(CONFIG.moveInterval)に、隣の8マスのどれかへランダムに1マス泳ぐ。
       ・移動先が「岸から5マスを超える」または「画面外」なら、その魚は消え(フェードアウト)、
         岸から5マス以内の画面内の別のマスに新しく現れる(フェードイン)。
     ※ 見た目だけの機能。通行判定・セーブ・敵・メイド・領民・農地・牧場・時間・経済には一切関与しない。
        セーブもしない(島に入るたび・ロードするたびに作り直す)。

   「岸」の決め方:
     見た目の水際(地面の高さが海面と同じになる所)を岸とする。島の海岸線(通行不可の海の始まり)より
     少し沖側にある。マスの中心から水際までの距離が 0.5〜5.0 のマスだけを魚のいられる場所にする
     (水際すれすれは地面が海面から顔を出すので、魚影が地面に隠れないよう 0.5 だけ離す)。

   画面外の決め方:
     カメラの視錐台に入っているマスだけを「画面内」とする(ブラウザ側の接続部分で判定)。
     スポーン判定より、消える判定の余白を広めに取り、画面の縁でちらつかないようにしている。

   作りの安全:
     ・乱数は見た目専用(Math.random)。島のSeed・木や岩の乱数列には触れない。
     ・何か例外が起きたら魚の機能だけを止めて、ゲーム本編は止めない。
     ・Three.js・DOM に触れるのは update() の中だけ。魚の動きのルール(FishField)は純粋な関数群で、
       Node.js からそのまま試験できる。

   将来の釣り: Fish.nearestFish(x, z, maxDist) で「この座標の近くにいる魚」を調べられる。
   釣り機能(js/fishing.js): Fish.listFish / takeFish / moveFish / releaseFish で魚を「借りて動かす」(魚影データは壊さない)。
   ===================================================================== */
(function (root) {
  'use strict';

  var CONFIG = {
    density: 0.05,        // 条件を満たす(画面内の)海のマスのうち、魚がいる割合
    minShoreDist: 0.5,    // 水際から、マスの中心までの最小距離(魚影が地面に隠れないため)
    maxShoreDist: 5.0,    // 水際から、マスの中心までの最大距離(=「岸から5マス」)
    moveInterval: 5.0,    // 魚が1マス動く間隔(秒)
    glideTime: 1.6,       // 1マス動くのにかける時間(秒。なめらかに滑る)
    fadeTime: 0.6,        // 現れる/消えるときのフェード(秒)
    areaRadius: 28,       // 勇者からこの距離より遠いマスは扱わない
    spawnMargin: 0.8,     // 画面内判定(出現)の余白(球の半径)
    keepMargin: 3.0,      // 画面外判定(消滅)の余白。出現より広くして、縁でちらつかせない
    rescanInterval: 0.25, // 画面内の候補マスを調べ直す間隔(秒)
    burstLimit: 6,        // 通常時、1回の調べ直しで新しく出す魚の最大数(いきなり大量に出ない)
    maxFish: 160,         // 描画できる魚の最大数(安全のための上限)
    sizeMin: 0.75, sizeMax: 1.1, // 魚影の大きさの幅(1マス=1.0)
    shadowColor: 0x06233f, shadowOpacity: 0.5, // 魚影の色と濃さ
    yOffset: 0.03         // 海面からの高さ
  };

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function smooth01(t) { t = t < 0 ? 0 : (t > 1 ? 1 : t); return t * t * (3 - 2 * t); }
  function cellKey(i, j) { return (i + 1024) * 4096 + (j + 1024); }

  // 水際(地面の高さ=海面になる所)の、海岸線(signed=0)からの沖側の距離を、海岸の高さ関数から求める。
  // 見つからなければ 0。海岸の高さは海では signed だけで決まる(blendHeight の海の分岐)ので、
  // 角度0の半直線上の点で調べれば全周に通用する。
  function computeWaterlineOffset(coast, waterY) {
    var r0 = coast.radiusAt(0);
    function h(d) { return coast.blendHeight(0, r0 + d, 0, 0.5); }
    if (!(h(0) > waterY)) return 0;      // 海岸線ですでに海面以下
    var lo = 0, hi = 6;
    if (h(hi) > waterY) return hi;       // (想定外)6まで行っても海面より高い
    for (var k = 0; k < 40; k++) {
      var mid = (lo + hi) / 2;
      if (h(mid) > waterY) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }

  /* =================================================================
     魚の動きのルール(純粋ロジック)
       coast : IslandCoast.create() の戻り値(signed / blendHeight / radiusAt を使う)
       opts  : { waterY, rng, isVisible(x,z,radius) }
     ================================================================= */
  function FishField(coast, opts) {
    opts = opts || {};
    this.coast = coast;
    this.waterY = isNum(opts.waterY) ? opts.waterY : 0.28;
    this.rng = typeof opts.rng === 'function' ? opts.rng : Math.random;
    this.isVisible = typeof opts.isVisible === 'function' ? opts.isVisible : function () { return true; };
    this.waterOffset = computeWaterlineOffset(coast, this.waterY);
    this.fish = [];
    this.occ = Object.create(null);   // cellKey -> fish(移動中は出発マスと到着マスの両方に入る)
    this.eligCache = new Map();
    this.cands = [];                  // 直近の調べ直しで見つかった「画面内で魚がいられる」マス [{i,j}]
    this.visSet = Object.create(null);
    this.target = 0;
    this.px = 0; this.pz = 0;
    this.rescanT = 0;
    this.dirty = true;                // 最初の update で必ず調べ直し、一気に埋める
    this.nextId = 1;
  }

  // マス(i,j)は、魚がいてよい海のマスか(中心で判定)
  FishField.prototype.cellEligible = function (i, j) {
    var key = cellKey(i, j), c = this.eligCache.get(key);
    if (c !== undefined) return c;
    var cx = i + 0.5, cz = j + 0.5, ok = false;
    var s = this.coast.signed(cx, cz);
    if (s < 0) {                               // 海(海岸線の沖側)
      var d = -s - this.waterOffset;           // 水際からの距離
      if (d >= CONFIG.minShoreDist && d <= CONFIG.maxShoreDist) {
        var g = this.coast.blendHeight(0, cx, cz, 0.5);
        ok = g <= this.waterY - 0.06;          // 念のため: 地面が海面より十分低いマスだけ
      }
    }
    this.eligCache.set(key, ok);
    return ok;
  };

  FishField.prototype.withinKeep = function (x, z) {
    var dx = x - this.px, dz = z - this.pz, R = CONFIG.areaRadius + 3;
    if (dx * dx + dz * dz > R * R) return false;
    return !!this.isVisible(x, z, CONFIG.keepMargin);
  };

  // 画面内で魚がいられるマスを集め直し、魚の目標数を決める
  FishField.prototype.rescan = function () {
    var R = CONFIG.areaRadius, px = this.px, pz = this.pz;
    this.cands = []; this.visSet = Object.create(null);
    var sp = this.coast.signed(px, pz);
    // 勇者が海岸から遠い内陸にいるときは、候補なし(走査も省く)
    if (!(sp > R + CONFIG.maxShoreDist + this.waterOffset + 2)) {
      var i0 = Math.floor(px - R), i1 = Math.floor(px + R), j0 = Math.floor(pz - R), j1 = Math.floor(pz + R);
      for (var i = i0; i <= i1; i++) {
        for (var j = j0; j <= j1; j++) {
          var cx = i + 0.5, cz = j + 0.5, dx = cx - px, dz = cz - pz;
          if (dx * dx + dz * dz > R * R) continue;
          if (!this.cellEligible(i, j)) continue;
          if (!this.isVisible(cx, cz, CONFIG.spawnMargin)) continue;
          this.cands.push({ i: i, j: j });
          this.visSet[cellKey(i, j)] = true;
        }
      }
    }
    this.target = Math.round(CONFIG.density * this.cands.length);
    // 画面外に出た魚は消す(フェードアウト)
    for (var k = 0; k < this.fish.length; k++) {
      var f = this.fish[k];
      if (f.state !== 'out' && !f.ext && !this.withinKeep(f.x, f.z)) f.state = 'out'; // ext=釣り機能が操作中の魚は画面外でも消さない
    }
    this.topUp(this.dirty ? Infinity : CONFIG.burstLimit);
    this.dirty = false;
  };

  FishField.prototype.countVisibleFish = function () {
    var n = 0;
    for (var k = 0; k < this.fish.length; k++) {
      var f = this.fish[k];
      if (f.state !== 'out' && !f.ext && this.visSet[cellKey(f.ci, f.cj)]) n++;
    }
    return n;
  };

  // 目標数に足りない分を、画面内の空いている海のマスに出す
  FishField.prototype.topUp = function (limit) {
    var need = this.target - this.countVisibleFish(), made = 0;
    while (need > 0 && made < limit && this.fish.length < CONFIG.maxFish) {
      if (!this.spawnOne()) break;
      need--; made++;
    }
    return made;
  };

  FishField.prototype.spawnOne = function () {
    var n = this.cands.length;
    if (!n) return false;
    for (var t = 0; t < 16; t++) {
      var c = this.cands[Math.floor(this.rng() * n) % n];
      var key = cellKey(c.i, c.j);
      if (this.occ[key]) continue;
      var f = {
        id: this.nextId++, ci: c.i, cj: c.j, x: c.i + 0.5, z: c.j + 0.5,
        fromX: 0, fromZ: 0, toX: 0, toZ: 0, ti: c.i, tj: c.j,
        gliding: false, glideT: 0,
        moveTimer: 0.5 + this.rng() * (CONFIG.moveInterval - 0.5), // 最初の動きは魚ごとにずらす
        heading: this.rng() * Math.PI * 2,
        size: CONFIG.sizeMin + this.rng() * (CONFIG.sizeMax - CONFIG.sizeMin),
        scale: 0, state: 'in'
      };
      this.fish.push(f);
      this.occ[key] = f;
      return true;
    }
    return false;
  };

  // 5秒に1回の移動。移動先が岸から5マスを超える/画面外なら、その魚は消えて別の場所に新しく出る。
  FishField.prototype.tryMove = function (f) {
    var DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
    for (var k = 0; k < 4; k++) {
      var d = DIRS[Math.floor(this.rng() * DIRS.length) % DIRS.length];
      var ti = f.ci + d[0], tj = f.cj + d[1], tx = ti + 0.5, tz = tj + 0.5;
      if (!this.cellEligible(ti, tj) || !this.withinKeep(tx, tz)) {
        f.state = 'out';       // 帯の外・画面外へ出る → 消える
        this.topUp(1);         // 岸から5マス以内の画面内に、新しく1匹出す
        return;
      }
      var key = cellKey(ti, tj);
      if (this.occ[key]) continue; // 先客がいる → 別の向きを試す
      if (d[0] !== 0 && d[1] !== 0) { // 斜め移動: 逆向きの斜めに泳ぐ魚と、真ん中で重ならないようにする
        var sa = this.occ[cellKey(f.ci + d[0], f.cj)], sb = this.occ[cellKey(f.ci, f.cj + d[1])];
        if ((sa && sa.gliding) || (sb && sb.gliding)) continue;
      }
      f.ti = ti; f.tj = tj;
      f.fromX = f.x; f.fromZ = f.z; f.toX = tx; f.toZ = tz;
      f.heading = Math.atan2(-d[1], d[0]); // 魚影は +x が頭。進む向きへ回す
      f.gliding = true; f.glideT = 0;
      this.occ[key] = f;                   // 到着マスを予約(出発マスも到着までは占有のまま)
      return;
    }
    // 空きが見つからなければ、今回は動かない
  };

  FishField.prototype.advance = function (f, dt) {
    if (f.state === 'in') {
      f.scale += dt / CONFIG.fadeTime;
      if (f.scale >= 1) { f.scale = 1; f.state = 'alive'; }
    } else if (f.state === 'out') {
      f.scale -= dt / CONFIG.fadeTime;
      if (f.scale < 0) f.scale = 0;
    }
    if (f.ext) return; // 釣り機能が操作中の魚: 自分では泳がない(位置は moveControlled で決まる)
    if (f.gliding) {
      f.glideT += dt / CONFIG.glideTime;
      if (f.glideT >= 1) {
        delete this.occ[cellKey(f.ci, f.cj)];
        f.ci = f.ti; f.cj = f.tj; f.x = f.toX; f.z = f.toZ;
        f.gliding = false; f.glideT = 0;
      } else {
        var e = smooth01(f.glideT);
        f.x = f.fromX + (f.toX - f.fromX) * e;
        f.z = f.fromZ + (f.toZ - f.fromZ) * e;
      }
    }
    if (f.state !== 'out') {
      f.moveTimer -= dt; // 泳いでいる間も数える(動き出しの間隔を、ちょうど moveInterval 秒にするため)
      if (f.moveTimer <= 0 && !f.gliding) {
        f.moveTimer += CONFIG.moveInterval;
        this.tryMove(f);
      }
    }
  };

  FishField.prototype.update = function (dt, px, pz) {
    if (!isNum(dt) || dt <= 0) dt = 0;
    this.px = px; this.pz = pz;
    this.rescanT -= dt;
    if (this.dirty || this.rescanT <= 0) { this.rescanT = CONFIG.rescanInterval; this.rescan(); }
    var alive = [];
    for (var k = 0; k < this.fish.length; k++) {
      var f = this.fish[k];
      this.advance(f, dt);
      if (f.state === 'out' && f.scale <= 0 && !f.gliding) { // 消え終わった魚を片づける
        this.freeCell(cellKey(f.ci, f.cj), f);
      } else if (f.state === 'out' && f.scale <= 0) {         // 移動中に消え終わった: 両方のマスを空ける
        this.freeCell(cellKey(f.ci, f.cj), f); this.freeCell(cellKey(f.ti, f.tj), f);
      } else alive.push(f);
    }
    this.fish = alive;
  };

  // マスの占有を、その魚自身のものであるときだけ空ける(釣り機能が操作した魚が、他の魚の占有を消さないため)
  FishField.prototype.freeCell = function (key, f) { if (this.occ[key] === f) delete this.occ[key]; };

  /* -----------------------------------------------------------------
     釣り機能(js/fishing.js)との連携口。魚影の見た目用データは壊さず、「借りて動かす」だけにする。
       listFree()                    … 借りられる魚(消えかけ・すでに借りられている魚は除く)の読み取り専用の写し
       takeControl(id)               … その魚を借りる(自分では泳がなくなる。画面外でも消えない)
       moveControlled(id,x,z,h,swim) … 借りている魚の位置・向きを決める
       releaseControl(id, mode)      … 返す。'keep'=その場で通常の魚へ戻す(帯の外・先客ありならフェードアウトして
                                        別の場所に新しく出る) / 'remove'=フェードアウトして消す(釣り上げた魚)
     何も借りなければ、従来の動きとまったく同じ。
     ----------------------------------------------------------------- */
  FishField.prototype.findFish = function (id) {
    for (var k = 0; k < this.fish.length; k++) if (this.fish[k].id === id) return this.fish[k];
    return null;
  };
  FishField.prototype.listFree = function () {
    var out = [];
    for (var k = 0; k < this.fish.length; k++) {
      var f = this.fish[k];
      if (f.ext || f.state === 'out' || f.scale < 0.5) continue;
      out.push({ id: f.id, x: f.x, z: f.z });
    }
    return out;
  };
  FishField.prototype.takeControl = function (id) {
    var f = this.findFish(id);
    if (!f || f.ext || f.state === 'out') return false;
    this.freeCell(cellKey(f.ci, f.cj), f); this.freeCell(cellKey(f.ti, f.tj), f);
    f.gliding = false; f.glideT = 0; f.ext = true; f.swimming = false;
    return true;
  };
  FishField.prototype.moveControlled = function (id, x, z, heading, swimming) {
    var f = this.findFish(id);
    if (!f || !f.ext) return false;
    if (isNum(x) && isNum(z)) { f.x = x; f.z = z; }
    if (isNum(heading)) f.heading = heading;
    f.swimming = !!swimming;
    return true;
  };
  FishField.prototype.releaseControl = function (id, mode) {
    var f = this.findFish(id);
    if (!f || !f.ext) return false;
    f.ext = false; f.swimming = false;
    if (mode === 'remove') { f.state = 'out'; return true; }
    var ci = Math.floor(f.x), cj = Math.floor(f.z), key = cellKey(ci, cj);
    if (this.cellEligible(ci, cj) && this.withinKeep(f.x, f.z) && !this.occ[key]) {
      f.ci = ci; f.cj = cj; f.ti = ci; f.tj = cj; this.occ[key] = f;
      f.moveTimer = 0.5 + this.rng() * (CONFIG.moveInterval - 0.5);
    } else {
      f.state = 'out'; // 帯の外・画面外・先客あり: フェードアウトして、別の場所に新しく出る
    }
    return true;
  };

  // 将来の釣り用: この座標の近くにいる(消えかけでない)魚のうち一番近いもの。いなければ null
  FishField.prototype.nearestFish = function (x, z, maxDist) {
    var best = null, bd = isNum(maxDist) ? maxDist : Infinity;
    for (var k = 0; k < this.fish.length; k++) {
      var f = this.fish[k];
      if (f.state === 'out' || f.ext || f.scale < 0.5) continue;
      var d = Math.hypot(f.x - x, f.z - z);
      if (d <= bd) { bd = d; best = { id: f.id, x: f.x, z: f.z, dist: d }; }
    }
    return best;
  };

  /* =================================================================
     ブラウザ側の接続部分(Three.js で魚影を描く)。ここだけが THREE に触れる。
       Fish.setCoast(coast)                  … 島(海岸線)が変わったときに game.html から呼ぶ
       Fish.update(dt, px, pz, camera, scene) … 毎フレーム game.html のメインループから呼ぶ
     ================================================================= */
  var field = null, fieldCoast = null, disabled = false;
  var render = null; // { THREE, scene, mesh, dummy, frustum, mat4, sphere }

  function waterYValue() {
    return (root && root.IslandCoast && isNum(root.IslandCoast.WATER_Y)) ? root.IslandCoast.WATER_Y : 0.28;
  }

  function setCoast(coast) {
    if (coast === fieldCoast) return;
    fieldCoast = coast || null;
    field = null;
    if (render && render.mesh) render.mesh.count = 0;
    if (!coast || disabled) return;
    try {
      field = new FishField(coast, { waterY: waterYValue() });
    } catch (e) { console.error('魚の機能を始められませんでした(魚なしで続行):', e); field = null; }
  }

  function buildShadowGeometry(T) {
    // 長さ0.9・幅0.4くらいの魚のシルエット(頭が +x)。XY平面に描いて、寝かせて(XZ平面)海面に置く。
    var s = new T.Shape();
    s.moveTo(0.45, 0);
    s.quadraticCurveTo(0.2, 0.22, -0.15, 0.1);
    s.lineTo(-0.5, 0.2);
    s.lineTo(-0.42, 0);
    s.lineTo(-0.5, -0.2);
    s.lineTo(-0.15, -0.1);
    s.quadraticCurveTo(0.2, -0.22, 0.45, 0);
    var g = new T.ShapeGeometry(s);
    g.rotateX(-Math.PI / 2);
    return g;
  }

  function initRender(T, scene) {
    var mat = new T.MeshBasicMaterial({
      color: CONFIG.shadowColor, transparent: true, opacity: CONFIG.shadowOpacity,
      depthWrite: false, side: T.DoubleSide, fog: true,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
    });
    var mesh = new T.InstancedMesh(buildShadowGeometry(T), mat, CONFIG.maxFish);
    mesh.count = 0;
    mesh.frustumCulled = false; // 魚は島のあちこちに散らばる。全体の外接球で判定されると誤って消えるため
    mesh.renderOrder = 1;
    scene.add(mesh);
    render = {
      THREE: T, scene: scene, mesh: mesh, dummy: new T.Object3D(),
      frustum: new T.Frustum(), mat4: new T.Matrix4(), sphere: new T.Sphere()
    };
  }

  function disable(e) {
    disabled = true; field = null;
    console.error('魚の機能で問題が起きたため、魚だけを止めました(ゲームは続行):', e);
    try { if (render && render.mesh) { render.mesh.count = 0; render.scene.remove(render.mesh); } } catch (e2) { /* 何もしない */ }
  }

  function update(dt, px, pz, camera, scene) {
    if (!field || disabled) return;
    var T = root && root.THREE;
    if (!T || !camera || !scene || !isNum(px) || !isNum(pz)) return;
    try {
      if (!render) initRender(T, scene);
      var r = render, waterY = waterYValue();
      camera.updateMatrixWorld();
      r.mat4.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      r.frustum.setFromProjectionMatrix(r.mat4);
      field.isVisible = function (x, z, rad) { r.sphere.center.set(x, waterY, z); r.sphere.radius = rad; return r.frustum.intersectsSphere(r.sphere); };
      field.update(dt, px, pz);

      var list = field.fish, n = Math.min(list.length, CONFIG.maxFish), t = (typeof performance !== 'undefined' ? performance.now() : 0) / 1000;
      for (var i = 0; i < n; i++) {
        var f = list[i], s = f.scale * f.size;
        var sway = (f.gliding || f.swimming) ? Math.sin(t * 6 + f.id) * 0.18 : 0; // 泳いでいる間だけ、少し尾を振る
        r.dummy.position.set(f.x, waterY + CONFIG.yOffset, f.z);
        r.dummy.rotation.set(0, f.heading + sway, 0);
        r.dummy.scale.set(s, s, s);
        r.dummy.updateMatrix();
        r.mesh.setMatrixAt(i, r.dummy.matrix);
      }
      r.mesh.count = n;
      r.mesh.instanceMatrix.needsUpdate = true;
    } catch (e) { disable(e); }
  }

  var api = {
    CONFIG: CONFIG,
    FishField: FishField,
    computeWaterlineOffset: computeWaterlineOffset,
    setCoast: setCoast,
    update: update,
    nearestFish: function (x, z, maxDist) { return field ? field.nearestFish(x, z, maxDist) : null; },
    count: function () { return field ? field.fish.length : 0; },
    // --- 釣り機能(js/fishing.js)との連携口 ---
    hasField: function () { return !!field && !disabled; },
    waterlineOffset: function () { return field ? field.waterOffset : 0; },
    listFish: function () { return field ? field.listFree() : []; },
    takeFish: function (id) { return field ? field.takeControl(id) : false; },
    moveFish: function (id, x, z, heading, swimming) { return field ? field.moveControlled(id, x, z, heading, swimming) : false; },
    releaseFish: function (id, mode) { return field ? field.releaseControl(id, mode) : false; }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.Fish = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
