/* ---------------------------------------------------------------------
   領民(js/villager.js)
   「ゲストハウス・領民システム安全実装プロンプト」Phase 2〜4 に、
   「領民・メイドAIの生活／担当地区仕様への安全変更プロンプト」を反映した版。

   【領民の生活(今回の仕様)】
   ・領民は「呼び出されたフロア(v.floor)」から出ない。v.floorは生成時にゲストハウスの
     フロアで固定され、現在表示中のフロア(currentFloor)とは別の値として扱う。
   ・領民は「既存の一意ID(v.id)」「所属フロア(v.floor)」「フロア内番号(v.no)」を別々に持つ。
     フロア内番号は、そのフロアで1から振る(使われていない最小の番号)。
   ・マップ(±CONFIG.band.mountain)を横5×縦5の25地区に分割し、フロア内番号順に
     (0,0)(1,0)(2,0)(3,0)(4,0)(0,1)… の地区を担当する(26人目以降は先頭へ戻り、
     同じ地区を複数の領民が担当する)。
   ・昼(ゲーム内6:00以上18:00未満): 担当地区の農地→牧場の順に仕事を探し、
     「対象を選ぶ→A*で実際に歩く→到着確認→その場で作業」の順にだけ作業する。
     仕事が無ければ担当地区を実際に歩いて徘徊する。
   ・夜(18:00以上6:00未満): 自分のゲストハウスの入口まで実際に歩いて帰り、中で待機する。
     朝になったら入口から出て担当地区へ向かう。
   ・勇者への追従は廃止した(勇者の近くで待機する/追いかける処理は無い)。
   ・ワープ禁止: 領民の位置は updateVillagerWalk の「1フレーム分の移動量(速度×dt)」でしか
     変わらない(生成・ロード時の初期配置を除く)。仕事の実行(villagerExecuteWork)は
     WORKING状態で、目的地への到着を距離で再確認した後にだけ呼ばれる。

   【状態】(v.walk.mode。歩行状態はセーブしない)
     HOME(ゲストハウス内で待機) / WORK_SEARCH(担当地区の仕事を探す) /
     GO_TO_WORK(仕事場所へ歩く) / WORKING(到着後の作業) /
     WANDER(担当地区を歩いて徘徊) / GO_HOME(ゲストハウスへ歩いて帰る)

   【Phase2: ryou.glbと領民表示】
   領民モデル(ryou.glb)は、勇者・メイドと同じ方式(index.htmlでユーザーが選択
   →TransferDB(IndexedDB)経由でgame.htmlへ引き継ぐ)で受け取る。ゲーム本体への
   Base64固定埋め込みは行わない(TransferDBに無ければ、簡易な代用メッシュで表示する)。
   既存の勇者GLB・メイドGLBの読み込み方式は一切変更しない。

   【メイドとの担当分離(Phase4を変更)】
   以前は「領民がいるフロアではメイドが農地・牧場を管理しない」という全体停止だったが、
   今回は廃止した。代わりに、既存のメイドの予約(_maidReserved)と同じ形の
   領民の予約(fl._villagerReserved / r._villagerReserved)を追加し、
   ・領民は、メイドが予約中(_maidReserved)の管理対象を選ばない
   ・メイドは、領民が予約中(_villagerReserved)の管理対象を選ばない
   という対象単位の排他だけにした(js/maid-ai.jsの候補選び3か所に1行ずつ)。

   【経路探索】js/maid-ai.js の maidFindPath()(A*)を読み取り専用で再利用する。
   家畜化モンスター(e.tamed === true)は領民の移動の障害物にしない(villagerLocalBlocked)。

   CONFIG / scene / heightAt / player / inventory / playerGold / CROPS / getCropDef /
   MONSTER_DEFS / farmlands / ranches / computeCropStage / isWateredToday / waterCrop /
   harvestCrop / plantCrop / ranchHarvestReady / currentGameDayIndex / computeGameClock /
   showToast / updateRewardHud / disposeMesh / THREE / TransferDB /
   isFloorSafeZone(js/church.js) / guestHouses(js/guesthouse.js) など、
   game.html本編・js/church.js・js/farmland.js・js/ranch.js・js/guesthouse.js・
   js/maid-ai.jsで定義されるグローバルを利用するため、このファイルは
   <script src="js/villager.js"> をそれらすべてより後に読み込む必要がある。
--------------------------------------------------------------------- */

CONFIG.villager = {
  taxRate: 0.5,            // 領民の農協・牧場素材の売上のうち、勇者へ支払われる割合
  districtCols: 5,         // 担当地区の分割数(横)
  districtRows: 5,         // 担当地区の分割数(縦)
  dayStartHour: 6,         // ゲーム内時計でこの時以上が「昼」
  nightStartHour: 18,      // ゲーム内時計でこの時以上が「夜」(次の朝6時未満まで)
  upkeepPerMonth: 30,      // 変更6: 領民1人あたりの維持費(ゲーム内1ヶ月ごと、G)
  upkeepMaxCatchUpMonths: 3, // 変更6: ゲームを閉じている間などに複数ヶ月が経過していた場合、まとめて請求する最大月数(それ以上は請求せず基準月だけ進める)
};

let villagers = [];        // [{ id, guestHouseId, floor, no, x, z, group, inside, walk }]
let villagerIdCounter = 1;
let villagerGlbTemplateModel = null; // ryou.glb読み込み成功時の正規化済みテンプレート(SkeletonUtils.cloneで複製して使う)

/* ---------------------------------------------------------------------
   Phase2: ryou.glbの読み込み(勇者/メイドと同じ正規化ロジックを流用)
--------------------------------------------------------------------- */
function initVillagerGlbTemplate(buffer) {
  return new Promise((resolve) => {
    if (!buffer) { villagerGlbTemplateModel = null; resolve(); return; }
    try {
      const loader = new THREE.GLTFLoader();
      loader.parse(buffer, '', (gltf) => {
        try {
          const model = gltf.scene;
          // 既存のloadPlayer/applyUserGlbBufferと同じ正規化(身長を合わせ、足元をy=0に揃える)
          const box = new THREE.Box3().setFromObject(model);
          const size = new THREE.Vector3(); box.getSize(size);
          const targetHeight = 1.7;
          const scale = size.y > 0 ? targetHeight / size.y : 1;
          model.scale.setScalar(scale);
          const box2 = new THREE.Box3().setFromObject(model);
          model.position.y -= box2.min.y;
          villagerGlbTemplateModel = model;
        } catch (e) {
          console.warn('領民GLBの正規化に失敗しました(簡易モデルで表示します):', e);
          villagerGlbTemplateModel = null;
        }
        resolve();
      }, (err) => {
        console.warn('領民GLBの読み込みに失敗しました(簡易モデルで表示します):', err);
        villagerGlbTemplateModel = null;
        resolve();
      });
    } catch (e) {
      console.warn('領民GLBの読み込み処理でエラーが発生しました(簡易モデルで表示します):', e);
      villagerGlbTemplateModel = null;
      resolve();
    }
  });
}

