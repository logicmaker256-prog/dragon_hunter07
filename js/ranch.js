/* ---------------------------------------------------------------------
   牧場(js/ranch.js)
   game.html の「26. モンスターの飼育・牧場」「27. 牧場ゾーンの地面表示」、
   および「28. 設置モード・建築メニュー・牧場コレクションメニュー(UI)」の
   うち牧場コレクションメニュー部分(renderRanchModal/openRanchModal)を
   まとめて分離したファイル。ロジックは元のまま無変更。

   柵の囲い判定そのもの(enclosures / enclosedCellSet / isPositionEnclosed /
   enclosureAt / enclosureAvgHeight / recomputeEnclosures)は、js/farmland.js
   (耕地)からも参照される共通インフラのため、あえてgame.html側に残してある。
   本ファイルのsyncRanches()はgame.html側のrecomputeEnclosures()から、
   逆にgame.html側のrecomputeEnclosures()は本ファイルのsyncRanches()から、
   互いに呼び合う関係になっているが、どちらも実際に呼ばれるのは柵の設置操作time
   (ボタン操作)なので、game.html本編とranch.jsの両方が最後まで読み込まれた後で
   あれば問題なく解決できる。

   設置モード・建築メニュー(柵・苗木の作成/設置)は牧場と無関係な汎用UIなので
   game.html側に残し、牧場コレクションメニューだけ移動している(このメニューは
   レア武器・伝説アイテム・ボス討伐記録も一緒に表示する欄だが、コード上
   「ranch」の名前で統一的に扱われているため、無理に中身を分割せずまとめて
   移動した)。

   CONFIG / scene / enemies / player / fences / farmlands / filledFarmlandCells /
   farmlandCellOf / farmlandCellKey / makeFarmlandMesh / heightAt / disposeMesh /
   showToast / spawnFloatingText / spawnEnemy / monsterDisplayName / MONSTER_DEFS /
   inventory / rareWeapons / legendaryItems / bossDefeatCount / getFloorDef /
   equippedRareWeaponId / updateRewardHud / updatePotionBar / modalBackdrop /
   closeAllModals / enclosures / enclosedCellSet / enclosureAt など、
   game.html本編で定義されるグローバルをそのまま利用するため、このファイルは
   <script src="js/ranch.js"> を game.html 本編の <script> より後に
   読み込む必要がある(現在の配置のまま変更しないこと)。
--------------------------------------------------------------------- */

/* ---------------------------------------------------------------------
   26. モンスターの飼育・牧場(飼育 / 囲い専用のリポップ・素材収集)
   囲い(enclosures)の中に飼育対象(tamable)のモンスターが一定時間居続けると、
   自動的にテイムされて「牧場(ranch)」の家畜になる。牧場は
   「どの囲い(セル集合)に・どの種類が・何匹いるか」だけを持つ軽量な構造にして
   あり、柵の増改築でrecomputeEnclosures()が呼ばれるたびにsyncRanches()で
   現在の囲い形状と突き合わせる(柵が壊れて囲いが崩れると牧場も崩れる)。
--------------------------------------------------------------------- */
let ranches = []; // [{ id, cellsArr:['a,b',...], cellKey, type, count, entities:[enemy,...], breedTimer, nextHarvestAt, lastHarvestAt }]
let ranchIdCounter = 1;
function cellSetSignature(cellSet) { return Array.from(cellSet).sort().join('|'); }

