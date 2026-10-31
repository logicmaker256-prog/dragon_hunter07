/* ---------------------------------------------------------------------
   畑(js/farmland.js)
   game.html の「23. 農地システム(耕地を作る)」「24. 農協(栽培システム):
   種まき・生育・収穫」をまとめて分離したファイル。ロジックは元のまま無変更。
   この2つは耕地(farmlands配列の各要素)を挟んで常に一体で動く仕組み
   (canTillFarmlandが使うfarmlandCellOf、種まき/収穫が使うfarmlandTargetHeight
   など)なので、あえて2ファイルに分けず1つにまとめてある。

   THREE / CONFIG / scene / heightAt / biomeAt / BIOME / isPassable /
   isPositionEnclosed / enclosureAt / enclosureAvgHeight / ranchZoneCellSet /
   buildings / BOARD_POS / treeData / saplings / enemies / disposeMesh /
   getCropDef / CROPS / inventory / farmlands / farmlandIdCounter /
   updatePotionBar / jstHourSerial / JST_OFFSET_MS / player / isBusy /
   isDodging / placementActive / playPoseTimed / playPose / POSE /
   showToast など、game.html本編で定義されるグローバルをそのまま利用するため、
   このファイルは <script src="js/farmland.js"> を game.html 本編の
   <script> より後に読み込む必要がある(現在の配置のまま変更しないこと)。
   isPositionEnclosed / enclosureAt / enclosureAvgHeight / ranchZoneCellSet は
   game.html側では本編scriptの中でこのセクションより後(柵の囲い判定・
   牧場ゾーン)で定義されているが、いずれも「呼び出される時点(ボタン操作時や
   毎フレームの更新時)」までに定義されていれば良く、game.html本編が
   このfarmland.jsより先に最後まで読み込まれるため問題なく参照できる。
--------------------------------------------------------------------- */
// (farmlands / farmlandIdCounter は初期化順序の都合上、game.html側の
//  苗木データの近くで宣言済み)
// 耕地の見た目(茶色い土 + うっすらとした畝のグリッド柄)。CanvasTextureで簡易生成する。
let farmlandTexture = null;
// 修正: 以前は4x4の直線格子(横線+縦線)で「2m四方の板を敷き詰めた」ような
// タイル感が出ており、それが牧場全体で見たときの「まだら」感の一因になっていた。
// 直線の格子をやめ、不規則な土粒・濃淡のみで質感を出すことで、隣接するメッシュ
// 同士の境界(タイルの継ぎ目)が視覚的に目立たなくなるようにする。
function makeFarmlandTexture() {
  const c = document.createElement('canvas'); c.width = 128; c.height = 128;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#6b4a2c';
  ctx.fillRect(0, 0, 128, 128);
  // 決定的な擬似乱数(呼ぶたびに同じ模様になれば十分で、Math.randomでも問題ないが
  // 明示的にシード付きにして挙動を安定させる)
  let seed = 1337;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed / 0x7fffffff);
  };
  // ごく薄い明暗のムラ(土の質感)。直線ではなく小さな円で不規則に散らす。
  for (let i = 0; i < 260; i++) {
    const x = rnd() * 128, y = rnd() * 128;
    const r = 1 + rnd() * 2.2;
    const dark = rnd() > 0.5;
    ctx.fillStyle = dark ? 'rgba(0,0,0,0.10)' : 'rgba(255,255,255,0.07)';
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }
  // 小さな土粒・小石程度のアクセント(控えめ)
  for (let i = 0; i < 40; i++) {
    const x = rnd() * 128, y = rnd() * 128;
    ctx.fillStyle = 'rgba(40,26,16,0.35)';
    ctx.beginPath(); ctx.arc(x, y, 0.8 + rnd() * 1.2, 0, Math.PI * 2); ctx.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}