/* ---------- 表示(Phase2: 存在・表示・所属・保存) ---------- */
function makeVillagerFallbackMesh() {
  // ryou.glbが選ばれていない場合の簡易な代用表示(領民が「存在」していることは
  // 確認できるようにする)。勇者/メイドの見た目や当たり判定には一切影響しない。
  const group = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(0.26, 0.3, 1.05, 8),
    new THREE.MeshStandardMaterial({ color: 0x7a9d6f, flatShading: true })
  );
  body.position.y = 0.53;
  group.add(body);
  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.22, 8, 8),
    new THREE.MeshStandardMaterial({ color: 0xe0b98f, flatShading: true })
  );
  head.position.y = 1.18;
  group.add(head);
  return group;
}
function createVillagerVisual() {
  if (villagerGlbTemplateModel) {
    try {
      // js/church.js が教会内の勇者表示のために用意している安全なclone関数
      // (SkeletonUtils.cloneがあればそれを使い、無ければ通常cloneにフォールバックする)
      // をそのまま再利用する(同じロジックを増やさない)。
      if (typeof cloneHeroModelSafely === 'function') return cloneHeroModelSafely(villagerGlbTemplateModel);
      return villagerGlbTemplateModel.clone(true);
    } catch (e) {
      console.warn('領民モデルの複製に失敗しました(簡易モデルで表示します):', e);
    }
  }
  return makeVillagerFallbackMesh();
}
/* ---------------------------------------------------------------------
   時間帯(ゲーム内時計。js/game.htmlのcomputeGameClockをそのまま利用)
--------------------------------------------------------------------- */
function villagerGameHour() {
  // 睡眠・食事でゲーム内時計を進めた分(gameNow)も反映する
  return (typeof computeGameClock === 'function') ? computeGameClock((typeof gameNow === 'function') ? gameNow() : Date.now()).hour : 12;
}
// 昼: 6:00以上18:00未満 / 夜: 18:00以上、または6:00未満
function villagerIsDaytime() {
  const h = villagerGameHour();
  return h >= CONFIG.villager.dayStartHour && h < CONFIG.villager.nightStartHour;
}

/* ---------------------------------------------------------------------
   担当地区(縦5×横5の25地区)
   マップの座標系: 原点(0,0)が中央、x/zとも -mapHalf〜+mapHalf(CONFIG.mapHalf=50)。
   歩ける範囲は chebyshev(x,z) < CONFIG.band.mountain(=46)(isPassable)なので、
   その範囲(±46)を5×5に等分する(1地区=18.4×18.4)。
   地区番号は0始まりで、フロア内番号順に (0,0)(1,0)(2,0)(3,0)(4,0)(0,1)… と割り当てる
   (dx=横=x方向、dz=縦=z方向。dxが先に増える)。26人目以降は先頭の地区へ戻り、
   同じ地区を複数の領民が担当する(新しい地区は作らない)。
--------------------------------------------------------------------- */
function villagerDistrictCoord(no) {
  const cols = CONFIG.villager.districtCols, rows = CONFIG.villager.districtRows;
  const n = cols * rows;
  const idx = (Math.max(1, Math.floor(no) || 1) - 1) % n;
  return { dx: idx % cols, dz: Math.floor(idx / cols) };
}
function villagerDistrictBounds(no) {
  const cols = CONFIG.villager.districtCols, rows = CONFIG.villager.districtRows;
  const half = CONFIG.band.mountain;
  const w = (half * 2) / cols, h = (half * 2) / rows;
  const c = villagerDistrictCoord(no);
  const minX = -half + c.dx * w, minZ = -half + c.dz * h;
  return { dx: c.dx, dz: c.dz, minX, maxX: minX + w, minZ, maxZ: minZ + h };
}
// ワールド座標(x,z)が属する地区の番号(0始まり)。範囲外は端の地区へ丸める。
function villagerDistrictOfPoint(x, z) {
  const cols = CONFIG.villager.districtCols, rows = CONFIG.villager.districtRows;
  const half = CONFIG.band.mountain;
  const w = (half * 2) / cols, h = (half * 2) / rows;
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  return { dx: clamp(Math.floor((x + half) / w), 0, cols - 1), dz: clamp(Math.floor((z + half) / h), 0, rows - 1) };
}
function villagerPointInDistrict(no, x, z) {
  const c = villagerDistrictCoord(no), p = villagerDistrictOfPoint(x, z);
  return c.dx === p.dx && c.dz === p.dz;
}

