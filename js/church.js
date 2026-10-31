/* ---------------------------------------------------------------------
   教会(js/church.js) ― 教会機能追加.md への対応

   このファイルが追加する機能:
   ・教会は周囲すべてが壁扱いになり、他の建物と同じく歩いて通り抜けたり
     中に入り込んだりできなくなる(修正前は建物に当たり判定が一切なく、
     どの建物にも歩いて重なれてしまっていた)。
   ・教会に近づくと「🚪 教会のトビラ」プロンプトが出る。ボタンを押すと、
     3Dモデルの奥へ歩いて入るのではなく、添付いただいた1枚絵
     (images/church_interior.png)を画面いっぱいに表示する「内部シーン」に
     切り替わる。絵を差し替えたい場合はimages/church_interior.pngを
     置き換えるだけでよい(パスやCSSは変更不要)。
   ・内部シーンの中央には絵の中の「移動石」に重なる透明なタップ範囲があり、
     押すとフロア選択パネルが開く。
   ・フロア移動には「安全地帯」ルールがある: 移動元(今いるフロア)か
     移動先のどちらかが「クリア済み(=一度でも安全地帯を達成したことがある)」
     フロアであること。安全地帯 = そのフロアのボス・ザコモンスターの
     湧き座標(全16箇所)が全て柵で囲われている状態。
     この「クリア済みかどうか」はフロアごとに個別に記録する(floorCleared、
     game.html側で宣言・セーブデータにも保存)。湧き座標自体は全フロア共通の
     固定座標だが、実際にそのフロアをアクティブにして安全地帯を確認できた
     時だけ、そのフロア番号がクリア済みとして記録される。つまり「全フロア
     クリア」には、全フロアそれぞれを実際に安全地帯にする必要がある。
   ・上記に伴い、フロアボスを倒しただけではフロアクリアにならない
     (game.html側のonBossDefeatedのメッセージ変更、および階段の
     上る/下るボタンも同じ安全地帯ルールでガードする形にした)。

   本編(game.html)で定義される CONFIG / player / buildings / CHURCH_POS /
   currentFloor / floorCleared / startFloor / showToast / isPositionEnclosed /
   getAllMonsterSpawnPoints / closeAllModals 等をそのまま利用するため、
   このファイルは game.html 本編の <script> より後に読み込む必要がある。
--------------------------------------------------------------------- */

/* ---------- 教会の壁(当たり判定) ----------
   建物全周を塞ぐと、セーブ/ロード後に勇者が戻ってくる場所
   (CHURCH_POS.x, CHURCH_POS.z+1.5 / game.html「15.教会でのセーブ/ロード」参照)
   自体が壁の中に入ってしまい、勇者が一歩も動けなくなる不具合になるため、
   トビラの方向(+z側=建物の正面。ちょうどセーブ/ロード後の立ち位置と同じ向き)だけは
   壁を素通りできるようにする。 */
CONFIG.churchWallRadius = 2.3; // 壁の当たり判定半径(トビラ方向以外)
CONFIG.churchDoorHalfAngleDeg = 40; // トビラの開口角度(+z方向=正面を0度とした片側の角度)
function collidesWithChurchWall(x, z) {
  const dx = x - CHURCH_POS.x, dz = z - CHURCH_POS.z;
  const dist = Math.hypot(dx, dz);
  if (dist >= CONFIG.churchWallRadius) return false; // 壁の外側
  const angleDeg = Math.atan2(dx, dz) * 180 / Math.PI; // +z方向(建物の正面)を0度とする
  if (Math.abs(angleDeg) <= CONFIG.churchDoorHalfAngleDeg) return false; // トビラの方向は素通りできる
  return true; // それ以外の壁面は進入禁止
}

/* ---------- トビラに近づくと「入る」ボタンを表示する ---------- */
CONFIG.churchDoorInteractRadius = 3.5;
const churchDoorPromptEl = document.getElementById('churchDoorPrompt');
function updateChurchDoorProximity() {
  if (!player) { churchDoorPromptEl.style.display = 'none'; return; }
  const d = Math.hypot(player.position.x - CHURCH_POS.x, player.position.z - CHURCH_POS.z);
  churchDoorPromptEl.style.display = d < CONFIG.churchDoorInteractRadius ? 'flex' : 'none';
  checkSafeZoneClearNotification(); // ついでに安全地帯の達成チェックも行う(専用の毎フレーム処理を増やさないため)
}