// 修正: centerX/centerZが渡された場合、平面を分割してメッシュの各頂点を
// 実際の地形(heightAt)に合わせて上下させる(=地形に土を「貼り付ける」)。
// これにより、
//   ・セル内で地形が微妙に上下している場合でも土メッシュが地形を覆いきれず
//     緑の地面が突き出て見える(まだら)問題
//   ・隣接セルの土メッシュ同士が別々の高さで平坦配置され段差ができる問題
// の両方を解消する。隣接メッシュは同じワールド座標(セルの境界線上)で同じ
// heightAt()を評価するため、境界がぴったり一致し隙間が出ない。
// centerX/centerZ省略時は従来通りの単純な平板(後方互換)。
function makeFarmlandMesh(size, centerX, centerZ) {
  const hasCenter = typeof centerX === 'number' && typeof centerZ === 'number';
  const segs = hasCenter ? 4 : 1; // 2m四方セルを4分割(0.5m間隔)して地形に追従させる
  const geo = new THREE.PlaneGeometry(size, size, segs, segs);
  geo.rotateX(-Math.PI / 2);
  if (hasCenter) {
    const baseH = heightAt(centerX, centerZ);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const lx = pos.getX(i), lz = pos.getZ(i);
      // ローカルYには「中心からの地形の高さの差分」だけを載せる。
      // mesh.position.yに中心の高さ+オフセットが入るので、これで各頂点の
      // 最終的なワールド高さは heightAt(その頂点の実座標) と一致する。
      pos.setY(i, heightAt(centerX + lx, centerZ + lz) - baseH);
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
  }
  if (!farmlandTexture) farmlandTexture = makeFarmlandTexture();
  const mat = new THREE.MeshStandardMaterial({ map: farmlandTexture, roughness: 1, flatShading: true });
  return new THREE.Mesh(geo, mat);
}
// 修正: 柵の囲い判定(recomputeEnclosures)が使っているのと同じマス目座標系に
// 耕地を揃えるためのヘルパー。セルサイズ=CONFIG.farmlandSize(=fenceLengthと同じ)。
// セル(a,b)の中心座標は ((a+0.5)*L, (b+0.5)*L) になる(9.65節の座標系と一致)。
function farmlandCellOf(x, z) {
  const L = CONFIG.farmlandSize;
  return { a: Math.floor(x / L), b: Math.floor(z / L) };
}
function farmlandCellCenter(a, b) {
  const L = CONFIG.farmlandSize;
  return { x: (a + 0.5) * L, z: (b + 0.5) * L };
}
function farmlandCellKey(a, b) { return a + ',' + b; }
// 既に耕地があるマス目の集合(高速判定用)。createFarmland/restoreFarmland/
// clearAllFarmlandsで追従させる。
const filledFarmlandCells = new Set();