/* ---------------------------------------------------------------------
   生成(フロア内番号・ゲストハウスの入口)
--------------------------------------------------------------------- */
// そのフロアで使われていない最小の番号(1から)
function villagerNextFloorNo(floor) {
  const used = new Set();
  villagers.forEach(v => { if (v.floor === floor) used.add(v.no); });
  let n = 1;
  while (used.has(n)) n++;
  return n;
}
function villagerInHouseFootprint(x, z, floor) {
  const H = CONFIG.villager.walk.houseHalf;
  for (const gh of guestHouses) {
    if (gh.floor !== floor) continue;
    if (Math.abs(x - gh.x) < H && Math.abs(z - gh.z) < H) return true;
  }
  return false;
}
// ゲストハウスの「入口」(建物の外側。夜はここまで歩いて帰り、朝はここから出てくる)。
// 正面(+z)側から順に、A*の目的地として使えるマス(中心が歩ける場所)を探す。
function villagerDoorPoint(gh) {
  const dirs = [[0, 1], [1, 0], [-1, 0], [0, -1]];
  const radii = [2.4, 3.0, 3.6];
  for (const strict of [true, false]) {
    for (const r of radii) {
      for (const d of dirs) {
        const x = gh.x + d[0] * r, z = gh.z + d[1] * r;
        if (!isPassable(x, z)) continue;
        if (villagerInHouseFootprint(x, z, gh.floor)) continue;
        const c = farmlandCellOf(x, z);
        if (!maidCellWalkable(c.a, c.b)) continue;
        if (strict) {
          const key = farmlandCellKey(c.a, c.b);
          if (filledFarmlandCells.has(key) || ranchZoneCellSet.has(key)) continue;
        }
        return { x, z };
      }
    }
  }
  return { x: gh.x, z: gh.z + CONFIG.villager.walk.houseHalf + 0.5 };
}
function villagerSavedPosOk(x, z, floor) {
  return Number.isFinite(x) && Number.isFinite(z) && isPassable(x, z) && !villagerInHouseFootprint(x, z, floor);
}
function spawnVillager(gh, opts) {
  opts = opts || {};
  let id = opts.id || villagerIdCounter++;
  if (villagers.some(o => o.id === id)) id = villagerIdCounter++; // 一意IDの重複は避ける
  villagerIdCounter = Math.max(villagerIdCounter, id + 1);
  const floor = gh.floor; // 呼び出されたフロア(以後変更しない)
  const no = (Number.isInteger(opts.no) && opts.no >= 1) ? opts.no : villagerNextFloorNo(floor);
  const door = villagerDoorPoint(gh);
  let x = door.x, z = door.z;
  const inside = opts.inside === true;
  if (!inside && villagerSavedPosOk(opts.x, opts.z, floor)) { x = opts.x; z = opts.z; } // ロード時は保存位置から再開(ワープさせない)
  const visual = createVillagerVisual();
  const group = new THREE.Group();
  group.add(visual);
  group.position.set(x, heightAt(x, z), z);
  group.visible = (floor === currentFloor) && !inside;
  scene.add(group);
  const villager = { id, guestHouseId: gh.id, floor, no, x, z, group, inside, walk: null };
  villagers.push(villager);
  if (!gh.residents.includes(id)) gh.residents.push(id);
  updateVillagerCountHud();
  return villager;
}
function callVillagerToGuesthouse(gh) {
  if (!gh) return;
  const cap = gh.capacity || CONFIG.guesthouse.capacity;
  if (gh.residents.length >= cap) { showToast('このゲストハウスは満室です', 1800); return; }
  spawnVillager(gh, {});
  showToast('🧑‍🌾 領民がゲストハウスへやってきた', 2000);
}
function clearAllVillagers() {
  [...villagers].forEach(v => { if (v.group) { scene.remove(v.group); disposeMesh(v.group); } });
  villagers.length = 0;
  updateVillagerCountHud();
}

/* ---------------------------------------------------------------------
   変更5: 現在の領民数のHUD表示(領民配列villagersの長さをそのまま表示する。別カウンターは持たない)
   増減する処理(spawnVillager / dismissVillager / clearAllVillagers)から呼ぶほか、
   updateVillagers()でも毎フレーム呼ぶ(文字列が変わった時だけDOMを書き換える)。
--------------------------------------------------------------------- */
function updateVillagerCountHud() {
  const el = document.getElementById('villagerCountText');
  if (!el) return;
  const text = `領民：${villagers.length}人`;
  if (el.textContent !== text) el.textContent = text;
}

/* ---------------------------------------------------------------------
   変更6: 領民1人だけを帰らせる(維持費が払えない時など)。
   これまで領民を1人だけ取り除く処理は無かったため(全員を消すclearAllVillagersのみ)、
   その1人分と同じ後始末(表示の削除・メモリ解放)に加えて、仕事の予約解除・ゲストハウスの
   居住者リストからの除外を行う。他の領民のフロア内番号(担当地区)は変更しない。
   フロアの領民が0人になれば、hasVillagersOnFloor()がfalseになり、メイドは自動的に仕事を再開する。
--------------------------------------------------------------------- */
function dismissVillager(v) {
  const idx = villagers.indexOf(v);
  if (idx < 0) return false;
  if (v.walk) { try { villagerReleaseWork(v, v.walk, false); } catch (e) { /* 予約解除に失敗しても帰還処理は続ける */ } v.walk = null; }
  if (v.group) { scene.remove(v.group); disposeMesh(v.group); }
  villagers.splice(idx, 1);
  const gh = guestHouses.find(g => g.id === v.guestHouseId);
  if (gh && Array.isArray(gh.residents)) gh.residents = gh.residents.filter(rid => rid !== v.id);
  updateVillagerCountHud();
  return true;
}

/* ---------------------------------------------------------------------
   変更6: 領民の維持費(1人につき月30G。ゲーム内=姫歴の「月」が変わるごとに1回だけ処理)
   ・月の判定は姫歴の年・月(computeHimeReki)から作る通し月番号。現実時間ではなくゲーム内の月が基準。
   ・「最後に維持費を処理した月」(villagerUpkeepLastMonth)を記録し、処理する前に先に更新するので
     同じ月を二重に処理しない。
   ・領民を配列の順に1人ずつ維持する: 払えるだけ払い、払えない領民は帰る(dismissVillager)。
   ・旧セーブ/新規ゲームなど記録が無い時は、請求せず基準月だけを現在の月に合わせる。
   ・複数ヶ月が経過していた場合は1ヶ月ずつ順番に処理するが、請求するのは最大
     CONFIG.villager.upkeepMaxCatchUpMonths(=3)ヶ月分まで(不自然な大量請求を避ける)。
--------------------------------------------------------------------- */
let villagerUpkeepLastMonth = null; // 最後に維持費を処理したゲーム内の通し月番号(null=記録なし)
let villagerUpkeepTimer = 0;
function villagerCurrentMonthIndex() {
  if (typeof GameTime === 'undefined' || !GameTime.gameEpoch0 || typeof computeHimeReki !== 'function') return null;
  const cal = computeHimeReki(GameTime.gameEpoch0, (typeof gameNow === 'function') ? gameNow() : Date.now());
  return (cal.year - 1) * 12 + (cal.month - 1);
}
function processVillagerUpkeep() {
  const cur = villagerCurrentMonthIndex();
  if (cur === null) return;
  if (!Number.isFinite(villagerUpkeepLastMonth)) { villagerUpkeepLastMonth = cur; return; } // 記録なし(旧セーブ/新規): 請求せず基準月だけ記録
  if (cur <= villagerUpkeepLastMonth) { if (cur < villagerUpkeepLastMonth) villagerUpkeepLastMonth = cur; return; }
  const elapsed = cur - villagerUpkeepLastMonth;
  villagerUpkeepLastMonth = cur; // 先に記録する(この月を二重に処理しない)
  const months = Math.min(elapsed, CONFIG.villager.upkeepMaxCatchUpMonths);
  const fee = CONFIG.villager.upkeepPerMonth;
  let paid = 0, left = 0;
  for (let m = 0; m < months && villagers.length > 0; m++) {
    for (const v of [...villagers]) {
      if (playerGold >= fee) { playerGold -= fee; paid += fee; if (typeof MaidReport !== 'undefined') MaidReport.record('upkeep', -fee); } // メイドからの報告: 内訳の記録のみ
      else if (dismissVillager(v)) left++;
    }
  }
  if (paid > 0 || left > 0) {
    if (typeof updateRewardHud === 'function') updateRewardHud();
    if (paid > 0) showToast(`💰 領民の維持費 ${paid}G を支払った`, 2400);
    if (left > 0) showToast(`🏠 維持費が払えず領民が${left}人帰っていった`, 2800);
  }
}
// セーブ/ロード(worldState.villagerUpkeep)。旧セーブには存在しないのでundefined/不正値はnull(記録なし)として扱う。
function gatherVillagerUpkeepSaveData() {
  if (!Number.isFinite(villagerUpkeepLastMonth)) villagerUpkeepLastMonth = villagerCurrentMonthIndex(); // 記録なしのまま保存しない
  return { lastMonth: Number.isFinite(villagerUpkeepLastMonth) ? villagerUpkeepLastMonth : null };
}
function restoreVillagerUpkeepFromSave(rec) {
  villagerUpkeepLastMonth = (rec && Number.isFinite(rec.lastMonth)) ? rec.lastMonth : null;
  villagerUpkeepTimer = 0;
}