function findOrCreateRanch(enc, type) {
  const sig = cellSetSignature(enc.cellSet);
  let ranch = ranches.find(r => r.type === type && r.cellKey === sig);
  if (!ranch) {
    ranch = {
      id: ranchIdCounter++, cellsArr: Array.from(enc.cellSet), cellKey: sig, type,
      // ゲーム内時間システム(姫歴)仕様6: 剥ぎ取りは「ゲーム時間1日に1回」。
      // 牧場ができた時点から1回目の剥ぎ取りが可能(=すぐ収穫できる)状態で始める。
      count: 0, entities: [], breedTimer: 0, nextHarvestAt: farmGameNow(), lastHarvestAt: null,
    };
    ranches.push(ranch);
  }
  return ranch;
}
// 牧場が「今、剥ぎ取り可能か」(ゲーム時間1日ぶんのクールダウンが明けているか)
// 【毎朝管理】剥ぎ取りは「ゲーム内の朝(6:00)ごとに1回」。nextHarvestAtは「ゲーム内時刻」(gameNow()基準)
// で持ち、睡眠で朝6:00まで時計を進めた時に必ず次の収穫が可能になる。何時に作った牧場・何時に収穫
// した牧場でも、次に収穫できるのは「次の朝6:00」から(夜20:00に収穫しても翌朝には収穫できる)。
function ranchHarvestReady(r) { return r.count > 0 && farmGameNow() >= r.nextHarvestAt; }
// ゲーム内時刻gameEpochMsより後で、最初に来る朝6:00のゲーム内時刻
function ranchNextMorningAfter(gameEpochMs) { return farmMorningStartOfDay(farmMorningDayIndex(gameEpochMs) + 1); }
// 剥ぎ取った時刻を記録し、次に剥ぎ取れる時刻(次の朝6:00)を設定する(ボタン・メイド・領民で共通)
function ranchMarkHarvested(r) {
  r.lastHarvestAt = Date.now();
  r.nextHarvestAt = ranchNextMorningAfter(farmGameNow());
}
// 柵が壊れて牧場の囲いが崩れた時、中の家畜(見た目上のメッシュ)を野生に戻す
function releaseRanch(r) {
  r.entities.forEach(e => {
    if (!enemies.includes(e)) return;
    e.tamed = false; e.aggro = false; e.enclosedTimer = 0; e.ranchId = null;
    if (e.tamedMark) e.tamedMark.visible = false;
    if (e.hpBar) e.hpBar.visible = true;
  });
  showToast(`🚧 柵が壊れて${monsterDisplayName(r.type)}の牧場(${r.count}匹)が崩れてしまった`, 2800);
}
// 柵の増改築のたびに呼ばれる。既存の牧場の囲いが今も閉じたままなら維持し、
// (統合等で)囲いのセル集合が更新されていればcellKeyを追従、崩れていれば解放する。
function syncRanches() {
  const survivors = [];
  for (const r of ranches) {
    const stillEnclosed = r.cellsArr.length > 0 && r.cellsArr.every(ck => enclosedCellSet.has(ck));
    if (stillEnclosed) {
      const enc = enclosures.find(en => r.cellsArr.every(ck => en.cellSet.has(ck)));
      if (enc) { r.cellsArr = Array.from(enc.cellSet); r.cellKey = cellSetSignature(enc.cellSet); }
      survivors.push(r);
    } else {
      releaseRanch(r);
    }
  }
  ranches = survivors;
  updateRanchZones(); // 柵の増改築で牧場ゾーンの範囲が変わったので地面表示を同期
}