// 耕せる条件(改訂): 「柵で囲われた土地」かつ「モンスター(家畜化されたものを含む)が
// いない」かつ「木や岩がない」場所に限定する。
// ・囲い判定は既存のisPositionEnclosed()(柵の囲いフラッドフィル結果)をそのまま再利用。
// ・モンスター判定はenemies配列を再利用し、生存していれば家畜化済み(tamed)も含めて除外する。
// ・木/岩(山岳・高山バイオーム)/建物/柵/既存農地との重なりは従来通りチェックする。
// 修正: 引数(x,z)は「耕そうとしている狙い位置」であり、実際に耕されるのは
// それが属するマス目の中心(下のperformTillSequence側でスナップ済み)。
// 既存耕地との重なりチェックは距離計算ではなく、同じマス目かどうかで判定する
// (グリッドに揃っているので、これで隙間なく・重複なく敷き詰められる)。
function canTillFarmland(x, z) {
  if (!isPassable(x, z)) return false;
  const biome = biomeAt(x, z);
  if (biome === BIOME.MOUNTAIN || biome === BIOME.ALPINE) return false; // 岩場のある地帯は耕せない
  if (!isPositionEnclosed(x, z)) return false; // 柵で囲われた土地であること
  {
    const { a, b } = farmlandCellOf(x, z);
    // 牧場ゾーン(モンスターまたはそのリポップ場所がある囲い)は、耕作可能地とは
    // 完全に排他。牧場と耕地が同じ場所に混在することは無い。
    if (ranchZoneCellSet.has(farmlandCellKey(a, b))) return false;
  }
  // 建物(アイテム屋・教会・農協…)は何棟あってもよいよう、配列を走査して判定する。
  for (const bld of buildings) {
    if (Math.hypot(x - bld.x, z - bld.z) < 3.2) return false;
  }
  if (Math.hypot(x - BOARD_POS.x, z - BOARD_POS.z) < 2.2) return false;
  for (const t of treeData) {
    if (t.alive && Math.hypot(x - t.x, z - t.z) < 1.1) return false;
  }
  // 第5段階: 島の岩・結晶の上は耕せない(島の装飾が既存マップのときは常に false)
  if (typeof isBlockedByTerrainObject === 'function' && isBlockedByTerrainObject(x, z, 1.0)) return false;
  for (const s of saplings) {
    if (Math.hypot(x - s.x, z - s.z) < 1.1) return false;
  }
  // 修正(柵内すべて耕せる化): 「柵の柱からの生ワールド座標距離が1.0m未満なら耕せない」
  // という判定をここから削除した。柵の柱はマス目の"境界"(角や辺の中点)に立っており、
  // 半径1.0m(=マス目1辺の半分)の除外円を引くと、その柵に隣接するセルの内側に
  // 半円/扇形の"耕せない欠け"ができてしまう(囲いの左下や、縦柵の内側に細長い帯が
  // 残っていたのはこれが原因)。柵で囲まれた土地かどうかは既にisPositionEnclosed()で
  // マス目単位で正しく判定済みなので、ここでの追加の距離判定は不要かつ有害だった。
  // モンスター(野生・家畜化済み問わず)がいないこと
  for (const e of enemies) {
    if (!e.alive) continue;
    const minDist = 0.9 + 0.55 * (e.baseScale || 1);
    if (Math.hypot(x - e.mesh.position.x, z - e.mesh.position.z) < minDist) return false;
  }
  const { a, b } = farmlandCellOf(x, z);
  if (filledFarmlandCells.has(farmlandCellKey(a, b))) return false; // このマス目は耕作済み
  return true;
}
// 修正: 耕地の高さは、その1マスだけの地形の高さではなく「囲い(柵で囲われた
// エリア)全体の平均の高さ」に揃える。同じ囲いの中で耕した土地はすべて同じ
// 高さになり、段差なく綺麗に繋がる(=整地された農地らしい見た目になる)。
// enclosureAtが見つからない(=柵未検出などの想定外ケース)場合のみ、従来通り
// その地点の地形の高さにフォールバックする。
function farmlandTargetHeight(x, z) {
  const enc = enclosureAt(x, z);
  const avgH = enclosureAvgHeight(enc);
  return (avgH !== null ? avgH : heightAt(x, z)) + 0.03;
}
function createFarmland(x, z) {
  // 修正: 実際に生成する位置は、狙い位置(x,z)が属するマス目の中心にスナップする。
  // これにより隣同士の耕地が柵のマス目とぴったり揃い、隙間や重なりが生まれない。
  const { a, b } = farmlandCellOf(x, z);
  const center = farmlandCellCenter(a, b);
  // 高さを囲いの平均に統一するため、地形追従(centerX/centerZ指定)はせず平坦なメッシュにする。
  const mesh = makeFarmlandMesh(CONFIG.farmlandSize);
  mesh.position.set(center.x, farmlandTargetHeight(center.x, center.z), center.z);
  scene.add(mesh);
  const id = farmlandIdCounter++;
  const rec = {
    id, x: center.x, z: center.z, size: CONFIG.farmlandSize, createdAt: Date.now(),
    cropType: null, growthState: null, mesh,
    // 追加(お助けメイド仕事内容変更): 直前に収穫した作物の種類。まだ何も収穫していない
    // 新規の耕地はnull(メイドの自動まき直しの対象外。仕様2参照)。
    lastCropType: null,
    // 農協(栽培): 表示中の作物メッシュとその生育段階のキャッシュ。セーブ対象外(cropType/growthStateから再計算する)。
    cropMesh: null, cropStage: -1,
  };
  farmlands.push(rec);
  filledFarmlandCells.add(farmlandCellKey(a, b));
  updatePotionBar(); // 農地カウンター(UI)を更新
  return rec;
}
function restoreFarmland(id, x, z, size, createdAt, cropType, growthState, lastCropType) {
  const s = size || CONFIG.farmlandSize;
  const mesh = makeFarmlandMesh(s);
  mesh.position.set(x, farmlandTargetHeight(x, z), z);
  scene.add(mesh);
  let gs = growthState || null;
  // 水やり仕様の追加前に保存されたデータ({plantedAtのみ})との互換性: それまでの
  // 経過時間をそのまま成長済み時間とみなし、ロード直後は「今日は水やり済み」扱いに
  // することで、既存の作物がいきなり成長停止したことにならないようにする。
  if (gs && typeof gs.accumulatedSec !== 'number') {
    const def = getCropDef(cropType);
    const legacyElapsedSec = def ? Math.max(0, (Date.now() - gs.plantedAt) / 1000) : 0;
    gs = {
      plantedAt: gs.plantedAt,
      accumulatedSec: legacyElapsedSec,
      lastAccrualAt: Date.now(),
      lastWateredDay: currentGameDayIndex(Date.now()),
    };
  }
  const rec = {
    id, x, z, size: s, createdAt: createdAt || Date.now(),
    cropType: cropType || null, growthState: gs, mesh,
    // 追加(お助けメイド仕事内容変更): 旧セーブデータ(この項目が無い)はnullで安全に初期化する。
    lastCropType: lastCropType || null,
    cropMesh: null, cropStage: -1,
  };
  farmlands.push(rec);
  farmlandIdCounter = Math.max(farmlandIdCounter, id + 1);
  const { a, b } = farmlandCellOf(x, z);
  filledFarmlandCells.add(farmlandCellKey(a, b));
  updateFarmlandCropVisual(rec); // ロード直後に、栽培中だった作物の見た目を即座に反映する
  return rec;
}
function clearAllFarmlands() {
  [...farmlands].forEach(fl => {
    scene.remove(fl.mesh); disposeMesh(fl.mesh);
    if (fl.cropMesh) { scene.remove(fl.cropMesh); disposeMesh(fl.cropMesh); }
  });
  farmlands.length = 0;
  filledFarmlandCells.clear();
}