/* ---------- セーブ/ロード ----------
   保存: id / guestHouseId / floor(従来どおり) + 追加: no(フロア内番号) / x / z / inside(ゲストハウス内か)。
   担当地区はnoから毎回計算できるため保存しない。歩行状態(v.walk)も保存しない
   (ロード後はinsideと時間帯から状態を決め直し、保存位置から歩き出す。位置はワープさせない)。
   旧セーブ(no/x/z/insideが無い)も読み込める: noは同じフロアのid順に1から振り、
   位置はゲストハウスの入口、insideはfalseとして復元する。 */
function gatherVillagerSaveData() {
  const r2 = n => Math.round(n * 100) / 100;
  return villagers.map(v => ({
    id: v.id, guestHouseId: v.guestHouseId, floor: v.floor,
    no: v.no, x: r2(v.group.position.x), z: r2(v.group.position.z), inside: !!v.inside,
  }));
}
function restoreVillagersFromSave(list) {
  clearAllVillagers();
  villagerIdCounter = 1;
  if (!Array.isArray(list)) return;
  // 1) 復元できる領民(所属ゲストハウスが存在し、定員内)だけを選ぶ
  const kept = [], ghCount = {};
  list.forEach(rec => {
    if (!rec) return;
    const gh = guestHouses.find(g => g.id === rec.guestHouseId);
    if (!gh) return;
    const n = (ghCount[gh.id] || 0) + 1;
    if (n > (gh.capacity || CONFIG.guesthouse.capacity)) return;
    ghCount[gh.id] = n;
    kept.push({ rec, gh });
  });
  // 2) フロア内番号: 有効かつ重複しない保存値はそのまま使い、無い/重複はid順の最小の空き番号で補う
  const usedNo = {};
  kept.forEach(k => {
    const no = k.rec.no, f = k.gh.floor;
    usedNo[f] = usedNo[f] || new Set();
    if (Number.isInteger(no) && no >= 1 && !usedNo[f].has(no)) { k.no = no; usedNo[f].add(no); }
  });
  kept.filter(k => !k.no).sort((a, b) => (a.rec.id || 0) - (b.rec.id || 0)).forEach(k => {
    const f = k.gh.floor;
    usedNo[f] = usedNo[f] || new Set();
    let n = 1; while (usedNo[f].has(n)) n++;
    k.no = n; usedNo[f].add(n);
  });
  // 3) 生成
  kept.forEach(k => spawnVillager(k.gh, { id: k.rec.id, no: k.no, x: k.rec.x, z: k.rec.z, inside: k.rec.inside === true }));
}

/* ---------------------------------------------------------------------
   フロア単位の判定関数(js/maid-ai.jsはもう使っていないが、公開インターフェースとして残す)
--------------------------------------------------------------------- */
function hasVillagersOnFloor(floor) {
  return villagers.some(v => v.floor === floor);
}

/* ---------------------------------------------------------------------
   収入処理(農協への販売・種の購入。既存仕様のまま)
--------------------------------------------------------------------- */
// 農協へ「領民として」販売する(勇者が農協で直接売る場合は100%だが、領民経由の
// 売上は50%を税金として勇者へ支払う、という安全実装プロンプトの仕様に従う)。
function villagerSellCrop(cropId, qty, defOverride) {
  const def = defOverride || getCropDef(cropId);
  if (!def || !qty) return 0;
  const have = inventory.crop[cropId] || 0;
  const sellQty = Math.min(qty, have);
  if (sellQty <= 0) return 0;
  inventory.crop[cropId] = have - sellQty;
  const gross = def.sellPrice * sellQty;
  const tax = Math.floor(gross * CONFIG.villager.taxRate);
  playerGold += tax;
  if (typeof royalRecordIncome === 'function') royalRecordIncome(tax); // 王家への仕送り(js/royal.js)
  return tax;
}
// 領民の種購入は「勇者のGold」を使う。不足時はGoldを減らさず種も増やさない。
function villagerBuySeed(cropId) {
  const def = getCropDef(cropId);
  if (!def) return false;
  if (playerGold < def.seedPrice) return false;
  playerGold -= def.seedPrice;
  inventory.seed[cropId] = (inventory.seed[cropId] || 0) + 1;
  return true;
}