/* ---------- 教会内部シーン(1枚絵 + 移動石) ---------- */
const churchInteriorOverlay = document.getElementById('churchInteriorOverlay');
const churchFloorPanel = document.getElementById('churchFloorPanel');
const churchFloorList = document.getElementById('churchFloorList');
const churchFloorHint = document.getElementById('churchFloorHint');

function openChurchInterior() {
  churchFloorPanel.style.display = 'none';
  churchInteriorOverlay.style.display = 'block';
  // 睡眠・空腹度仕様: 夜(ゲーム内18:00〜翌6:00)に教会へ入ると、そのまま眠って翌朝6時に起きる
  // (js/survival.js)。昼間に入った場合は何も起きず、従来どおり移動石・セーブ/ロードなどが使える。
  if (typeof Survival !== 'undefined') Survival.onChurchEnter();
}
function closeChurchInterior() {
  churchInteriorOverlay.style.display = 'none';
  churchFloorPanel.style.display = 'none';
  churchBonusPanel.style.display = 'none';
}

/* ---------------------------------------------------------------------
   教会内部の勇者表示について(PNG方式へ変更)
   教会内部では3D(WebGL/Three.js)の勇者を重ね描きせず、勇者が描き込まれた
   完成済みの1枚絵(images/church_interior_hero.png)だけを表示する。
   教会専用のCanvas/Renderer/Scene/GLB cloneは廃止した。

   ※下のcloneHeroModelSafelyは教会以外(js/villager.jsの領民GLB複製)でも
     使っている共有関数なので削除しないこと。
--------------------------------------------------------------------- */
function cloneHeroModelSafely(source) {
  if (window.THREE && THREE.SkeletonUtils && typeof THREE.SkeletonUtils.clone === 'function') {
    return THREE.SkeletonUtils.clone(source);
  }
  console.warn('THREE.SkeletonUtilsが読み込めなかったため、通常のcloneで代用します(アニメーションが正しく動かない場合があります)。');
  return source.clone(true);
}
document.getElementById('churchEnterBtn').addEventListener('click', openChurchInterior);
document.getElementById('churchInteriorCloseBtn').addEventListener('click', closeChurchInterior);
document.getElementById('churchFloorCloseBtn').addEventListener('click', () => {
  churchFloorPanel.style.display = 'none';
});

/* ---------- 仕様⑤: 紫水晶の「レベルアップボーナス」画面 ----------
   レベルアップで貯まったunspentPoints(js/status.js)をVIT/ATK/DEF/INT/AGIへ
   振り分ける画面。表示内容・操作感はメイン画面の旧ステータス画面
   (game.html側のstatusModal/renderStatusModal)と同じにしてあるが、
   実装は別関数にしてある(statusModalはgame.html本編のDOM要素で、教会の
   1枚絵オーバーレイの内側には重ねられないため)。STAT_LABELS/heroStats/
   playerATK()/playerDEF()/allocatePoint()はいずれもjs/status.jsのグローバルを
   共有で使う。 */
const churchBonusPanel = document.getElementById('churchBonusPanel');
const churchBonusBody = document.getElementById('churchBonusBody');
const churchBonusOpenBtn = document.getElementById('churchBonusOpenBtn');