/* ---------------------------------------------------------------------
   農協(栽培システム): 種まき・生育・収穫
   作物の種類はCROPS(game.html側で定義済み)に沿って扱う。耕地(farmlands)が
   元々持っていたcropType/growthStateを実際に使い、plantedAtからの経過時間で
   生育段階を再計算する(苗木の成長と同じ考え方)。
--------------------------------------------------------------------- */
const DEFAULT_CROP_STAGE_COLORS = [0x6fae4a, 0x8a9a3a, 0xe0c25a]; // 芽 → 生育中 → 収穫期(見た目の既定値)
function makeCropMesh(cropDef, stage) {
  const colors = (cropDef && cropDef.stageColors) || DEFAULT_CROP_STAGE_COLORS;
  const color = colors[Math.min(stage, colors.length - 1)];
  const heights = [0.22, 0.42, 0.62]; // 段階が進むほど丈が高くなる
  const h = heights[Math.min(stage, heights.length - 1)];
  const mat = new THREE.MeshStandardMaterial({ color, flatShading: true });
  const group = new THREE.Group();
  // 苗木の芽と同系統の簡易表現(細い円錐)を数本束ねて、作物が生えている雰囲気を出す。
  const offsets = [[0, 0], [0.13, 0.08], [-0.1, 0.11], [0.06, -0.13], [-0.13, -0.05]];
  offsets.forEach(([ox, oz]) => {
    const blade = new THREE.Mesh(new THREE.ConeGeometry(0.05, h, 5), mat);
    blade.position.set(ox, h / 2, oz);
    group.add(blade);
  });
  return group;
}
// ---------------------------------------------------------------------
// 追加(お助けメイド仕様拡張): 作物の水やり
// 「ゲーム内1日」= 姫歴の1日(jstHourSerial基準、実時間1時間ごとに切り替わる)。
// この1日のうちに水をやっていない作物は、成長時間の加算を止める(=成長が止まる)。
// 既存のgrowthState({plantedAt}のみ)を、実際に加算された成長秒数(accumulatedSec)を
// 持つ形に拡張し、「水をやった日の枠の終わりまで」だけ経過時間を加算する設計にする。
// ---------------------------------------------------------------------
// 【毎朝管理】「ゲーム内の1日」の区切りは、ゲーム内の朝(起床時刻=6:00)にする。
// 睡眠・食事ではGameTime.skewMsだけゲーム内時計を先へ進める(gameNow()=Date.now()+skewMs)ため、
// 日の判定はこのskewを足した「ゲーム内の時刻」で行う。こうすると、夜(例: 20:00)に水やり・収穫を
// した後で眠っても、朝6:00に目覚めた時点で必ず「次の日」になり、朝から水やりや牧場の収穫ができる。
// (作物が育つ速さそのものは従来どおり実時間基準で、変わらない)
function farmDayStartMs() {
  const h = (typeof CONFIG !== 'undefined' && CONFIG.survival && Number.isFinite(CONFIG.survival.wakeHour)) ? CONFIG.survival.wakeHour : 6;
  return h / 24 * 3600000; // ゲーム内の朝(例: 6:00)が実時間で1時間のうち何msの位置か(6:00=15分=900000ms)
}
function farmSkewMs() { return (typeof GameTime !== 'undefined' && GameTime.skewMs) ? GameTime.skewMs : 0; }
function farmGameNow() { return (typeof gameNow === 'function') ? gameNow() : Date.now(); }
// ゲーム内時刻(epoch ms)がどの「朝区切りの日」に属するか
function farmMorningDayIndex(gameEpochMs) { return Math.floor((gameEpochMs - farmDayStartMs() + JST_OFFSET_MS) / 3600000); }
// 「朝区切りの日」dayIdxが終わる(=次の朝が来る)ゲーム内時刻(epoch ms)
function farmMorningStartOfDay(dayIdx) { return dayIdx * 3600000 + farmDayStartMs() - JST_OFFSET_MS; }
// 渡された実時刻epochMsを、現在のskewでゲーム内時刻に直して「何日目」かを返す
// (オフライン処理のように過去の実時刻を渡す場合も、skewが一定の間は同じ基準で比べられる)
function currentGameDayIndex(epochMs) { return farmMorningDayIndex(epochMs + farmSkewMs()); }
function isWateredToday(fl) {
  return !!(fl.growthState && fl.growthState.lastWateredDay === currentGameDayIndex(Date.now()));
}
// growthStateのaccumulatedSecを「今」まで確定させる。水やり済みの日の枠を超えた分は
// 加算しない(=その時点で成長が止まる)。同じ日のうちに何度呼んでも安全(冪等)。
function settleCropGrowth(fl, now) {
  const gs = fl.growthState;
  if (!gs) return;
  if (typeof gs.accumulatedSec !== 'number') gs.accumulatedSec = 0;
  if (typeof gs.lastAccrualAt !== 'number') gs.lastAccrualAt = gs.plantedAt;
  if (typeof gs.lastWateredDay !== 'number') gs.lastWateredDay = null;
  if (now <= gs.lastAccrualAt) return;
  if (gs.lastWateredDay !== null) {
    // 水やりでカバーされている「その日」の枠の終わり(次の朝6:00)まで加算する。
    // 朝区切りの日はゲーム内時刻なので、現在のskewを引いて実時刻に直して比べる。
    const dayEndEpoch = farmMorningStartOfDay(gs.lastWateredDay + 1) - farmSkewMs();
    const growUntil = Math.min(now, dayEndEpoch);
    if (growUntil > gs.lastAccrualAt) gs.accumulatedSec += (growUntil - gs.lastAccrualAt) / 1000;
  }
  gs.lastAccrualAt = now;
}
// 水をやる。既に今日やっていれば何もしない。水やり前の経過分をまず確定させてから
// 「今日は水やり済み」を記録する(後から呼ばれるsettleCropGrowthが今日の枠の分だけ
// 正しく加算できるようにするため)。
function waterCrop(fl, now) {
  now = now || Date.now();
  if (!fl.cropType || !fl.growthState) return false;
  if (isWateredToday(fl)) return false;
  settleCropGrowth(fl, now);
  fl.growthState.lastWateredDay = currentGameDayIndex(now);
  fl.growthState.lastAccrualAt = now;
  return true;
}
// 経過時間から生育段階を求める(0:芽 / 1:生育中 / 2:収穫期 / -1:何も植わっていない)。
function computeCropStage(fl) {
  if (!fl.cropType || !fl.growthState) return -1;
  const def = getCropDef(fl.cropType);
  if (!def) return -1;
  settleCropGrowth(fl, Date.now());
  const t = fl.growthState.accumulatedSec / def.growSeconds;
  if (t >= 1) return 2;
  if (t >= 0.5) return 1;
  return 0;
}
function updateFarmlandCropVisual(fl) {
  const newStage = computeCropStage(fl);
  if (newStage === fl.cropStage) return;
  if (fl.cropMesh) { scene.remove(fl.cropMesh); disposeMesh(fl.cropMesh); fl.cropMesh = null; }
  fl.cropStage = newStage;
  if (newStage >= 0) {
    const def = getCropDef(fl.cropType);
    fl.cropMesh = makeCropMesh(def, newStage);
    fl.cropMesh.position.set(fl.x, farmlandTargetHeight(fl.x, fl.z), fl.z);
    scene.add(fl.cropMesh);
  }
}
function refreshAllCrops() { farmlands.forEach(updateFarmlandCropVisual); }
// 指定したワールド座標が属するマス目に既にある耕地を返す(無ければnull)。
function farmlandAt(x, z) {
  const { a, b } = farmlandCellOf(x, z);
  const key = farmlandCellKey(a, b);
  return farmlands.find(fl => {
    const c = farmlandCellOf(fl.x, fl.z);
    return farmlandCellKey(c.a, c.b) === key;
  }) || null;
}
function plantCrop(fl, cropId) {
  const def = getCropDef(cropId);
  if (!def || fl.cropType) return false; // 未定義の作物、または既に何か植わっている
  if ((inventory.seed[cropId] || 0) <= 0) return false;
  inventory.seed[cropId]--;
  fl.cropType = cropId;
  // accumulatedSec: 実際に成長として計上された秒数。lastWateredDay: 直近に水をやった日
  // (null=まだ一度も水をやっていない=このままでは成長しない)。
  fl.growthState = { plantedAt: Date.now(), accumulatedSec: 0, lastAccrualAt: Date.now(), lastWateredDay: null };
  fl.cropStage = -1; // 次のupdateFarmlandCropVisual呼び出しで芽の見た目を反映させる
  updateFarmlandCropVisual(fl);
  return true;
}
function harvestCrop(fl) {
  if (computeCropStage(fl) !== 2) return false; // 収穫期のみ収穫できる
  const cropId = fl.cropType;
  inventory.crop[cropId] = (inventory.crop[cropId] || 0) + 1;
  // 追加(お助けメイド仕事内容変更): 収穫直前に植わっていた作物の種類を記録しておく。
  // メイドAI(js/maid-ai.js)はこれを見て、収穫後の畑に同じ作物の種を自動でまき直す。
  // 勇者が手動で収穫した畑もメイドの世話の対象になる(メイド専用の畑ではないため)。
  fl.lastCropType = cropId;
  fl.cropType = null;
  fl.growthState = null;
  updateFarmlandCropVisual(fl); // 作物メッシュを消し、耕地は植え直せる状態に戻す
  return true;
}