/* ---------------------------------------------------------------------
   歩行・仕事の設定
--------------------------------------------------------------------- */
CONFIG.villager.walk = {
  speed: 2.4,            // 領民専用の歩行速度(メイドのCONFIG.maid.moveSpeedとは独立)
  turnLerp: 8,
  arriveDist: 0.35,      // 経路の中継点に着いたとみなす距離
  idleMinSec: 2, idleMaxSec: 6,   // 徘徊の目的地に着いてから次の目的地を選ぶまでの待機
  wanderRangeMin: 2, wanderRangeMax: 10, // 担当地区内にいる間の、徘徊の1回あたりの移動距離
  pickTries: 6,          // 1回の目的地選びで試す候補数(A*の負荷を抑える)
  blockedGiveUpSec: 1.5, // 進路を塞がれ続けたら目的地を選び直すまでの秒数
  playerKeepDist: 1.0,   // プレイヤーにこれ以上近づかない(邪魔にならない。追従ではない)
  houseHalf: 1.9,        // ゲストハウス(3.2四方)+余白。この四角形の中には入らない
  workReachDist: 1.5,    // 管理対象の中心からこの距離まで来たら「到着」(農地1マス=2.0)
  workSec: 1.4,          // 到着してから作業を実行するまで、その場で作業する時間
  workScanSec: 1.5,      // 徘徊中に、担当地区に新しい仕事が出ていないか確認する間隔
  workScanFailSec: 5,    // 仕事を探して見つからなかった後、次に探すまでの間隔
  skipSec: 20,           // 到達できなかった/作業できなかった対象を再び目指すまでの待ち時間
  exitDelayMax: 4,       // 朝、ゲストハウスから出るまでの待ち時間の最大(全員が同時に出ないように)
  doorRetrySec: 2,       // 夜、入口までの経路が見つからない時の再試行間隔
};
let villagerWalkDisabled = false;   // 想定外のエラー時に歩行だけを止め、ゲーム本体を守る安全弁

/* ---------------------------------------------------------------------
   仕事の候補選び(担当地区の中だけ・現在のフロアだけ)
   優先順位: 1) 担当地区内の農地(収穫/水やり/種まき) 2) 担当地区内の牧場(素材回収)
--------------------------------------------------------------------- */
function villagerSkipped(w, ref) {
  const until = w.skip.get(ref);
  if (until === undefined) return false;
  if (until <= w.t) { w.skip.delete(ref); return false; }
  return true;
}
// 他の領民が種まき(新規農地)に予約している分を除いて、実際に種を持っている作物
function villagerPickOwnedSeedCropId(v) {
  if (typeof CROPS === 'undefined' || !CROPS.length) return null;
  for (const c of CROPS) {
    const reserved = villagers.filter(o => o !== v && o.walk && o.walk.target && o.walk.target.task === 'sowNew' && o.walk.target.cropId === c.id).length;
    if ((inventory.seed[c.id] || 0) - reserved > 0) return c.id;
  }
  return null;
}
// 収穫済みの畑の再植え付け: 種があるか、今日まだ購入に失敗しておらず買えるときだけ
function villagerCanReplant(fl, today) {
  const cropId = fl.lastCropType;
  if (!cropId) return false;
  if ((inventory.seed[cropId] || 0) > 0) return true;
  const def = getCropDef(cropId);
  if (!def) return false;
  if (today !== null && fl._villagerSeedSkipDay === today) return false;
  return playerGold >= def.seedPrice;
}
function villagerListWorkTargets(v, w) {
  const list = [];
  if (v.floor !== currentFloor) return list; // 他フロアの農地・牧場は対象にしない(farmlands/ranchesは現在のフロアのデータ)
  if (typeof isFloorSafeZone === 'function' && !isFloorSafeZone(currentFloor)) return list; // 従来どおり、安全地帯のフロアでだけ仕事をする
  const today = (typeof currentGameDayIndex === 'function') ? currentGameDayIndex(Date.now()) : null;
  const ownedSeed = villagerPickOwnedSeedCropId(v);
  for (const fl of farmlands) {
    if (!villagerPointInDistrict(v.no, fl.x, fl.z)) continue;      // 担当地区の外は見ない
    if (fl._maidReserved) continue;                                // メイドが対応中
    if (fl._villagerReserved && fl._villagerReserved !== v.id) continue; // 他の領民が対応中
    if (villagerSkipped(w, fl)) continue;
    const stage = computeCropStage(fl);
    let task = null, cropId = null;
    if (stage === 2) task = 'harvest';
    else if ((stage === 0 || stage === 1) && !isWateredToday(fl)) task = 'water';
    else if (stage === -1 && !fl.cropType) {
      if (fl.lastCropType) { if (villagerCanReplant(fl, today)) { task = 'replant'; cropId = fl.lastCropType; } }
      else if (ownedSeed) { task = 'sowNew'; cropId = ownedSeed; } // 新規農地: 実際に持っている種がある時だけ(購入しない)
    }
    if (task) list.push({ kind: 'farmland', task, ref: fl, x: fl.x, z: fl.z, cropId, prio: 1 });
  }
  for (const r of ranches) {
    if (r._maidReserved) continue;
    if (r._villagerReserved && r._villagerReserved !== v.id) continue;
    if (villagerSkipped(w, r)) continue;
    if (!ranchHarvestReady(r)) continue;
    const p = maidRanchCenterPoint(r);
    if (!p || !villagerPointInDistrict(v.no, p.x, p.z)) continue;
    list.push({ kind: 'ranch', task: 'collect', ref: r, x: p.x, z: p.z, cropId: null, prio: 2 });
  }
  return list;
}
// 候補が選べたら、A*で実際に歩く経路を作って返す。経路が無い対象はしばらく候補から外す。
function villagerPickWork(v, w) {
  const cands = villagerListWorkTargets(v, w);
  if (!cands.length) return null;
  const W = CONFIG.villager.walk;
  const sx = v.group.position.x, sz = v.group.position.z;
  for (const prio of [1, 2]) {
    const list = cands.filter(c => c.prio === prio);
    if (!list.length) continue;
    list.sort((a, b) => Math.hypot(a.x - sx, a.z - sz) - Math.hypot(b.x - sx, b.z - sz));
    let best = null, bestLen = Infinity, bestPath = null;
    for (const c of list.slice(0, 3)) {
      const path = maidFindPath(sx, sz, c.x, c.z); // 既存のA*(読み取り専用)
      if (!path || !villagerPathClear(path, sx, sz, v.floor)) { w.skip.set(c.ref, w.t + W.skipSec); continue; }
      const len = maidPathLength(path, sx, sz);
      if (len < bestLen) { bestLen = len; best = c; bestPath = path; }
    }
    if (best) return { target: best, path: bestPath };
  }
  return null;
}
function villagerHasWork(v, w) { return villagerListWorkTargets(v, w).length > 0; }