/* ---------------------------------------------------------------------
   27. 牧場ゾーンの地面表示(牧場か耕作可能地かの判定・表示。
   どちらか一方にしかならず、両方が同時に成立することはない)
   ルール:
   ・囲いの中に、生きているモンスター(テイム済みの家畜も含む)が現在いる、
     または、そのモンスターの元の座標(origX/origZ = リポップ場所)が
     囲いの中にある → その囲いは「牧場ゾーン」。囲いの中身を全て茶色い
     土(耕地と同じ見た目)で埋め尽くす。手動での開墾(耕す)はできない。
   ・囲いの中に、モンスターも、モンスターのリポップ場所も無い →
     「耕作可能地」。従来通り、鍬で1マスずつ手動で耕せる。
   ・囲いが牧場ゾーンになった瞬間、その場所に残っていた手動耕地(farmlands)
     は矛盾する過去データとして破棄し、新しい判定(牧場ゾーン)を優先する。
   柵の増改築・テイム・モンスターの死亡・ロードのたびに呼び直して
   最新の状態に同期する(このセクションの旧名は「囲いデバッグ可視化」
   だったが、実際のゲーム挙動そのものを決める本番ロジックに変わったため
   改称した)。
--------------------------------------------------------------------- */
let ranchZoneCellSet = new Set(); // 牧場ゾーンと判定された全マス("a,b"形式)
let ranchZoneMeshes = [];
function clearRanchZoneVisualization() {
  ranchZoneMeshes.forEach(m => { scene.remove(m); disposeMesh(m); });
  ranchZoneMeshes.length = 0;
}
// ある囲い(enclosures内の要素)が「牧場ゾーン」かどうかを判定する。
// 生存中のモンスター(テイム済み含む)の現在位置か、その個体のリポップ座標
// (origX/origZ、通常は柵で囲う前の元々の立ち位置)のどちらかがこの囲いの
// マス目に含まれていれば、牧場ゾーンとみなす。
function enclosureIsRanchZone(enc) {
  const L = CONFIG.fenceLength;
  for (const e of enemies) {
    if (!e.alive) continue;
    // フロアボス仕様: フロアボス、およびフロアボスのリポップ地点(origX/origZ)は牧場判定の
    // 対象外(柵で囲んでも牧場にならない)。既存の通常モンスターの牧場判定はそのまま。
    if (e.isBoss) continue;
    const posKey = Math.floor(e.mesh.position.x / L) + ',' + Math.floor(e.mesh.position.z / L);
    if (enc.cellSet.has(posKey)) return true;
    const origKey = Math.floor(e.origX / L) + ',' + Math.floor(e.origZ / L);
    if (enc.cellSet.has(origKey)) return true;
  }
  return false;
}
// 牧場ゾーンの判定をenclosuresから再計算し、矛盾する手動耕地データを破棄し、
// 牧場ゾーンの地面(茶色い土)を最新の状態に張り直す。柵の増改築・テイム・
// モンスターの死亡・ロードのたびに呼ぶ。
function updateRanchZones() {
  ranchZoneCellSet = new Set();
  for (const enc of enclosures) {
    if (enclosureIsRanchZone(enc)) {
      for (const ck of enc.cellSet) ranchZoneCellSet.add(ck);
    }
  }
  // 過去のデータとの矛盾解消: 牧場ゾーンと判定されたマスに手動耕地が
  // 残っていたら、新しい定義(牧場ゾーン優先)に従って撤去する。
  if (farmlands.length) {
    const toRemove = farmlands.filter(fl => {
      const { a, b } = farmlandCellOf(fl.x, fl.z);
      return ranchZoneCellSet.has(farmlandCellKey(a, b));
    });
    for (const fl of toRemove) {
      scene.remove(fl.mesh); disposeMesh(fl.mesh);
      const idx = farmlands.indexOf(fl);
      if (idx >= 0) farmlands.splice(idx, 1);
      const { a, b } = farmlandCellOf(fl.x, fl.z);
      filledFarmlandCells.delete(farmlandCellKey(a, b));
    }
    if (toRemove.length) updatePotionBar();
  }
  // 牧場ゾーンの地面(茶色い土)を張り直す
  clearRanchZoneVisualization();
  const L = CONFIG.fenceLength;
  for (const cellStr of ranchZoneCellSet) {
    const [a, b] = cellStr.split(',').map(Number);
    const cx = (a + 0.5) * L, cz = (b + 0.5) * L;
    const mesh = makeFarmlandMesh(L, cx, cz);
    mesh.position.set(cx, heightAt(cx, cz) + 0.03, cz);
    scene.add(mesh);
    ranchZoneMeshes.push(mesh);
  }
}
// 飼育対象のモンスターをテイムし、対応する牧場(なければ新規作成)に加える
function tameEnemy(e, enc) {
  const ranch = findOrCreateRanch(enc, e.type);
  ranch.count++;
  e.tamed = true; e.aggro = false; e.enclosedTimer = 0;
  e.wanderHome = { x: e.mesh.position.x, z: e.mesh.position.z };
  e.wanderTarget = null;
  e.ranchId = ranch.id;
  if (e.enclosedMark) e.enclosedMark.visible = false;
  if (e.tamedMark) e.tamedMark.visible = true;
  if (e.hpBar) e.hpBar.visible = false;
  if (ranch.entities.length < CONFIG.ranchVisualCap) {
    ranch.entities.push(e);
  } else {
    // 表示上限を超えた分は見た目のメッシュを消し、頭数(ranch.count)だけで管理する
    scene.remove(e.mesh); disposeMesh(e.mesh);
    const idx = enemies.indexOf(e);
    if (idx >= 0) enemies.splice(idx, 1);
  }
  showToast(`🐾 ${monsterDisplayName(e.type)}を飼いならした！(牧場 ${ranch.count}匹)`, 2800);
  updateRanchZones(); // 新規テイムで牧場ゾーンが増えた場合も地面表示を同期
}
// Phase4: 囲いの中に居続けた飼育対象モンスターを自動的にテイムする(捕獲条件)
function updateTaming(dt) {
  for (const e of enemies) {
    if (!e.alive || e.tamed) continue;
    const def = MONSTER_DEFS[e.type];
    if (!def || !def.tamable || e.isBoss) { e.enclosedTimer = 0; continue; } // ボスや非飼育種は対象外
    const enc = enclosureAt(e.mesh.position.x, e.mesh.position.z);
    if (enc) {
      e.enclosedTimer = (e.enclosedTimer || 0) + dt;
      if (e.enclosedTimer >= CONFIG.tameStaySec) tameEnemy(e, enc);
    } else {
      e.enclosedTimer = 0;
    }
  }
}
// Phase5: 牧場ごとに繁殖判定・素材の蓄積を行う
function spawnRanchLivestock(r) {
  const L = CONFIG.fenceLength;
  const cellStr = r.cellsArr[Math.floor(Math.random() * r.cellsArr.length)];
  const [a, b] = cellStr.split(',').map(Number);
  const x = (a + 0.5) * L, z = (b + 0.5) * L;
  const statsCfg = { hp: 20, atk: 5, def: 5, speed: 0.4, atkIntervalSec: 1.5, ranged: false, range: 0 };
  const baby = spawnEnemy(x, z, statsCfg, false, r.type);
  baby.tamed = true; baby.aggro = false;
  baby.wanderHome = { x, z }; baby.ranchId = r.id;
  if (baby.enclosedMark) baby.enclosedMark.visible = false;
  if (baby.tamedMark) baby.tamedMark.visible = true;
  if (baby.hpBar) baby.hpBar.visible = false;
  r.entities.push(baby);
}
function updateRanches(dt) {
  for (const r of ranches) {
    // 依頼により、家畜化したモンスターが増加する(繁殖する)仕様は一旦停止中。
    // CONFIG.ranchBreedingEnabledがfalseの間はbreedTimerも進めず、繁殖判定を
    // 一切行わない(=家畜の頭数はテイムした時のまま変わらない)。
    if (!CONFIG.ranchBreedingEnabled) continue;
    const capacity = Math.max(1, r.cellsArr.length); // 囲いの広さ(マス数)がそのまま収容上限の目安になる
    r.breedTimer += dt;
    if (r.breedTimer >= CONFIG.ranchBreedIntervalSec) {
      r.breedTimer = 0;
      if (r.count < capacity && Math.random() < CONFIG.ranchBreedChance) {
        r.count++;
        if (r.entities.length < CONFIG.ranchVisualCap) spawnRanchLivestock(r);
        showToast(`🐣 牧場で${monsterDisplayName(r.type)}が繁殖した！(${r.count}匹)`, 2400);
      }
    }
    // ゲーム内時間システム(姫歴)仕様6: 素材の蓄積はもう行わない。剥ぎ取りは
    // 「ゲーム時間1日に1回」だけ可能で、可否はr.nextHarvestAtとの比較で都度判定する
    // (ranchHarvestReady()。実際の付与はranchHarvestBtnのクリック処理で行う)。
  }
}
// 牧場(囲い)に入った時に表示する収穫プロンプトの状態管理
let nearbyRanches = [];
function updateRanchProximity() {
  const ranchPromptEl2 = document.getElementById('ranchPrompt');
  if (!player) { ranchPromptEl2.style.display = 'none'; nearbyRanches = []; return; }
  const enc = enclosureAt(player.position.x, player.position.z);
  if (!enc) { ranchPromptEl2.style.display = 'none'; nearbyRanches = []; return; }
  const sig = cellSetSignature(enc.cellSet);
  nearbyRanches = ranches.filter(r => r.cellKey === sig);
  if (nearbyRanches.length === 0) { ranchPromptEl2.style.display = 'none'; return; }
  // ゲーム内時間システム(姫歴)仕様6: 剥ぎ取りは「ゲーム時間1日に1回」。
  // 準備できている牧場だけを対象に、収穫予定量(頭数分)を合計して表示する。
  const readyRanches = nearbyRanches.filter(ranchHarvestReady);
  const totalReady = readyRanches.reduce((s, r) => s + r.count * CONFIG.ranchHarvestPerHead, 0);
  const summary = nearbyRanches.map(r => `${monsterDisplayName(r.type)}${r.count}匹`).join(' / ');
  document.getElementById('ranchPromptText').textContent = `🐾 牧場: ${summary}`;
  const btn = document.getElementById('ranchHarvestBtn');
  btn.disabled = readyRanches.length === 0;
  if (readyRanches.length > 0) {
    btn.textContent = `収穫(${totalReady})`;
  } else {
    // 次に収穫できるのは「次の朝」から(睡眠で朝になれば収穫できる)
    btn.textContent = nearbyRanches.some(r => r.count > 0) ? '収穫は明日の朝から' : '収穫';
  }
  ranchPromptEl2.style.display = 'flex';
}