// 修正: 「勇者の正面」ではなく「勇者の足もと」を耕す対象位置にする。
function computeTillTargetPos() {
  if (!player) return null;
  return { x: player.position.x, z: player.position.z };
}

// 修正: 鍬アニメーション(振り上げ→振り下ろし)を1回流しただけでは農地は完成しない。
// 同じマス目に対してCONFIG.tillRequiredSwings回(=3回)振り下ろすと、その時点で
// 農地が完成する。マス目ごとの進捗はtillProgressに保持し、完成したら消去する。
const tillProgress = new Map(); // cellKey("a,b") -> これまでに振り下ろした回数
function performTillSequence() {
  if (!player || isBusy || isDodging || placementActive) return;
  const pos = computeTillTargetPos();
  if (!pos || !canTillFarmland(pos.x, pos.z)) { showToast('ここは耕せません', 1600); return; }
  const { a, b } = farmlandCellOf(pos.x, pos.z);
  const cellKey = farmlandCellKey(a, b);
  isBusy = true;
  tillPromptEl.style.display = 'none';
  const tUp = CONFIG.hoeUpTime, tDown = CONFIG.hoeDownTime;
  playPoseTimed(POSE.HOE_UP, tUp, 0.05);
  setTimeout(() => {
    playPoseTimed(POSE.HOE_DOWN, tDown, 0.05);
    // 振り下ろしのタイミングで進捗を加算(振り上げた瞬間には加算しない)。
    // アニメーション開始からここまでの間に条件が変わっていないか念のため再確認する。
    if (canTillFarmland(pos.x, pos.z)) {
      const count = (tillProgress.get(cellKey) || 0) + 1;
      if (count >= CONFIG.tillRequiredSwings) {
        tillProgress.delete(cellKey);
        createFarmland(pos.x, pos.z);
        showToast('🌾 農地を作った！', 1600);
      } else {
        tillProgress.set(cellKey, count);
        showToast(`🌾 耕した (${count}/${CONFIG.tillRequiredSwings})`, 1400);
      }
    } else {
      tillProgress.delete(cellKey);
      showToast('耕せなかった', 1400);
    }
    setTimeout(() => { isBusy = false; playPose(POSE.IDLE, 0.2); }, tDown * 1000 * 0.9);
  }, tUp * 1000 * 0.9);
}
const tillPromptEl = document.getElementById('tillPrompt');
const tillPromptTextEl = document.getElementById('tillPromptText');
const tillBtn = document.getElementById('tillBtn');
function updateTillProximity() {
  if (!player || isBusy || isDodging || placementActive) { tillPromptEl.style.display = 'none'; return; }
  const pos = computeTillTargetPos();
  const tillable = !!(pos && canTillFarmland(pos.x, pos.z));
  tillPromptEl.style.display = tillable ? 'flex' : 'none';
  if (tillable) {
    const { a, b } = farmlandCellOf(pos.x, pos.z);
    const count = tillProgress.get(farmlandCellKey(a, b)) || 0;
    tillPromptTextEl.textContent = count > 0 ? `🌾 耕す (${count}/${CONFIG.tillRequiredSwings})` : '🌾 耕せる場所';
  }
}
tillBtn.addEventListener('click', performTillSequence);

