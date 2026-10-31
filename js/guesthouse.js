/* ---------------------------------------------------------------------
   ゲストハウス(js/guesthouse.js)
   「ゲストハウス・領民システム安全実装プロンプト」Phase 1 への対応。

   安全地帯(isFloorSafeZone、js/church.js)にしたフロアだけ、既存の「🔨 建築」
   メニュー(buildModal/buildBody、game.html)の中に「ゲストハウスを建てる」を
   追加する。既存の建築メニュー(柵・苗木)のロジックは一切変更しない。

   ゲストハウスのデータ(guestHouses)は既存のbuildings配列(アイテム屋/教会/農協)
   とは独立させ、既存のbuildings配列・そのインデックス参照(CHURCH_POS=buildings[1]等)
   を壊さない。見た目は既存のmakeBuilding()をそのまま流用する(church以外のkindは
   アイテム屋/農協と同じ外観になるため、新しい建物メッシュ生成コードを増やさない)。

   CONFIG / scene / heightAt / isPassable / biomeAt / BIOME / buildings / BOARD_POS /
   farmlandCellOf / farmlandCellKey / filledFarmlandCells / ranchZoneCellSet /
   treeData / saplings / enemies / player / inventory / playerGold / showToast /
   updateRewardHud / updatePotionBar / disposeMesh / makeBuilding / currentFloor /
   isFloorSafeZone(js/church.js) など、game.html本編(および先に読み込まれる
   js/church.js)で定義されるグローバルをそのまま利用するため、このファイルは
   <script src="js/guesthouse.js"> を game.html 本編・js/church.js より後に
   読み込む必要がある。
--------------------------------------------------------------------- */

CONFIG.guesthouse = {
  woodCost: 20,
  goldCost: 100,
  capacity: 5,
  minSpacingFromOther: 4.0, // 他のゲストハウスとの最低距離
  minSpacingFromBuilding: 3.4, // アイテム屋・教会・農協との最低距離
  placeDistance: 4.0, // 仮設置モード中、プレイヤーの前方どれだけ先に仮のゲストハウスを表示するか
};

let guestHouses = []; // [{ id, floor, x, z, capacity, residents:[villagerId,...], mesh }]
let guestHouseIdCounter = 1;

/* ---------- 建築位置の妥当性チェック ----------
   既存のcanTillFarmland/canBuildGuesthouseAtで使う判定パターン(建物・掲示板・
   農地・牧場ゾーン・木・苗木・モンスターとの重なり回避)を踏襲する。
   柵の判定(isPositionEnclosed)は使わない(安全地帯はフロア単位の条件であり、
   ゲストハウス自体を柵で囲う必要はないため)。 */
function canBuildGuesthouseAt(x, z) {
  if (!isPassable(x, z)) return false;
  const biome = biomeAt(x, z);
  if (biome === BIOME.MOUNTAIN || biome === BIOME.ALPINE) return false;
  for (const bld of buildings) {
    if (Math.hypot(x - bld.x, z - bld.z) < CONFIG.guesthouse.minSpacingFromBuilding) return false;
  }
  if (Math.hypot(x - BOARD_POS.x, z - BOARD_POS.z) < 2.4) return false;
  for (const gh of guestHouses) {
    if (gh.floor !== currentFloor) continue; // 階別ワールド: 他の階のゲストハウスは、この階の建築を妨げない
    if (Math.hypot(x - gh.x, z - gh.z) < CONFIG.guesthouse.minSpacingFromOther) return false;
  }
  const { a, b } = farmlandCellOf(x, z);
  const key = farmlandCellKey(a, b);
  if (filledFarmlandCells.has(key)) return false;
  if (ranchZoneCellSet.has(key)) return false;
  for (const t of treeData) {
    if (t.alive && Math.hypot(x - t.x, z - t.z) < 1.3) return false;
  }
  // 第5段階: 島の岩・結晶の上には建てない(島の装飾が既存マップのときは常に false)
  if (typeof isBlockedByTerrainObject === 'function' && isBlockedByTerrainObject(x, z, 1.6)) return false;
  for (const s of saplings) {
    if (Math.hypot(x - s.x, z - s.z) < 1.3) return false;
  }
  for (const e of enemies) {
    if (e.alive && Math.hypot(x - e.mesh.position.x, z - e.mesh.position.z) < 1.6) return false;
  }
  return true;
}