/* --- 牧場・コレクションメニュー(Phase4-6: 飼育状況・収穫素材・レアドロップ収集の確認) --- */
const ranchModal = document.getElementById('ranchModal');
const ranchBody = document.getElementById('ranchBody');
function renderRanchModal() {
  let html = '<div class="shopSectionTitle">🐾 牧場で収穫できる素材</div>';
  const tamableDefs = Object.values(MONSTER_DEFS).filter(d => d.tamable);
  tamableDefs.forEach(d => {
    html += `<div class="shopItemRow"><div class="itemInfo"><span>${d.material.icon} ${d.material.name}</span></div><span>${inventory[d.material.key] || 0} / ${CONFIG.materialMax}</span></div>`;
  });

  html += '<div class="shopSectionTitle">飼育中の牧場</div>';
  if (ranches.length === 0) {
    html += '<div class="statRow"><span>まだ何も飼育していません。柵で囲ってモンスターを閉じ込め、しばらく(約' + CONFIG.tameStaySec + '秒)待つと懐きます。</span></div>';
  } else {
    ranches.forEach(r => {
      const capacity = Math.max(1, r.cellsArr.length);
      const readyText = ranchHarvestReady(r) ? '収穫可能' : (r.count > 0 ? '収穫済み(次の朝から収穫可能)' : '飼育中の家畜なし');
      html += `<div class="shopItemRow"><div class="itemInfo"><span>${monsterDisplayName(r.type)}の牧場</span><small>${r.count} / ${capacity}匹 ・ ${readyText}</small></div></div>`;
    });
  }

  html += '<div class="shopSectionTitle">💎 レアコレクション(ボス討伐)</div>';
  html += `<div class="shopItemRow"><div class="itemInfo"><span>✨ レア素材</span></div><span>${inventory.rareMaterial || 0}</span></div>`;
  if (rareWeapons.length === 0 && legendaryItems.length === 0) {
    html += '<div class="statRow"><span>フロアボスを倒すと、確率でレア武器や伝説級アイテムが手に入ります。</span></div>';
  }
  rareWeapons.forEach(w => {
    const equipped = equippedRareWeaponId === w.id;
    html += `<div class="shopItemRow"><div class="itemInfo"><span>⚔️ ${w.name}</span><small>攻撃力+${w.atk}(${w.source ? w.source : 'F' + w.floor + 'ボスドロップ'})</small></div>
      ${equipped ? '<span class="equippedTag">装備中</span>' : `<button class="shopBuyBtn" data-rareweapon="${w.id}">装備</button>`}</div>`;
  });
  legendaryItems.forEach(it => {
    html += `<div class="shopItemRow"><div class="itemInfo"><span>${it.icon} ${it.name}</span><small>伝説級・${it.source ? it.source : 'F' + it.floor + 'ボスドロップ'}</small></div></div>`;
  });

  html += '<div class="shopSectionTitle">🔁 討伐記録(周回)</div>';
  const floorKeys = Object.keys(bossDefeatCount).map(Number).sort((a, b) => a - b);
  if (floorKeys.length === 0) {
    html += '<div class="statRow"><span>まだフロアボスを倒していません</span></div>';
  } else {
    floorKeys.forEach(fl => {
      html += `<div class="statRow"><span>F${fl} ${bossDisplayName(getFloorDef(fl).type)}撃破回数</span><span>${bossDefeatCount[fl]}回</span></div>`;
    });
  }

  ranchBody.innerHTML = html;
  ranchBody.querySelectorAll('[data-rareweapon]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = +btn.dataset.rareweapon;
      equippedRareWeaponId = (equippedRareWeaponId === id) ? null : id; // タップで装備/解除をトグル
      updateRewardHud();
      renderRanchModal();
    });
  });
}
function openRanchModal() {
  renderRanchModal();
  modalBackdrop.style.display = 'block';
  ranchModal.style.display = 'flex';
}
document.getElementById('ranchBtn').addEventListener('click', openRanchModal);
document.getElementById('ranchCloseBtn').addEventListener('click', closeAllModals);
document.getElementById('ranchHarvestBtn').addEventListener('click', () => {
  const got = [];
  nearbyRanches.forEach(r => {
    if (!ranchHarvestReady(r)) return; // ゲーム時間1日ぶんのクールダウンが明けていない牧場はスキップ
    const amount = r.count * CONFIG.ranchHarvestPerHead;
    const def = MONSTER_DEFS[r.type];
    if (def && def.material && amount > 0) {
      inventory[def.material.key] = Math.min(CONFIG.materialMax, (inventory[def.material.key] || 0) + amount);
      got.push(`${def.material.icon}+${amount}`);
    }
    // 剥ぎ取った時刻を記録し、次回剥ぎ取り可能になる時刻(次の朝6:00)を設定する
    ranchMarkHarvested(r);
  });
  if (got.length && player) {
    spawnFloatingText(player.position, got.join(' '), '#ffe37a');
    showToast('🐾 牧場から素材を収穫した', 1800);
    updatePotionBar();
    updateRanchProximity();
  }
});