function renderChurchBonusPanel() {
  const frames = Math.max(10, 30 - heroStats.agi);
  let html = `<div class="statRow"><span>Lv.${playerLevel} ／ 振り分け可能: <b>${unspentPoints}</b></span></div>`;
  if (unspentPoints <= 0) {
    html += `<div class="statRow"><span>使用できるボーナスポイントはありません</span></div>`;
  }
  Object.keys(STAT_LABELS).forEach(k => {
    html += `<div class="statRow"><span>${STAT_LABELS[k]}: ${heroStats[k]}</span>
      <button class="statPlus" data-stat="${k}" ${unspentPoints <= 0 ? 'disabled' : ''}>+</button></div>`;
  });
  html += `<div class="statRow"><span>HP上限</span><span>${hpMax}</span></div>`;
  html += `<div class="statRow"><span>MP上限</span><span>${mpMax}</span></div>`;
  html += `<div class="statRow"><span>ATK(武器込み)</span><span>${playerATK()}</span></div>`;
  html += `<div class="statRow"><span>DEF(防具込み)</span><span>${playerDEF()}</span></div>`;
  html += `<div class="statRow"><span>攻撃間隔</span><span>${frames}フレーム(約${(frames/60).toFixed(2)}秒)</span></div>`;
  churchBonusBody.innerHTML = html;
  churchBonusBody.querySelectorAll('.statPlus').forEach(btn => {
    btn.addEventListener('click', () => {
      const stat = btn.dataset.stat;
      if (!allocatePoint(stat)) return; // js/status.js: データの更新のみ行い、成否を返す
      if (stat === 'vit') hp += 10; // 現在のHP/MPへの加算はこれまでどおり呼び出し元で行う
      if (stat === 'int') mp += 10;
      updateBars();
      updateStatusBadge();
      renderChurchBonusPanel();
    });
  });
}
function openChurchBonusPanel() {
  churchFloorPanel.style.display = 'none';
  renderChurchBonusPanel();
  churchBonusPanel.style.display = 'flex';
}
function closeChurchBonusPanel() {
  churchBonusPanel.style.display = 'none';
  churchFloorPanel.style.display = 'flex'; // 「戻る」: 移動石のコマンド一覧に戻る
}
churchBonusOpenBtn.addEventListener('click', openChurchBonusPanel);
document.getElementById('churchBonusCloseBtn').addEventListener('click', closeChurchBonusPanel);

/* ---------- 「安全地帯」判定 & フロアごとのクリア記録 ----------
   仕様: 今いるフロアの「ボス及びザコモンスタを全て柵で囲いきる」ことが、
   そのフロア自身のクリア条件。そして「全フロアのクリア」には、全フロア
   それぞれについてこれを達成する必要がある(=シェアされた湧き座標を
   1回だけ囲っても、まだ一度も訪れていない他フロアは自動ではクリア扱いに
   ならない。実際にそのフロアをアクティブにして安全地帯を確認できた時点で、
   初めてそのフロアがクリア済みとしてfloorCleared(game.html側で宣言/
   セーブデータに保存)に記録される)。

   isDungeonSafeZone(): 「今アクティブなフロアの湧き座標(全16箇所。ザコ5
   グループ×3体+フロアボス1体、getAllMonsterSpawnPoints()参照)が全て
   柵で囲われているか」をその場でライブ判定する。このゲームでは湧き座標が
   フロア番号によらず共通の固定座標なので、この判定式そのものは常に同じだが、
   「今どのフロアがアクティブか(=currentFloor)」によって、その結果が
   "どのフロアの記録として"floorClearedに書き込まれるかが変わる。 */
function isDungeonSafeZone() {
  return getAllMonsterSpawnPoints().every(p => isPositionEnclosed(p.x, p.z));
}
// フロアfloorNumが(過去に一度でもアクティブな状態で安全地帯を達成し)クリア済みか。
function isFloorSafeZone(floorNum) {
  return !!floorCleared[floorNum];
}
// 移動元(今いるフロア)か移動先のどちらかがクリア済み(安全地帯)であれば移動できる。
function canTravelToFloor(targetFloor) {
  return isFloorSafeZone(currentFloor) || isFloorSafeZone(targetFloor);
}
function maxFloorNumber() {
  return CONFIG.floors.length - 1; // index0は未使用
}
function isEveryFloorCleared() {
  for (let f = 1; f <= maxFloorNumber(); f++) {
    if (!floorCleared[f]) return false;
  }
  return true;
}

/* 今のフロアで初めて安全地帯を達成した瞬間に、そのフロアをクリア済みとして
   記録し(floorCleared、セーブデータにも保存される)、通知する。
   全フロア分クリアし終えた瞬間にも、別途まとめて通知する。 */