// 目的地がまだ有効か(階移動・メイド/勇者の先回り・状態変化で無効になっていないか)
function villagerTargetValid(v, t) {
  if (!t || v.floor !== currentFloor) return false;
  if (t.kind === 'farmland') {
    const fl = t.ref;
    if (!farmlands.includes(fl)) return false;
    if (fl._maidReserved) return false;
    const stage = computeCropStage(fl);
    if (t.task === 'harvest') return stage === 2;
    if (t.task === 'water') return (stage === 0 || stage === 1) && !isWateredToday(fl);
    if (t.task === 'replant') {
      const today = (typeof currentGameDayIndex === 'function') ? currentGameDayIndex(Date.now()) : null;
      return stage === -1 && !fl.cropType && villagerCanReplant(fl, today);
    }
    if (t.task === 'sowNew') return stage === -1 && !fl.cropType && !fl.lastCropType && (inventory.seed[t.cropId] || 0) > 0;
    return false;
  }
  if (t.kind === 'ranch') return ranches.includes(t.ref) && !t.ref._maidReserved && ranchHarvestReady(t.ref);
  return false;
}
// 実際に目的地へ到着しているか(距離で確認する。牧場は牧場のマスの中でも可)
function villagerAtTarget(v, t) {
  const W = CONFIG.villager.walk;
  const px = v.group.position.x, pz = v.group.position.z;
  if (Math.hypot(px - t.x, pz - t.z) <= W.workReachDist) return true;
  if (t.kind === 'ranch' && t.ref.cellsArr) {
    const c = farmlandCellOf(px, pz);
    return t.ref.cellsArr.includes(farmlandCellKey(c.a, c.b));
  }
  return false;
}
function villagerReserve(v, t) { if (t && t.ref) t.ref._villagerReserved = v.id; }
function villagerReleaseWork(v, w, skip) {
  const t = w && w.target;
  if (!t) return;
  if (t.ref && t.ref._villagerReserved === v.id) t.ref._villagerReserved = null;
  if (skip && t.ref) w.skip.set(t.ref, w.t + CONFIG.villager.walk.skipSec);
  w.target = null;
}

/* ---------------------------------------------------------------------
   作業の実行(到着後=WORKING状態の終わりにだけ呼ばれる唯一の入口)
   既存の共有ロジック(harvestCrop/plantCrop/waterCrop/ranchHarvestReady)をそのまま呼ぶだけで、
   農地・牧場の仕様(生育・水やり・剥ぎ取り間隔)は変更しない。
--------------------------------------------------------------------- */
function villagerExecuteWork(v, t) {
  if (!t || v.floor !== currentFloor) return false; // 現在のフロアと領民の所属フロアが一致する時だけ
  let changed = false;
  if (t.kind === 'farmland') {
    const fl = t.ref;
    if (!farmlands.includes(fl)) return false;
    if (t.task === 'harvest') {
      const cropId = fl.cropType, def = getCropDef(cropId);
      if (harvestCrop(fl)) { villagerSellCrop(cropId, 1, def); changed = true; }
    } else if (t.task === 'water') {
      if (waterCrop(fl, Date.now())) changed = true;
    } else if (t.task === 'replant') {
      const cropId = fl.lastCropType;
      const today = (typeof currentGameDayIndex === 'function') ? currentGameDayIndex(Date.now()) : null;
      if (cropId && !fl.cropType) {
        if ((inventory.seed[cropId] || 0) > 0) { if (plantCrop(fl, cropId)) changed = true; }
        else if (villagerBuySeed(cropId)) { if (plantCrop(fl, cropId)) changed = true; }
        else if (today !== null) fl._villagerSeedSkipDay = today; // ゴールド不足: 同じ日のうちは同じ畑で何度も試みない
      }
    } else if (t.task === 'sowNew') {
      // 新規農地: 実際に持っている種があれば、plantCrop()が種を1個消費して植える(購入はしない)
      if (!fl.cropType && !fl.lastCropType && (inventory.seed[t.cropId] || 0) > 0 && plantCrop(fl, t.cropId)) changed = true;
    }
  } else if (t.kind === 'ranch') {
    const r = t.ref;
    if (!ranches.includes(r) || !ranchHarvestReady(r)) return false;
    const def = MONSTER_DEFS[r.type];
    ranchMarkHarvested(r); // 次に収穫できるのは次の朝6:00から(js/ranch.js)
    if (def && def.material) {
      const amount = r.count * CONFIG.ranchHarvestPerHead; // 既存の牧場仕様(頭数×係数)をそのまま利用
      if (amount > 0) {
        const ranchTax = Math.floor(def.material.sellPrice * amount * CONFIG.villager.taxRate);
        playerGold += ranchTax;
        if (typeof royalRecordIncome === 'function') royalRecordIncome(ranchTax); // 王家への仕送り(js/royal.js)
      }
    }
    changed = true;
  }
  if (changed && typeof updateRewardHud === 'function') updateRewardHud();
  return changed;
}