// 追加(水やり): 鍬を使ったtillと同じテンポ(振り上げ→振り下ろし)のモーションを
// 流用し、振り下ろしのタイミングで実際に水をやる。専用のジョウロモーションは
// 勇者のGLBには無い(メイドの新モデルにのみ存在する)ため、既存の鍬モーションで代用する。
function performWaterSequence(fl) {
  if (!player || isBusy || isDodging || placementActive) return;
  if (!fl || !fl.cropType || isWateredToday(fl)) return;
  isBusy = true;
  cropPromptEl.style.display = 'none';
  const tUp = CONFIG.hoeUpTime, tDown = CONFIG.hoeDownTime;
  playPoseTimed(POSE.HOE_UP, tUp, 0.05);
  setTimeout(() => {
    playPoseTimed(POSE.HOE_DOWN, tDown, 0.05);
    if (fl.cropType && !isWateredToday(fl)) {
      waterCrop(fl, Date.now());
      showToast('💧 水をやった', 1400);
    }
    setTimeout(() => { isBusy = false; playPose(POSE.IDLE, 0.2); }, tDown * 1000 * 0.9);
  }, tUp * 1000 * 0.9);
}

/* --- 農協(栽培): 耕地の上で「種をまく」「収穫する」プロンプト。
   tillPromptは未耕地(これから耕す場所)専用、こちらは既に耕地になっているマス目専用なので、
   同じマス目で両方が同時に表示されることはない。 --- */