let allFloorsClearedAchievedBefore = false;
function checkSafeZoneClearNotification() {
  if (!floorCleared[currentFloor] && isDungeonSafeZone()) {
    floorCleared[currentFloor] = true;
    showToast(`🎉 ${currentFloor}階クリア!(全モンスターを柵で囲い安全地帯を達成。教会の移動石でここへ行き来できる)`, 4000);
  }
  const allCleared = isEveryFloorCleared();
  if (allCleared && !allFloorsClearedAchievedBefore) {
    showToast('🏆 全フロアクリア!教会の移動石でどのフロアへも自由に行き来できる', 4200);
  }
  allFloorsClearedAchievedBefore = allCleared;
}

/* ---------- 移動石クリックでフロア選択パネルを開く ---------- */
function renderChurchFloorPanel() {
  const maxFloor = maxFloorNumber();
  const originCleared = isFloorSafeZone(currentFloor);
  churchFloorHint.textContent = originCleared
    ? '✨ このフロアは安全地帯です。どのフロアへも移動できます。'
    : '⚠️ このフロアはまだ安全地帯ではありません(クリア済みのフロアへだけ移動できます)';
  let html = '';
  for (let f = 1; f <= maxFloor; f++) {
    const isCurrent = f === currentFloor;
    const cleared = isFloorSafeZone(f);
    const canGo = isCurrent || canTravelToFloor(f);
    const mark = cleared ? '✅' : '🔒';
    html += `<button class="churchFloorBtn${isCurrent ? ' churchFloorCurrent' : ''}" data-floor="${f}" ${(!canGo || isCurrent) ? 'disabled' : ''}>${mark} ${f}階${isCurrent ? '(現在地)' : ''}</button>`;
  }
  churchFloorList.innerHTML = html;
  churchFloorList.querySelectorAll('[data-floor]').forEach(btn => {
    btn.addEventListener('click', () => travelToFloor(+btn.dataset.floor));
  });
}
function openChurchFloorPanel() {
  churchCallVillagerMsg.textContent = '';
  renderChurchFloorPanel();
  updateStatusBadge(); // 「⭐ レベルアップボーナス」ボタンのバッジを最新の未振り分けポイント数に更新
  churchFloorPanel.style.display = 'flex';
}
document.getElementById('churchCrystalHotspot').addEventListener('click', openChurchFloorPanel);

function travelToFloor(floorNum) {
  if (floorNum === currentFloor) return;
  if (!canTravelToFloor(floorNum)) {
    showToast('⚠️ 安全地帯にならないと移動できません', 2600);
    return;
  }
  closeChurchInterior();
  startFloor(floorNum);
  showToast(`⛪ 移動石で${floorNum}階へ移動した`, 2400);
}

/* ---------- 領民を呼び寄せる(紫水晶のコマンド) ----------
   以前は建築画面(js/guesthouse.js)のゲストハウス欄にあったボタンの移設。
   生成・入居処理は既存のcallVillagerToGuesthouse(js/villager.js)をそのまま使い、
   「現在いるフロア(currentFloor)」のゲストハウスだけを対象にする。
   定員判定も既存のgh.capacity/CONFIG.guesthouse.capacityと同じ式を使う。
   callVillagerToGuesthouseは同期処理で、内部で定員を確認してから1体だけ生成するため、
   連打しても定員を超えたり二重生成されたりしない。 */
const churchCallVillagerMsg = document.getElementById('churchCallVillagerMsg');
function churchCallVillager() {
  const setMsg = t => { churchCallVillagerMsg.textContent = t; };
  // 安全地帯(クリア済み)になったフロアでだけ領民を呼べる。既存のisFloorSafeZoneを再利用し、未達成なら何も変更せず終了する
  if (!isFloorSafeZone(currentFloor)) { setMsg('このフロアはまだ安全地帯ではありません'); return; }
  const houses = guestHouses.filter(gh => gh.floor === currentFloor);
  if (!houses.length) { setMsg('このフロアにはゲストハウスがありません'); return; }
  const target = houses.find(gh => gh.residents.length < (gh.capacity || CONFIG.guesthouse.capacity));
  if (!target) { setMsg('このフロアのゲストハウスは満室です'); return; }
  const before = target.residents.length;
  callVillagerToGuesthouse(target);
  setMsg(target.residents.length > before
    ? '🧑‍🌾 領民がゲストハウスへやってきた'
    : 'このフロアのゲストハウスは満室です');
}
document.getElementById('churchCallVillagerBtn').addEventListener('click', churchCallVillager);