/* ---------------------------------------------------------------------
   歩行(見た目の位置を動かす唯一の処理。1フレームの移動量は 速度×dt まで)
   ・経路探索は js/maid-ai.js の maidFindPath() を「読み取り専用の共通関数」として呼ぶだけ。
   ・衝突の局所判定(柵・プレイヤー・モンスター)は領民専用の villagerLocalBlocked() で行い、
     家畜化モンスター(e.tamed === true)は障害物から除外する。
--------------------------------------------------------------------- */
// 現在の階の柵(門は通れる)・プレイヤー・通常モンスター・ゲストハウス本体に当たるか。
function villagerLocalBlocked(nx, nz, v) {
  const W = CONFIG.villager.walk;
  for (const f of fences) {
    if (f.isGate) continue;
    if (distanceToFenceSegment(nx, nz, f) < 0.42) return true;
  }
  if (player) {
    if (Math.hypot(nx - player.position.x, nz - player.position.z) < W.playerKeepDist) return true;
  }
  for (const e of enemies) {
    if (!e.alive) continue;
    if (e.tamed === true) continue; // 家畜化モンスターは領民の移動を妨げない
    const d = Math.hypot(nx - e.mesh.position.x, nz - e.mesh.position.z);
    if (d < 0.5 + 0.4 * (e.baseScale || 1)) return true;
  }
  // ゲストハウスの中へは入らない(すでに本体の上にいる場合は、外へ歩き出せるよう判定しない)
  if (villagerInHouseFootprint(nx, nz, v.floor) && !villagerInHouseFootprint(v.group.position.x, v.group.position.z, v.floor)) return true;
  return false;
}
// 経路(開始点+各中継点)を0.5刻みで調べ、ゲストハウス本体を横切らないか確認する
function villagerPathClear(path, sx, sz, floor) {
  if (villagerInHouseFootprint(sx, sz, floor)) return true; // 本体の上から歩き出す場合は確認しない
  let px = sx, pz = sz;
  for (const p of path) {
    const len = Math.hypot(p.x - px, p.z - pz);
    const n = Math.max(1, Math.ceil(len / 0.5));
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      if (villagerInHouseFootprint(px + (p.x - px) * t, pz + (p.z - pz) * t, floor)) return false;
    }
    px = p.x; pz = p.z;
  }
  return true;
}
// 経路に沿って1フレーム分だけ歩く。戻り値: 'moving' | 'done'(最終地点に到着) | 'blocked'(塞がれ続けた)
function villagerStep(v, w, dt) {
  const W = CONFIG.villager.walk;
  if (!w.path || w.pathIndex >= w.path.length) return 'done';
  const wp = w.path[w.pathIndex];
  const pos = v.group.position;
  const dx = wp.x - pos.x, dz = wp.z - pos.z;
  const dist = Math.hypot(dx, dz);
  if (dist <= W.arriveDist) { w.pathIndex++; return w.pathIndex >= w.path.length ? 'done' : 'moving'; }
  const dirX = dx / dist, dirZ = dz / dist;
  const step = Math.min(W.speed * dt, dist); // ← 位置が変わるのはここだけ(1フレームの移動量は速度×dt以下)
  const nx = pos.x + dirX * step, nz = pos.z + dirZ * step;
  if (!villagerLocalBlocked(nx, nz, v)) {
    pos.x = nx; pos.z = nz; pos.y = heightAt(nx, nz);
    v.x = nx; v.z = nz;
    w.blockedSec = 0;
  } else {
    w.blockedSec += dt;
    if (w.blockedSec >= W.blockedGiveUpSec) { w.blockedSec = 0; return 'blocked'; }
  }
  v.group.rotation.y = lerpAngle(v.group.rotation.y, Math.atan2(dirX, dirZ), 1 - Math.pow(0.001, dt * W.turnLerp));
  return 'moving';
}
function villagerFace(v, x, z, dt) {
  const dx = x - v.group.position.x, dz = z - v.group.position.z;
  if (Math.hypot(dx, dz) < 0.01) return;
  v.group.rotation.y = lerpAngle(v.group.rotation.y, Math.atan2(dx, dz), 1 - Math.pow(0.001, dt * CONFIG.villager.walk.turnLerp));
}

/* ---------- 徘徊(担当地区が中心) ---------- */
function villagerPickWanderPath(v, w) {
  const W = CONFIG.villager.walk;
  const b = villagerDistrictBounds(v.no);
  const sx = v.group.position.x, sz = v.group.position.z;
  const inDistrict = villagerPointInDistrict(v.no, sx, sz);
  const useLocal = inDistrict || w.wanderFail >= 3; // 担当地区へ何度も行けない時だけ、今いる場所の周りを歩く
  const margin = 0.8;
  for (let i = 0; i < W.pickTries; i++) {
    let tx, tz;
    if (useLocal) {
      const ang = Math.random() * Math.PI * 2;
      const d = W.wanderRangeMin + Math.random() * (W.wanderRangeMax - W.wanderRangeMin);
      tx = sx + Math.cos(ang) * d; tz = sz + Math.sin(ang) * d;
      if (inDistrict) { // 担当地区の外へは出ない
        tx = Math.max(b.minX + margin, Math.min(b.maxX - margin, tx));
        tz = Math.max(b.minZ + margin, Math.min(b.maxZ - margin, tz));
      }
    } else { // 担当地区の外にいる(朝、家から出た直後など): 担当地区の中の地点へ向かう
      tx = b.minX + margin + Math.random() * (b.maxX - b.minX - margin * 2);
      tz = b.minZ + margin + Math.random() * (b.maxZ - b.minZ - margin * 2);
    }
    if (!isPassable(tx, tz)) continue;
    const c = farmlandCellOf(tx, tz), ck = farmlandCellKey(c.a, c.b);
    if (filledFarmlandCells.has(ck) || ranchZoneCellSet.has(ck)) continue; // 作物の上や牧場の中では立ち止まらない
    if (villagerInHouseFootprint(tx, tz, v.floor)) continue;
    const path = maidFindPath(sx, sz, tx, tz); // 共通のA*(読み取り専用で利用)
    if (!path) continue;
    if (!villagerPathClear(path, sx, sz, v.floor)) continue;
    return path;
  }
  return null;
}