/* ---------- 生成・復元・破棄 ---------- */
function createGuestHouse(x, z, floor, opts) {
  opts = opts || {};
  const id = opts.id || guestHouseIdCounter++;
  guestHouseIdCounter = Math.max(guestHouseIdCounter, id + 1);
  const mesh = makeBuilding('guesthouse', 'ゲストハウス');
  const h = heightAt(x, z);
  mesh.position.set(x, h, z);
  mesh.visible = (floor === currentFloor); // 階別ワールド: 他の階のゲストハウスは表示しない
  scene.add(mesh);
  const gh = {
    id, floor, x, z,
    capacity: (typeof opts.capacity === 'number' && opts.capacity > 0) ? opts.capacity : CONFIG.guesthouse.capacity,
    residents: [], // villagerId の配列。villager.js側で実体のあるvillagerが復元されるたびに追従する
    mesh,
  };
  guestHouses.push(gh);
  return gh;
}
function clearAllGuestHouses() {
  [...guestHouses].forEach(gh => { if (gh.mesh) { scene.remove(gh.mesh); disposeMesh(gh.mesh); } });
  guestHouses.length = 0;
}
// セーブデータ: residentsは保存しない(villagers側の所属guestHouseIdから毎回re-deriveするため、
// 二重管理による不整合を避ける)。
function gatherGuesthouseSaveData() {
  return guestHouses.map(gh => ({ id: gh.id, floor: gh.floor, x: gh.x, z: gh.z, capacity: gh.capacity }));
}
function restoreGuestHousesFromSave(list) {
  clearAllGuestHouses();
  guestHouseIdCounter = 1;
  if (!Array.isArray(list)) return; // 旧セーブデータ(guestHousesが無い)は空として正常にロードする
  list.forEach(rec => {
    if (typeof rec.x !== 'number' || typeof rec.z !== 'number' || typeof rec.floor !== 'number') return;
    createGuestHouse(rec.x, rec.z, rec.floor, { id: rec.id, capacity: rec.capacity });
  });
}

/* ---------- 階別ワールド: 表示の切り替え ----------
   ゲストハウス(と、所属する領民の見た目)は全階分をscene上に持ったまま、今いる階のものだけを
   表示する。startFloor()(game.html)の末尾から呼ばれる。データ(guestHouses/villagers)は
   一切変更せず、mesh.visible / group.visible を切り替えるだけ。 */
function updateGuesthouseFloorVisibility() {
  guestHouses.forEach(gh => { if (gh.mesh) gh.mesh.visible = (gh.floor === currentFloor); });
  if (typeof villagers !== 'undefined') {
    villagers.forEach(v => { if (v.group) v.group.visible = (v.floor === currentFloor) && !v.inside; }); // ゲストハウスの中(inside)にいる領民は表示しない
  }
}

/* ---------- 建築処理(仮設置 → 「ここに建てる」で確定) ----------
   既存の柵と同じ「設置モード」(game.htmlのplacementActive/previewObj/placeConfirmBtn/
   placeCancelBtn)を利用する。
     ・建築メニューの「建てる」= startGuesthousePlacement() … 材料・安全地帯の事前確認だけ行い、
       メニューを閉じて設置モードに入る。この時点ではguestHouses・木材・Gold・セーブに何も影響しない。
     ・仮表示 = makeGuesthousePreviewMesh() / updateGuesthousePreview() … 半透明の建物を
       プレイヤーの前方に表示するだけ(guestHouses等の正式データには入れない)。
     ・「ここに建てる」= confirmGuesthousePlacement() … 位置・材料・Goldの最終チェックを行い、
       すべて通った時だけ「材料を消費」→「createGuestHouse()」を1回だけ実行する。
     ・「キャンセル」= game.html側のexitPlacementMode()が仮表示を撤去するだけ(何も消費しない)。
   最終チェックの順番は従来どおり: 材料・Gold → 安全地帯 → 建築位置 → 消費 → 生成。 */