const cropPromptEl = document.getElementById('cropPrompt');
const cropPromptTextEl = document.getElementById('cropPromptText');
const cropActionBtn = document.getElementById('cropActionBtn');
let cropPromptTarget = null; // { fl, action: 'plant'|'harvest'|'water', cropId? }
function updateCropProximity() {
  if (!player || isBusy || isDodging || placementActive) { cropPromptEl.style.display = 'none'; cropPromptTarget = null; return; }
  const pos = computeTillTargetPos();
  const fl = pos ? farmlandAt(pos.x, pos.z) : null;
  const stage = fl ? computeCropStage(fl) : -99;
  if (fl && stage === 2) {
    const def = getCropDef(fl.cropType);
    cropPromptTarget = { fl, action: 'harvest' };
    cropPromptTextEl.textContent = `${def.icon} ${def.name}を収穫できます`;
    cropActionBtn.textContent = '収穫する';
    cropActionBtn.disabled = false;
    cropPromptEl.style.display = 'flex';
  } else if (fl && (stage === 0 || stage === 1)) {
    // 追加(水やり): ゲーム内1日(姫歴の1日)に1回水をやらないと成長が止まる
    const def = getCropDef(fl.cropType);
    const watered = isWateredToday(fl);
    cropPromptTarget = watered ? null : { fl, action: 'water' };
    cropPromptTextEl.textContent = watered
      ? `💧 ${def.name}に水やり済み(また明日の朝)`
      : `💧 ${def.name}に水をやる`;
    cropActionBtn.textContent = '水をやる';
    cropActionBtn.disabled = watered;
    cropPromptEl.style.display = 'flex';
  } else if (fl && stage === -1) {
    // 何も植わっていない耕地。現状は作物が小麦のみなので、そのまま小麦の種を対象にする
    // (将来複数の作物を扱う場合は、ここを選択式のUIに拡張する)。
    const def = CROPS[0];
    const have = def ? (inventory.seed[def.id] || 0) : 0;
    cropPromptTarget = def ? { fl, action: 'plant', cropId: def.id } : null;
    cropPromptTextEl.textContent = def ? `🌱 ${def.name}の種をまく(所持${have})` : '🌱 種をまく';
    cropActionBtn.textContent = '植える';
    cropActionBtn.disabled = have <= 0;
    cropPromptEl.style.display = 'flex';
  } else {
    cropPromptTarget = null;
    cropPromptEl.style.display = 'none';
  }
}
cropActionBtn.addEventListener('click', () => {
  if (!cropPromptTarget) return;
  if (cropPromptTarget.action === 'harvest') {
    if (harvestCrop(cropPromptTarget.fl)) showToast('🌾 収穫した！', 1600);
    updateCropProximity();
  } else if (cropPromptTarget.action === 'plant') {
    if (plantCrop(cropPromptTarget.fl, cropPromptTarget.cropId)) showToast('🌱 種をまいた', 1400);
    updateCropProximity();
  } else if (cropPromptTarget.action === 'water') {
    performWaterSequence(cropPromptTarget.fl); // isBusy経由でUIが自動的に更新される
  }
});