/* ---------- 状態遷移 ---------- */
function villagerInitWalk(v, day) {
  return {
    mode: v.inside ? 'HOME' : (day ? 'WORK_SEARCH' : 'GO_HOME'),
    path: null, pathIndex: 0, blockedSec: 0, t: 0,
    idleLeft: 0, scanLeft: CONFIG.villager.walk.workScanSec, workLeft: 0, homeRetry: 0,
    exitDelay: null, wanderFail: 0,
    target: null,           // 仕事の対象 { kind, task, ref, x, z, cropId }
    skip: new Map(),        // 対象 -> この時刻(w.t)までは目指さない
  };
}
function villagerEnterHouse(v, w) { // 入口まで歩いて着いた後だけ呼ばれる
  villagerReleaseWork(v, w, false);
  v.inside = true;
  v.group.visible = false;
  w.mode = 'HOME'; w.path = null; w.exitDelay = null;
}
function villagerLeaveHouse(v, w) { // 入口(入った場所)に現れて、担当地区へ向かう
  v.inside = false;
  v.group.visible = (v.floor === currentFloor);
  w.mode = 'WORK_SEARCH'; w.path = null;
}
function villagerGoHome(v, w) {
  villagerReleaseWork(v, w, false);
  w.mode = 'GO_HOME'; w.path = null; w.homeRetry = 0;
}
function updateVillagerWalk(dt) {
  if (villagerWalkDisabled || typeof maidFindPath !== 'function') return;
  const W = CONFIG.villager.walk;
  const day = villagerIsDaytime();
  let pickBudget = 1; // 1フレームにA*を走らせるのは最大1回(FPS保護。仕事選びのみ最大3回までまとめて走る)
  for (const v of villagers) {
    if (!v.group) continue;
    if (v.floor !== currentFloor) { // 別の階の領民は動かさず、その階の地形も参照しない(消さない・移さない)
      if (v.walk) { villagerReleaseWork(v, v.walk, false); v.walk = null; }
      continue;
    }
    if (!v.walk) v.walk = villagerInitWalk(v, day);
    const w = v.walk;
    w.t += dt;
    switch (w.mode) {
      case 'HOME': { // ゲストハウスの中で待機。朝になったら入口から出る
        if (!day) { w.exitDelay = null; break; }
        if (w.exitDelay === null) w.exitDelay = Math.random() * W.exitDelayMax;
        w.exitDelay -= dt;
        if (w.exitDelay <= 0) villagerLeaveHouse(v, w);
        break;
      }
      case 'WORK_SEARCH': { // 担当地区の管理対象を探す
        if (!day) { villagerGoHome(v, w); break; }
        if (pickBudget <= 0) break;
        pickBudget--;
        const r = villagerPickWork(v, w);
        if (r) {
          w.target = r.target; villagerReserve(v, r.target);
          w.path = r.path; w.pathIndex = 0; w.blockedSec = 0;
          w.mode = 'GO_TO_WORK';
        } else { // 仕事が無い: 昼は担当地区を歩いて徘徊する
          w.mode = 'WANDER'; w.path = null; w.idleLeft = 0.3 + Math.random() * 1.2; w.scanLeft = W.workScanFailSec;
        }
        break;
      }
      case 'GO_TO_WORK': { // 仕事場所へ実際に歩く(この間は作業しない)
        if (!day) { villagerGoHome(v, w); break; }
        if (!villagerTargetValid(v, w.target)) { villagerReleaseWork(v, w, false); w.mode = 'WORK_SEARCH'; break; }
        const res = villagerStep(v, w, dt);
        if (res === 'blocked') { villagerReleaseWork(v, w, true); w.mode = 'WORK_SEARCH'; }
        else if (res === 'done') {
          if (villagerAtTarget(v, w.target)) { w.mode = 'WORKING'; w.workLeft = W.workSec; w.path = null; }
          else { villagerReleaseWork(v, w, true); w.mode = 'WORK_SEARCH'; } // 経路の終点でも届いていない: 作業せず選び直す
        }
        break;
      }
      case 'WORKING': { // 到着後の作業。作業の実行は、到着を再確認できた時だけ
        villagerFace(v, w.target.x, w.target.z, dt);
        w.workLeft -= dt;
        if (w.workLeft > 0) break;
        if (villagerTargetValid(v, w.target) && villagerAtTarget(v, w.target)) {
          villagerExecuteWork(v, w.target);
          villagerReleaseWork(v, w, false);
        } else {
          villagerReleaseWork(v, w, true);
        }
        w.mode = 'WORK_SEARCH'; // 次の対象を探す(夜ならWORK_SEARCH側でGO_HOMEへ)
        break;
      }
      case 'WANDER': { // 担当地区を歩いて徘徊
        if (!day) { villagerGoHome(v, w); break; }
        w.scanLeft -= dt;
        if (w.scanLeft <= 0) {
          w.scanLeft = W.workScanSec;
          if (villagerHasWork(v, w)) { w.path = null; w.mode = 'WORK_SEARCH'; break; }
        }
        if (w.path) {
          const res = villagerStep(v, w, dt);
          if (res === 'done') { w.path = null; w.idleLeft = W.idleMinSec + Math.random() * (W.idleMaxSec - W.idleMinSec); }
          else if (res === 'blocked') { w.path = null; w.idleLeft = 0.3 + Math.random() * 1.2; }
        } else {
          w.idleLeft -= dt;
          if (w.idleLeft <= 0 && pickBudget > 0) {
            pickBudget--;
            const path = villagerPickWanderPath(v, w);
            if (path) { w.path = path; w.pathIndex = 0; w.blockedSec = 0; w.wanderFail = 0; }
            else { w.wanderFail++; w.idleLeft = 1 + Math.random() * 2; } // 見つからなければ少し待って探し直す
          }
        }
        break;
      }
      case 'GO_HOME': { // 夜: ゲストハウスの入口まで実際に歩く
        if (day) { w.path = null; w.mode = 'WORK_SEARCH'; break; } // 朝になったら引き返す
        const gh = guestHouses.find(g => g.id === v.guestHouseId);
        if (!gh) { w.mode = 'WANDER'; break; }
        if (!w.path) {
          w.homeRetry -= dt;
          if (w.homeRetry > 0 || pickBudget <= 0) break;
          pickBudget--;
          const door = villagerDoorPoint(gh);
          const path = maidFindPath(v.group.position.x, v.group.position.z, door.x, door.z);
          if (path && villagerPathClear(path, v.group.position.x, v.group.position.z, v.floor)) {
            w.path = path; w.pathIndex = 0; w.blockedSec = 0; w.doorX = door.x; w.doorZ = door.z;
          } else { w.homeRetry = W.doorRetrySec; break; }
        }
        const res = villagerStep(v, w, dt);
        if (res === 'done') {
          if (Math.hypot(v.group.position.x - w.doorX, v.group.position.z - w.doorZ) <= W.workReachDist) villagerEnterHouse(v, w);
          else { w.path = null; w.homeRetry = 0.5; }
        } else if (res === 'blocked') { w.path = null; w.homeRetry = 0.5; }
        break;
      }
      default: w.mode = v.inside ? 'HOME' : 'WORK_SEARCH';
    }
  }
}

function updateVillagers(dt) {
  // 変更6: 維持費の月替わり判定(約1秒間隔)。歩行処理の安全弁(villagerWalkDisabled)とは独立に動かす
  villagerUpkeepTimer += dt;
  if (villagerUpkeepTimer >= 1) {
    villagerUpkeepTimer = 0;
    try { processVillagerUpkeep(); } catch (e) { console.error('領民の維持費処理でエラーが発生しました:', e); }
  }
  updateVillagerCountHud(); // 変更5: 領民数のHUD(変化した時だけ書き換える)
  if (villagerWalkDisabled) return;
  try { updateVillagerWalk(dt); }
  catch (e) { villagerWalkDisabled = true; console.error('領民の歩行処理でエラーが発生したため、歩行のみ停止しました:', e); }
}