function guesthouseCanStartPlacement() {
  const woodOk = inventory.wood >= CONFIG.guesthouse.woodCost;
  const goldOk = playerGold >= CONFIG.guesthouse.goldCost;
  if (!woodOk || !goldOk) { showToast('材料が足りません', 1800); return false; }
  if (typeof isFloorSafeZone !== 'function' || !isFloorSafeZone(currentFloor)) {
    showToast('このフロアはまだ安全地帯ではありません', 2000);
    return false;
  }
  return true;
}
function startGuesthousePlacement() {
  if (!player) return;
  if (typeof placementActive !== 'undefined' && placementActive) return; // すでに設置モード中(連打対策)
  if (!guesthouseCanStartPlacement()) return;
  if (typeof closeAllModals === 'function') closeAllModals(); // 柵の設置と同じく、建築メニューを閉じてから設置モードへ
  if (typeof enterPlacementMode === 'function') enterPlacementMode('guesthouse');
}
// 仮のゲストハウス: 既存のmakeBuilding()の見た目をそのまま使い、半透明にするだけ。
// (makeBuilding()は呼び出しごとに専用のマテリアル/看板テクスチャを作るため、本物の建物には影響しない。
//  撤去はgame.htmlのexitPlacementMode()のdisposeMesh()で行われる)
function makeGuesthousePreviewMesh() {
  const m = makeBuilding('guesthouse', 'ゲストハウス');
  m.traverse(o => {
    if (o.material) {
      o.userData.ghOrigColor = o.material.color ? o.material.color.getHex() : 0xffffff;
      o.material.transparent = true;
      o.material.opacity = 0.55;
      o.material.depthWrite = false;
    }
  });
  return m;
}
function guesthousePreviewPosition() {
  const fx = Math.sin(player.rotation.y - CONFIG.characterForwardOffset);
  const fz = Math.cos(player.rotation.y - CONFIG.characterForwardOffset);
  const d = CONFIG.guesthouse.placeDistance;
  return { x: player.position.x + fx * d, z: player.position.z + fz * d };
}
// 毎フレーム(game.htmlのupdatePlacementPreview経由)呼ばれ、仮表示の位置と色(建築可=元の色/不可=赤)を更新する
function updateGuesthousePreview(obj) {
  if (!obj || !player) return;
  const { x, z } = guesthousePreviewPosition();
  obj.position.set(x, heightAt(x, z), z);
  const ok = canBuildGuesthouseAt(x, z);
  obj.traverse(o => {
    if (o.material && o.material.color) o.material.color.setHex(ok ? (o.userData.ghOrigColor || 0xffffff) : 0xff5a5a);
  });
}
// 「ここに建てる」: 成功したらtrue(呼び出し側が設置モードを抜ける)、失敗したらfalse(何も消費しない)
function confirmGuesthousePlacement(x, z) {
  if (!player) return false;
  if (typeof placementKind === 'undefined' || placementKind !== 'guesthouse') return false;
  if (!guesthouseCanStartPlacement()) return false; // 材料・Gold・安全地帯の最終チェック
  if (!canBuildGuesthouseAt(x, z)) { showToast('ここには建てられません', 1800); return false; }
  inventory.wood -= CONFIG.guesthouse.woodCost;
  playerGold -= CONFIG.guesthouse.goldCost;
  createGuestHouse(x, z, currentFloor);
  updateRewardHud();
  updatePotionBar();
  showToast('🏠 ゲストハウスを建てた!', 2200);
  return true;
}

/* ---------- 既存の建築メニュー(buildModal/buildBody)への接続用セクション ----------
   game.html側のrenderBuildModal()から html += renderGuesthouseSection(); で
   呼び出され、buildBody.innerHTML = html; の直後に bindGuesthouseSectionEvents(); が
   呼ばれる想定(既存のcraftFenceBtn等と同じ「毎回作り直して毎回バインドし直す」方式)。 */
function renderGuesthouseSection() {
  let html = '<div class="shopSectionTitle">🏠 ゲストハウス</div>';
  const safe = (typeof isFloorSafeZone === 'function') && isFloorSafeZone(currentFloor);
  if (!safe) {
    html += '<div class="statRow"><span>⚠️ このフロアを安全地帯にする(全モンスターを柵で囲う)と、ここにゲストハウスを建てられるようになります</span></div>';
  } else {
    const woodOk = inventory.wood >= CONFIG.guesthouse.woodCost;
    const goldOk = playerGold >= CONFIG.guesthouse.goldCost;
    html += `<div class="shopItemRow"><div class="itemInfo"><span>ゲストハウスを建てる</span><small>木材${CONFIG.guesthouse.woodCost}個・ゴールド${CONFIG.guesthouse.goldCost}G(定員${CONFIG.guesthouse.capacity}人・目の前に仮表示→「ここに建てる」で確定)</small></div>
      <button class="shopBuyBtn" id="buildGuesthouseBtn" ${(!woodOk || !goldOk) ? 'disabled' : ''}>建てる</button></div>`;
  }
  const onThisFloor = guestHouses.filter(gh => gh.floor === currentFloor);
  if (onThisFloor.length) {
    html += '<div class="shopSectionTitle">このフロアのゲストハウス</div>';
    onThisFloor.forEach(gh => {
      const cap = gh.capacity || CONFIG.guesthouse.capacity;
      const glbNote = (typeof villagerGlbTemplateModel !== 'undefined' && villagerGlbTemplateModel) ? '' : '(未選択の場合は簡易な姿で表示されます)';
      html += `<div class="shopItemRow"><div class="itemInfo"><span>🏠 ゲストハウス #${gh.id}</span><small>領民 ${gh.residents.length} / ${cap}人 ${glbNote}(領民は教会の紫水晶で呼び寄せます)</small></div></div>`;
    });
  }
  return html;
}
function bindGuesthouseSectionEvents() {
  const buildBtn = document.getElementById('buildGuesthouseBtn');
  if (buildBtn) buildBtn.addEventListener('click', startGuesthousePlacement);
}
