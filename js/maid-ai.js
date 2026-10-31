/* =====================================================================================
   js/maid-ai.js
   -------------------------------------------------------------------------------------
   game.html の「29. お助けメイド (Phase7)」セクションをそのまま切り出したファイル。
   ロジック・変数名・関数名は一切変更していません(コードの位置を移しただけ)。
   グローバルスクリプト方式(ES Modules不使用)のため、game.html側で
   このファイルを <script src="js/maid-ai.js"> として、元のセクション29があった
   位置より前(transfer-db.js の直後)に読み込むことで、以前と全く同じ実行順序を
   維持しています。
   ===================================================================================== */

/* =====================================================================================
   29. お助けメイド (Phase7: Helper Maid) - 軽量ルールベースAI 【慎重に扱う】
   -------------------------------------------------------------------------------------
   設計方針:
   ・既存の柵/耕地グリッド(fenceLength=farmlandSize=CONFIG.farmlandSize)の座標系を
     そのまま使ってA*経路探索を行う。新しい障害物表現は作らない。
   ・柵の当たり判定は recomputeEnclosures() と全く同じ hSet/vSet (buildFenceEdgeSets)
     を使う。建物・掲示板は勇者と違いメイドには実体のある障害物として扱う
     (既存のcanTillFarmland/canPlaceFenceが使っている建物半径3.2をそのまま流用)。
   ・勇者・モンスターはA*グリッドには焼き込まず(常に動くため)、移動時の
     ローカル回避(すぐ前に居たら1フレーム待つ)だけで自然な壁抜け防止を行う。
     これによりA*は「目的地決定時」と「30秒ごとの再判定」だけで済み、
     毎フレームの再計算を避けてFPSへの影響を最小限にする。
   ・メイドの農地作業は「収穫」と「水やり」の両方に対応する(水やり仕様の
     追加に合わせてメイドAIも拡張済み。maidFarmlandCandidates/maidStartWorking
     等を参照)。
   ・農協でのモンスター素材売却は元々存在しなかった機能なので、
     MONSTER_DEFS[].material.sellPrice を新設し、農協UIとメイドの両方から使う。
   ===================================================================================== */

CONFIG.maid = {
  moveSpeed: 4.4,           // 勇者の通常移動よりやや控えめ
  turnLerp: 8,
  arriveDist: 0.35,
  reassessIntervalSec: 30,  // 仕様10: 30秒ごとに目的地の妥当性を再確認
  reassessMinGainDist: 3.0, // これ以上経路が短くならないなら目的地を変えない(頻繁な切替防止)
  stuckCheckIntervalSec: 4,
  stuckMinMoveDist: 0.5,
  stuckMaxRetries: 2,       // これを超えて動けなければ目的地自体を諦めて再検索する
  ranchAltMaxTries: 3,      // 牧場で詰まった時、同じ牧場の別セルへ目的地を変える最大回数
  ranchSkipSec: 60,         // 上記でも入れない牧場を、メイドの候補から一時的に外す秒数
  workSwingUpTime: 0.32,
  workSwingDownTime: 0.36,
  workRequiredSwings: 2,
  sellPauseSec: 0.6,
  // 変更2(仕事が無いメイドは勇者の近くをうろつく): 教会での固定待機の代わりに使う設定。
  wanderMinDist: 3.0,       // 勇者からこれ以上離れた地点を選ぶ(勇者に重なり続けない)
  wanderMaxDist: 7.0,       // 勇者からこれ以内の地点を選ぶ
  wanderPickTries: 5,       // 1回の目的地選びで試す候補数(A*の負荷を抑える)
  wanderIdleMinSec: 1.5,    // 目的地に着いてから次の目的地を選ぶまでの待機(最小)
  wanderIdleMaxSec: 4.5,    // 同(最大)
  wanderLeashDist: 12,      // 勇者がこれ以上離れたら(目的地・メイド自身が)新しい目的地を選び直す
  wanderNearDist: 1.5,      // 待機中に勇者がこれ以内に来たら、少し離れた別の地点へ移る
  wanderRetrySec: 5,        // 目的地が見つからなかった時、次に探し直すまでの間隔
  // 性格追加(臆病): 家畜化していない(野生の)モンスターには近寄らない。
  wildAvoidDist: 7.0,       // 目的地・経路が、野生モンスターからこの距離以内に入る仕事/道は選ばない
  wildFleeDist: 5.0,        // 移動中・作業中・待機中に野生モンスターがこの距離以内に来たら、その場の行動を中止して離れる
  wildCheckIntervalSec: 0.3,// 上記の確認を行う間隔(毎フレームは見ない)
  wildHoldSec: 3,           // 野生モンスターのせいで仕事に行けない時、次に仕事を探し直すまでの間隔
  // 性格変更(勇者の後ろに隠れる): 野生モンスターが近いとき「逃げる」のをやめ、勇者(姫)の後ろへ隠れる。
  hideBehindDist: 1.3,      // 勇者から見て「野生モンスターと反対側」へ、この距離だけ離れた地点に隠れる
  hideMaxHeroDist: 30,      // 勇者がこれより遠いと隠れに行けない(従来どおり別の行動を選び直す)
  hideRepathSec: 0.4,       // 勇者が動いたとき、隠れる地点を取り直す間隔
  hideReleaseDist: 7.0,     // 野生モンスターがこの距離以内にいる間は隠れ続ける(wildAvoidDistと同じ値)
  hideReleaseDelaySec: 1.0, // 野生モンスターがいなくなってから、隠れるのをやめるまでの余韻
  hideGiveUpSec: 2.5,       // 隠れる地点へ行く経路が見つからない状態がこの秒数続いたら諦める
  hideSayCooldownSec: 8,    // 「怖い」セリフを言う最小間隔
  // 挨拶: 勇者から「1コマ以内」に来たら挨拶する(1コマ = CONFIG.farmlandSize)。
  greetCells: 1,            // 挨拶する距離(コマ数)
  greetRearmCells: 2,       // この距離(コマ数)より離れるまでは、同じ接近で2回目の挨拶をしない
  greetCooldownSec: 20,     // 前回の挨拶からこの秒数が経つまでは挨拶しない(うろつき中の連発防止)
  greetNoRepeat: 10,        // 直近この回数ぶんのセリフは使わない(10回続けても同じセリフが出ない)
  bubbleSec: 3.5,           // 吹き出しを表示する秒数
  bubbleY: 2.5,             // 吹き出しの高さ(メイドの足元から)
  bubbleWidth: 3.0,         // 吹き出しの横幅(ワールド単位)
  // 生活(睡眠・食事): 勇者と同じ時間割で動く。夜は教会で眠って朝6時から動き出し、空腹になったら食堂で食事をとる。
  // 就寝・起床の時刻、空腹度の減り方、食堂のメニュー/営業時間/食事時間は js/survival.js の CONFIG.survival と共通
  // (勇者側を変えるとメイドも同じに変わる)。js/survival.js が無い場合、この生活の処理は丸ごと無効になる。
  lifeEnabled: true,        // falseにすると睡眠・食事の処理を止める(従来どおり夜も昼も働く)
  eatBelow: 70,             // 空腹度がこの値以下で、食堂が営業中なら食べに行く(%)
  payMeals: false,          // false: 食費はメイド自身の負担(勇者のゴールドは減らない・足りなくても食べに行く) / true: 食堂の値段を勇者のゴールドから払う
  doorOffset: 4.0,          // 教会・食堂の「入口」に立つ位置(建物の中心から+z方向へ離す距離。建物の当たり判定の外側)
  sleepEnterSec: 1.4,       // 教会の前で「おやすみ」を言ってから中へ入る(姿を消す)までの秒数
  lifeRetrySec: 5,          // 就寝・食堂へ行けなかった時、次にやり直すまでの秒数(食堂の営業時間外などは長めに待つ)
  mealMinOpenLeftMin: 5,    // 営業終了まであと何ゲーム内分以上残っている時だけ食べに出かけるか
};

const MAID_STATE = {
  WAITING: 'WAITING', SEARCHING: 'SEARCHING', MOVING: 'MOVING',
  WORKING: 'WORKING', SELLING: 'SELLING', RETURNING: 'RETURNING',
  HIDING: 'HIDING', // 性格変更: 野生モンスターが近い間、勇者の後ろに隠れている
  EATING: 'EATING',     // 生活: 食堂の前で食事中(ゲーム内0.5時間)
  SLEEPING: 'SLEEPING', // 生活: 教会で就寝中(朝6:00まで)
};

const MAID_POSE = {
  IDLE: '待機',
  RUN_R: '疾走・右足着地', RUN_M: '疾走・中間（両足そろう）', RUN_L: '疾走・左足着地',
  KNIFE_UP: 'ナイフを振り上げる', KNIFE_DOWN: 'ナイフを振り下ろす',
  BAG: 'カバンで受ける',
  WATER: 'ジョウロを正面高く構える', // 追加(水やり): メイドのGLBにのみ存在する専用モーション
};
const maidRunCycleNames = [MAID_POSE.RUN_R, MAID_POSE.RUN_M, MAID_POSE.RUN_L, MAID_POSE.RUN_M];

let maids = [];
let maidIdCounter = 1;
let maidGlbArrayBuffer = null;
let maidLoadFailed = false;
let maidDebugVisible = false;

/* --- 教会/農協で実際に立ち寄る座標(建物本体には当たり判定を持たせるため、
   建物半径3.2の外側になる位置を選ぶ) --- */
function maidChurchWaitPoint() { return { x: CHURCH_POS.x + 4.0, z: CHURCH_POS.z }; }
function maidAgriSellPoint() { return { x: AGRI_POS.x, z: AGRI_POS.z - 4.0 }; }

/* --- 変更1(領民がいるフロアではメイドが仕事を譲る) ---
   今いるフロア(currentFloor。farmlands/ranchesは「今いる階のデータ」)に領民が1人以上いる間は、
   メイドはそのフロアの農地・牧場の仕事を探さない。領民が0人になれば自動的に再開する。
   js/villager.js の hasVillagersOnFloor() をそのまま利用する(判定はここ1か所に集約)。
   農地・牧場の処理そのものは削除せず、仕事探索の入口(候補選び・種の買い出し判定・目的地の
   有効判定)で除外するだけにしている。 */
function maidFloorYieldedToVillagers() {
  return (typeof hasVillagersOnFloor === 'function') && hasVillagersOnFloor(currentFloor);
}

/* ------------------------------- A*経路探索 ------------------------------- */
function maidCellBlockedByBuilding(cx, cz) {
  for (const b of buildings) {
    if (Math.hypot(cx - b.x, cz - b.z) < 3.2) return true;
  }
  if (Math.hypot(cx - BOARD_POS.x, cz - BOARD_POS.z) < 2.2) return true;
  // 追加(領民の生活仕様): ゲストハウス(js/guesthouse.js)の本体は通り抜けない。今いるフロアの
  // ゲストハウスだけが対象(他のフロアのものは別のワールドなので無関係)。建物がまだ無い/
  // guesthouse.js未読込の場合は何もしない。判定の範囲(±1.9)は領民のhouseHalfと同じ。
  if (typeof guestHouses !== 'undefined') {
    for (const gh of guestHouses) {
      if (gh.floor !== currentFloor) continue;
      if (Math.abs(cx - gh.x) < 1.9 && Math.abs(cz - gh.z) < 1.9) return true;
    }
  }
  return false;
}
function maidCellWalkable(a, b) {
  const c = farmlandCellCenter(a, b);
  if (!isPassable(c.x, c.z)) return false;
  if (maidCellBlockedByBuilding(c.x, c.z)) return false;
  return true;
}
// recomputeEnclosures()内のcanPass()と同じ判定式(柵を辺として扱う)だが、
// 受け取るhSet/vSetはbuildMaidFenceEdgeSets()のもの(門は含まれない)なので、
// 実際には「門以外の柵だけを壁として扱う」判定になる。
function maidCanPassEdge(hSet, vSet, a, b, da, db) {
  if (da === 1) return !vSet.has((a + 1) + ',' + b);
  if (da === -1) return !vSet.has(a + ',' + b);
  if (db === 1) return !hSet.has(a + ',' + (b + 1));
  return !hSet.has(a + ',' + b);
}

// 簡易バイナリヒープ(モバイル最適化: A*のopen-listをO(log n)で扱う)
function MaidMinHeap() { this.items = []; }
MaidMinHeap.prototype.push = function (item) {
  const arr = this.items; arr.push(item);
  let i = arr.length - 1;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (arr[p].f <= arr[i].f) break;
    const t = arr[p]; arr[p] = arr[i]; arr[i] = t; i = p;
  }
};
MaidMinHeap.prototype.pop = function () {
  const arr = this.items;
  const top = arr[0];
  const last = arr.pop();
  if (arr.length) {
    arr[0] = last;
    let i = 0;
    for (;;) {
      const l = i * 2 + 1, r = i * 2 + 2;
      let smallest = i;
      if (l < arr.length && arr[l].f < arr[smallest].f) smallest = l;
      if (r < arr.length && arr[r].f < arr[smallest].f) smallest = r;
      if (smallest === i) break;
      const t = arr[i]; arr[i] = arr[smallest]; arr[smallest] = t; i = smallest;
    }
  }
  return top;
};
MaidMinHeap.prototype.isEmpty = function () { return this.items.length === 0; };

// ワールド座標(startX,startZ)→(goalX,goalZ)への経路を返す。到達不能ならnull。
// 戻り値は[{x,z},...]で、最後の要素は必ず(goalX,goalZ)そのもの。
function maidFindPath(startX, startZ, goalX, goalZ) {
  const start = farmlandCellOf(startX, startZ);
  const goal = farmlandCellOf(goalX, goalZ);
  if (start.a === goal.a && start.b === goal.b) return [{ x: goalX, z: goalZ }];
  if (!maidCellWalkable(goal.a, goal.b)) return null;

  const { hSet, vSet } = buildMaidFenceEdgeSets(); // 門は通行可能として扱う(牧場・農地には必ず門がある前提)
  const limit = CONFIG.mapHalf + 2;
  const key = (a, b) => a + ',' + b;
  const startKey = key(start.a, start.b);
  const goalKey = key(goal.a, goal.b);

  const gScore = new Map([[startKey, 0]]);
  const cameFrom = new Map();
  const closed = new Set();
  const heap = new MaidMinHeap();
  const h = (a, b) => Math.abs(a - goal.a) + Math.abs(b - goal.b);
  heap.push({ a: start.a, b: start.b, f: h(start.a, start.b) });

  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  let iterations = 0;
  const maxIterations = 6000; // モバイル安全弁
  while (!heap.isEmpty() && iterations < maxIterations) {
    iterations++;
    const cur = heap.pop();
    const curKey = key(cur.a, cur.b);
    if (closed.has(curKey)) continue;
    closed.add(curKey);
    if (curKey === goalKey) break;
    for (const [da, db] of dirs) {
      const na = cur.a + da, nb = cur.b + db;
      if (na < -limit || na > limit || nb < -limit || nb > limit) continue;
      if (!maidCanPassEdge(hSet, vSet, cur.a, cur.b, da, db)) continue;
      if (!maidCellWalkable(na, nb)) continue;
      const nKey = key(na, nb);
      if (closed.has(nKey)) continue;
      const tentativeG = (gScore.get(curKey) ?? Infinity) + 1;
      if (tentativeG < (gScore.get(nKey) ?? Infinity)) {
        gScore.set(nKey, tentativeG);
        cameFrom.set(nKey, curKey);
        heap.push({ a: na, b: nb, f: tentativeG + h(na, nb) });
      }
    }
  }
  if (!closed.has(goalKey)) return null;

  const cellPath = [];
  let ck = goalKey;
  while (ck !== startKey) {
    const [a, b] = ck.split(',').map(Number);
    cellPath.push({ a, b });
    ck = cameFrom.get(ck);
    if (!ck) break;
  }
  cellPath.reverse();
  const path = cellPath.map(({ a, b }) => farmlandCellCenter(a, b));
  if (path.length === 0) path.push({ x: goalX, z: goalZ });
  else path[path.length - 1] = { x: goalX, z: goalZ };
  return path;
}

function maidPathLength(path, fromX, fromZ) {
  let total = 0, px = fromX, pz = fromZ;
  for (const p of path) { total += Math.hypot(p.x - px, p.z - pz); px = p.x; pz = p.z; }
  return total;
}

/* -------------------------- 収穫・素材回収(メイド専用) --------------------------
   既存のharvestCrop()/ranchHarvestBtnの処理は勇者の共有inventoryに直接加算するが、
   メイドは自分の荷物として持ち歩き、農協で売ってから収入として計上したいので、
   同じ判定ロジックを踏襲しつつ書き込み先だけ分けた専用関数にする。 */
function maidHarvestCrop(maid, fl) {
  if (computeCropStage(fl) !== 2) return false;
  const cropId = fl.cropType;
  maid.carryCrop[cropId] = (maid.carryCrop[cropId] || 0) + 1;
  // 追加(仕事内容変更 仕様2・13A): 同じ作物を植え直せるよう、直前の作物種類を記録する。
  fl.lastCropType = cropId;
  fl.cropType = null;
  fl.growthState = null;
  updateFarmlandCropVisual(fl);
  return true;
}
// 追加(仕事内容変更 仕様2・3): 収穫後の畑への種まき。既存のplantCrop()は勇者の共有
// inventory.seedを使うが、メイドは自分の所持品(carrySeed)を使う専用版にする
// (maidHarvestCrop/maidCollectRanchMaterialと同じ「書き込み先だけ分ける」設計を踏襲)。
function maidSowCrop(maid, fl, cropId) {
  if (!cropId || fl.cropType) return false;
  if ((maid.carrySeed[cropId] || 0) <= 0) return false;
  maid.carrySeed[cropId]--;
  fl.cropType = cropId;
  fl.growthState = { plantedAt: Date.now(), accumulatedSec: 0, lastAccrualAt: Date.now(), lastWateredDay: null };
  fl.cropStage = -1;
  updateFarmlandCropVisual(fl);
  return true;
}
// 追加(仕事内容変更 仕様3): メイドが「収穫後、同じ作物の種を持っていない畑」を検出する。
// ・畑ごとに1日1回だけ購入を試みたい(無限に同じ購入処理を繰り返さない仕様)ため、
//   購入に失敗した日はfl._maidSeedSkipDayに当日のjstHourSerialを記録してスキップする。
// ・他のメイドが既に向かっている畑(_maidReserved)は対象から外す(二重対応防止)。
function maidFieldNeedsSeed(fl, maid, today) {
  if (maidFloorYieldedToVillagers()) return false; // 変更1: 領民がいるフロアでは種の買い出しもしない
  if (fl.cropType) return false;
  if (!fl.lastCropType) return false; // 一度も収穫したことがない畑は自動まき直しの対象外
  if (fl._maidReserved && fl._maidReserved !== maid.id) return false;
  if (fl._villagerReserved) return false; // 領民が対応中の畑(js/villager.js)
  if (fl._maidSeedSkipDay === today) return false;
  return (maid.carrySeed[fl.lastCropType] || 0) <= 0;
}
function maidHasSeedNeed(maid) {
  // 変更(領民の生活仕様): 以前はここで「領民がいるフロアではメイドを停止」していたが廃止した。
  // 領民との競合は、管理対象ごとの予約(_villagerReserved)だけで避ける(maidFieldNeedsSeed参照)。
  const today = currentGameDayIndex(Date.now());
  return farmlands.some(fl => maidFieldNeedsSeed(fl, maid, today));
}
// 追加(仕事内容変更 仕様3・5): 農協で、種が無い畑の分だけ種を購入する。
// ・既存の農協の価格(CROPS[].seedPrice)をそのまま使う(新しい価格体系を作らない)。
// ・ゴールドが足りない作物は購入せず、対象の畑すべてに当日のスキップ印を付けて
//   無限に同じ購入を試み続けないようにする(仕様3・13D)。
// ・同じ作物が必要な畑が複数あれば、ゴールドが許す範囲でまとめて購入する(仕様6: 効率化)。
function maidBuySeedsAtAgri(maid) {
  const today = currentGameDayIndex(Date.now());
  const needFields = farmlands.filter(fl => maidFieldNeedsSeed(fl, maid, today));
  if (!needFields.length) return;
  const cropIds = [...new Set(needFields.map(fl => fl.lastCropType))];
  let bought = false;
  cropIds.forEach(cropId => {
    const def = getCropDef(cropId);
    if (!def) return;
    if ((maid.carrySeed[cropId] || 0) <= 0) {
      if (playerGold >= def.seedPrice) {
        playerGold -= def.seedPrice;
        maid.carrySeed[cropId] = (maid.carrySeed[cropId] || 0) + 1;
        bought = true;
      } else {
        // ゴールド不足: この作物が必要な畑は今日はもう試さない
        needFields.forEach(fl => { if (fl.lastCropType === cropId) fl._maidSeedSkipDay = today; });
        return;
      }
    }
    const fieldsOfCrop = needFields.filter(fl => fl.lastCropType === cropId).length;
    while ((maid.carrySeed[cropId] || 0) < fieldsOfCrop && playerGold >= def.seedPrice) {
      playerGold -= def.seedPrice;
      maid.carrySeed[cropId] = (maid.carrySeed[cropId] || 0) + 1;
      bought = true;
    }
  });
  if (bought) updateRewardHud();
}
function maidCollectRanchMaterial(maid, r) {
  if (!ranchHarvestReady(r)) return false;
  const amount = r.count * CONFIG.ranchHarvestPerHead;
  const def = MONSTER_DEFS[r.type];
  if (def && def.material && amount > 0) {
    maid.carryMaterial[def.material.key] = (maid.carryMaterial[def.material.key] || 0) + amount;
  }
  ranchMarkHarvested(r); // 次に収穫できるのは次の朝6:00から(js/ranch.js)
  return true;
}

/* ------------------------------- 性格: 野生モンスターには近寄らない -------------------------------
   「野生」= 生きていて(e.alive)、家畜化されていない(!e.tamed)モンスター(ボスを含む)。
   家畜化済みのモンスターは今までどおり怖がらない。
   ・仕事の目的地(農地・牧場)や徘徊先が野生モンスターに近いなら選ばない
   ・経路(A*の結果)が野生モンスターに近づくなら、その経路の仕事は選ばない
   ・移動中/作業中/待機中に野生モンスターが近くに来たら、その場の行動を中止して別の行動を選び直す
   既存のA*や移動処理(maidFindPath/maidStepMove)は変更せず、「選ぶ時」と「定期確認」で見るだけ。 */
function maidWildMonsterNear(x, z, r) {
  for (const e of enemies) {
    if (!e.alive || e.tamed || !e.mesh) continue;
    if (Math.hypot(x - e.mesh.position.x, z - e.mesh.position.z) < r) return e;
  }
  return null;
}
// 経路が野生モンスターに近づくか。出発点の時点で既に近い場合は「そこより近づかない」ことだけを求める
// (逃げる経路が必ず不合格になるのを防ぐ)。経路は線分を約1ユニットごとに確かめる。
function maidPathNearWild(path, fromX, fromZ) {
  if (!path || !path.length) return false;
  const r = CONFIG.maid.wildAvoidDist;
  const wild = [];
  for (const e of enemies) {
    if (!e.alive || e.tamed || !e.mesh) continue;
    const ex = e.mesh.position.x, ez = e.mesh.position.z;
    const d0 = Math.hypot(fromX - ex, fromZ - ez);
    if (d0 > r + 60) continue; // 遠すぎて経路に影響しない
    wild.push({ ex, ez, lim: Math.min(r, d0 - 0.5) });
  }
  if (!wild.length) return false;
  let px = fromX, pz = fromZ;
  for (const p of path) {
    const len = Math.hypot(p.x - px, p.z - pz);
    const n = Math.max(1, Math.ceil(len / 1.0));
    for (let i = 1; i <= n; i++) {
      const x = px + (p.x - px) * (i / n), z = pz + (p.z - pz) * (i / n);
      for (const w of wild) if (Math.hypot(x - w.ex, z - w.ez) < w.lim) return true;
    }
    px = p.x; pz = p.z;
  }
  return false;
}
// 仕事を探している最中に、野生モンスターのせいで見送った時に呼ぶ(しばらく仕事探しを待つ)
function maidHoldBecauseWild(maid) {
  maid.wildHoldUntil = performance.now() + CONFIG.maid.wildHoldSec * 1000;
}
// 野生モンスターが近くにいる(=今の行動を中止して離れるべき)か。一定間隔でしか実際には確認しない。
function maidShouldFleeWild(maid) {
  const now = performance.now();
  if (maid.wildCheckAt && now - maid.wildCheckAt < CONFIG.maid.wildCheckIntervalSec * 1000) return false;
  maid.wildCheckAt = now;
  return !!maidWildMonsterNear(maid.group.position.x, maid.group.position.z, CONFIG.maid.wildFleeDist);
}

/* ------------------------------- 性格: 野生モンスターが近い時は勇者の後ろに隠れる -------------------------------
   これまでは野生モンスターが近づくと「その場の行動を中止して別の行動を選び直す(=離れる)」だったが、
   今後は勇者(姫)の後ろへ回り込んで隠れる。野生モンスターの定義(maidWildMonsterNear)は変更なし。
   ・隠れる地点 = 勇者の位置から見て、最も近い野生モンスターと反対側へ hideBehindDist だけ離れた地点
   ・歩けない場所(建物・山・柵の外壁など)なら角度をずらして探し、見つからなければ従来どおり行動を選び直す
   ・移動は通常のメイドの移動(maidFindPath/maidStepMove)なので瞬間移動はしない
   ・野生モンスターがhideReleaseDist以内にいなくなってから少し経つと、通常のAI(maidDecideNext)へ戻る */
function maidNearestWild(x, z, r) {
  let best = null, bestD = r;
  for (const e of enemies) {
    if (!e.alive || e.tamed || !e.mesh) continue;
    const d = Math.hypot(x - e.mesh.position.x, z - e.mesh.position.z);
    if (d < bestD) { bestD = d; best = e; }
  }
  return best;
}
// 勇者の「後ろ」(野生モンスターと反対側)の地点を返す。置けない場合は角度をずらして探し、無ければnull。
function maidPickHideSpot(maid) {
  if (!player || !maid.group) return null;
  const C = CONFIG.maid;
  const hx = player.position.x, hz = player.position.z;
  const mx = maid.group.position.x, mz = maid.group.position.z;
  const threat = maidNearestWild(mx, mz, Infinity);
  if (!threat) return null;
  let dx = hx - threat.mesh.position.x, dz = hz - threat.mesh.position.z;
  let len = Math.hypot(dx, dz);
  if (len < 0.01) { dx = hx - mx; dz = hz - mz; len = Math.hypot(dx, dz); }
  if (len < 0.01) { dx = 0; dz = 1; len = 1; }
  const base = Math.atan2(dz / len, dx / len);
  const offsets = [0, 0.6, -0.6, 1.2, -1.2, 1.9, -1.9];
  for (const off of offsets) {
    const tx = hx + Math.cos(base + off) * C.hideBehindDist;
    const tz = hz + Math.sin(base + off) * C.hideBehindDist;
    if (!isPassable(tx, tz)) continue;
    const c = farmlandCellOf(tx, tz);
    if (!maidCellWalkable(c.a, c.b)) continue;
    return { x: tx, z: tz };
  }
  return null;
}
// 隠れる行動を始める。始められたらtrue。勇者が遠い/隠れる場所が無い場合はfalse(呼び出し側が従来の行動へ)。
function maidStartHiding(maid) {
  if (!player || !maid.group) return false;
  const C = CONFIG.maid;
  const dHero = Math.hypot(maid.group.position.x - player.position.x, maid.group.position.z - player.position.z);
  if (dHero > C.hideMaxHeroDist) return false;
  if (!maidPickHideSpot(maid)) return false;
  maidReleaseReservation(maid);
  maid.destKind = 'hide'; maid.destRef = null; maid.destTask = null; maid.destCropId = null;
  maid.state = MAID_STATE.HIDING;
  maid.path = null; maid.pathIndex = 0;
  maid.moving = false;
  maid.hideRepathAt = 0;
  maid.hideClearSince = 0;
  maid.hideNoPathSince = 0;
  const now = performance.now();
  if (!maid.hideSayAt || now - maid.hideSayAt >= C.hideSayCooldownSec * 1000) {
    maid.hideSayAt = now;
    maidSay(maid, maidPickHideLine(), C.bubbleSec);
  }
  return true;
}
function maidStopHiding(maid) {
  maid.moving = false;
  maid.path = null; maid.pathIndex = 0;
  maidDecideNext(maid);
}
function maidHandleHidingState(maid, dt) {
  if (!player) { maidStopHiding(maid); return; }
  const C = CONFIG.maid;
  const now = performance.now();
  const mx = maid.group.position.x, mz = maid.group.position.z;
  const hx = player.position.x, hz = player.position.z;
  const dHero = Math.hypot(mx - hx, mz - hz);
  // 勇者が遠くへ行ってしまった(別フロアへ移動した等)なら諦めて通常のAIへ戻る
  if (dHero > C.hideMaxHeroDist * 1.2) { maidStopHiding(maid); return; }
  // 野生モンスターがいなくなったら、少し経ってから通常のAIへ戻る
  if (!maidWildMonsterNear(mx, mz, C.hideReleaseDist)) {
    if (!maid.hideClearSince) maid.hideClearSince = now;
    else if (now - maid.hideClearSince >= C.hideReleaseDelaySec * 1000) { maidStopHiding(maid); return; }
  } else {
    maid.hideClearSince = 0;
  }
  // 隠れる地点(勇者の後ろ)を定期的に取り直す。勇者が動いてもついていく。
  const hasPath = !!maid.path && maid.pathIndex < maid.path.length;
  if (now >= (maid.hideRepathAt || 0)) {
    maid.hideRepathAt = now + C.hideRepathSec * 1000;
    const spot = maidPickHideSpot(maid);
    if (spot) {
      const dSpot = Math.hypot(mx - spot.x, mz - spot.z);
      if (dSpot > 0.8 || (hasPath && dSpot > C.arriveDist)) {
        const path = maidFindPath(mx, mz, spot.x, spot.z);
        if (path) { maid.path = path; maid.pathIndex = 0; maid.hideNoPathSince = 0; }
        else {
          maid.path = null; maid.pathIndex = 0;
          if (!maid.hideNoPathSince) maid.hideNoPathSince = now;
          else if (now - maid.hideNoPathSince >= C.hideGiveUpSec * 1000) { maidHoldBecauseWild(maid); maidStopHiding(maid); return; }
        }
      }
    }
  }
  if (maid.path && maid.pathIndex < maid.path.length) {
    if (maidStepMove(maid, dt)) { maid.path = null; maid.pathIndex = 0; maid.moving = false; }
  } else {
    maid.moving = false;
    // 着いたら勇者のほうを向いて、後ろでじっとしている
    const ang = Math.atan2(hx - mx, hz - mz);
    maid.group.rotation.y = lerpAngle(maid.group.rotation.y, ang, 1 - Math.pow(0.001, dt * C.turnLerp));
  }
}

/* ------------------------------- 挨拶・吹き出し -------------------------------
   メイドが勇者から1コマ(CONFIG.farmlandSize)以内に来たら、頭の上の吹き出しで挨拶する。
   セリフは直近greetNoRepeat回(10回)ぶんは使わない選び方なので、10回続けても同じセリフは出ない。
   (セリフの数はgreetNoRepeatより多く保つこと。少ない場合は安全側で全セリフから選ぶ) */
const MAID_GREETINGS = [
  '姫様、ごきげんよう。今日も眩しいです♡',
  'あっ姫様! こんなに近くでお会いできるなんて♪',
  '姫様、お怪我はございませんか? わたくし心配で…',
  '今日も姫様のおそばにいられて、幸せです♡',
  '姫様、お水はお飲みになりましたか?',
  'メイド長の座より、姫様のお側がずっと大切ですわ♪',
  '姫様、髪に葉っぱがついておりますよ。うふふ♡',
  '姫様、がんばっていらっしゃいますね。誇らしいです!',
  '姫様、今日もお勤めご苦労さまです♪',
  '姫様のためなら、どんなお仕事も喜んで♡',
  '無理はなさらないでくださいね、姫様。',
  '姫様、少し休憩なさいませんか? 紅茶をご用意しますわ。',
  'ふふっ、姫様のお顔を見ると元気が出ますの♪',
  '姫様、今日はどんな冒険になるのでしょう? ワクワクしますわ!',
  '姫様の一番のお世話係は、わたくしですからね♡',
  'あら姫様、ちょうどお会いしたかったところです!',
  '姫様、お腹は空いていませんか? 無理は禁物ですよ。',
  '畑のことはお任せくださいませ、姫様♪',
  'お勉強もお仕事も、お姉さんにお任せください♡',
  '姫様の笑顔が、わたくしの一番のご褒美ですわ。',
  'ずっとずっと、姫様についてまいります♡',
  '姫様、ご武運をお祈りしております!',
  'あっ、姫様! 今日もかっこいいです♪',
  '姫様、疲れたらいつでも甘えてくださいね。',
  '王宮の皆にも見せたいですわ、立派な姫様を♪',
  '姫様、お洋服が少し汚れていますよ。あとで直しますね♡',
];
const MAID_HIDE_LINES = [
  'ひゃっ! 姫様、後ろに失礼します…!',
  'こ、怖いですぅ…姫様、お願いします!',
  '姫様ぁ…あの子、苦手なんです…',
  '姫様の後ろなら安心ですわ…!',
  '野生の子はちょっと…姫様、お任せします!',
  '姫様、どうかお守りくださいませ…!',
];
let maidGreetHistory = [];   // 直近に使った挨拶のインデックス(古い順)
let maidHideLineLast = -1;
function maidPickGreeting() {
  const n = Math.max(0, CONFIG.maid.greetNoRepeat | 0);
  const recent = maidGreetHistory.slice(-n);
  let cands = [];
  for (let i = 0; i < MAID_GREETINGS.length; i++) if (recent.indexOf(i) < 0) cands.push(i);
  if (cands.length === 0) for (let i = 0; i < MAID_GREETINGS.length; i++) cands.push(i);
  const idx = cands[Math.floor(Math.random() * cands.length)];
  maidGreetHistory.push(idx);
  if (maidGreetHistory.length > Math.max(n, 1)) maidGreetHistory = maidGreetHistory.slice(-Math.max(n, 1));
  return MAID_GREETINGS[idx];
}
function maidPickHideLine() {
  let idx = Math.floor(Math.random() * MAID_HIDE_LINES.length);
  if (MAID_HIDE_LINES.length > 1 && idx === maidHideLineLast) idx = (idx + 1) % MAID_HIDE_LINES.length;
  maidHideLineLast = idx;
  return MAID_HIDE_LINES[idx];
}
// 頭上の吹き出し(キャンバステクスチャのSprite。敵のHPバーと同じ方式)。メイドごとに1つ作って使い回す。
function maidMakeBubble() {
  const canvas = document.createElement('canvas');
  canvas.width = 640; canvas.height = 176;
  const tex = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false, transparent: true });
  const sprite = new THREE.Sprite(mat);
  const w = CONFIG.maid.bubbleWidth;
  sprite.scale.set(w, w * canvas.height / canvas.width, 1);
  sprite.position.y = CONFIG.maid.bubbleY;
  sprite.renderOrder = 999;
  sprite.visible = false;
  return { sprite, canvas, ctx: canvas.getContext('2d'), tex };
}
function maidDrawBubble(b, text) {
  const ctx = b.ctx, W = b.canvas.width, H = b.canvas.height;
  ctx.clearRect(0, 0, W, H);
  const pad = 8, tail = 22, r = 28;
  const x0 = pad, y0 = pad, x1 = W - pad, y1 = H - pad - tail;
  ctx.beginPath();
  ctx.moveTo(x0 + r, y0); ctx.lineTo(x1 - r, y0); ctx.arcTo(x1, y0, x1, y0 + r, r);
  ctx.lineTo(x1, y1 - r); ctx.arcTo(x1, y1, x1 - r, y1, r);
  ctx.lineTo(W / 2 + 18, y1); ctx.lineTo(W / 2, y1 + tail); ctx.lineTo(W / 2 - 18, y1);
  ctx.lineTo(x0 + r, y1); ctx.arcTo(x0, y1, x0, y1 - r, r);
  ctx.lineTo(x0, y0 + r); ctx.arcTo(x0, y0, x0 + r, y0, r);
  ctx.closePath();
  ctx.fillStyle = 'rgba(255,250,246,0.96)'; ctx.fill();
  ctx.lineWidth = 6; ctx.strokeStyle = '#ff8fb3'; ctx.stroke();
  const fontSize = 38, lineH = 46, maxW = W - pad * 2 - 40;
  ctx.font = 'bold ' + fontSize + 'px "Hiragino Sans","Noto Sans JP","Yu Gothic",sans-serif';
  ctx.fillStyle = '#5a2a3a'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const lines = []; let cur = '';
  for (const ch of String(text)) {
    if (cur && ctx.measureText(cur + ch).width > maxW) { lines.push(cur); cur = ch; } else cur += ch;
  }
  if (cur) lines.push(cur);
  const shown = lines.slice(0, 3);
  const top = (y0 + y1) / 2 - (shown.length - 1) * lineH / 2;
  shown.forEach((ln, i) => ctx.fillText(ln, W / 2, top + i * lineH));
  b.tex.needsUpdate = true;
}
function maidSay(maid, text, sec) {
  if (!maid || !maid.group) return;
  if (!maid.bubble) { maid.bubble = maidMakeBubble(); maid.group.add(maid.bubble.sprite); }
  maidDrawBubble(maid.bubble, text);
  maid.bubble.sprite.visible = true;
  maid.bubbleUntil = performance.now() + (sec || CONFIG.maid.bubbleSec) * 1000;
}
// 毎フレーム: 吹き出しの表示時間の管理と、勇者から1コマ以内に来たときの挨拶
function maidGreetTick(maid) {
  const now = performance.now();
  if (maid.bubble && maid.bubble.sprite.visible && now > (maid.bubbleUntil || 0)) maid.bubble.sprite.visible = false;
  if (!player || !maid.group) return;
  if (typeof playerDeadLock !== 'undefined' && playerDeadLock) return;
  const C = CONFIG.maid, cell = CONFIG.farmlandSize;
  const d = Math.hypot(maid.group.position.x - player.position.x, maid.group.position.z - player.position.z);
  if (d > C.greetRearmCells * cell) maid.greetArmed = true; // 十分離れたら、次の接近でまた挨拶できる
  if (maid.greetArmed === false) return;
  if (d > C.greetCells * cell) return;
  if (maid.state === MAID_STATE.HIDING) return;              // 怖がっている間は挨拶しない
  if (maid.state === MAID_STATE.SLEEPING) return;            // 眠っている間(教会の中)は挨拶しない
  if (now < (maid.greetReadyAt || 0)) return;
  maid.greetArmed = false;
  maid.greetReadyAt = now + C.greetCooldownSec * 1000;
  maidSay(maid, maidPickGreeting(), C.bubbleSec);
}

/* ------------------------------- 管理地の探索 ------------------------------- */
function maidFarmlandCandidates(maid) {
  const list = [];
  if (maidFloorYieldedToVillagers()) return list; // 変更1: 領民がいるフロアの農地は領民が担当する
  // 変更(領民の生活仕様): 「領民がいるフロアではメイド停止」を廃止し、領民が予約中(対応中)の
  // 農地だけを避ける(js/villager.jsの_villagerReserved。領民側もメイドの_maidReservedを避ける)。
  for (const fl of farmlands) {
    if (fl._maidReserved && fl._maidReserved !== maid.id) continue;
    if (fl._villagerReserved) continue;
    if (maidWildMonsterNear(fl.x, fl.z, CONFIG.maid.wildAvoidDist)) continue; // 性格(臆病): 野生モンスターの近くの畑には行かない
    const stage = computeCropStage(fl);
    if (stage === 2) {
      list.push({ kind: 'farmland', task: 'harvest', ref: fl, x: fl.x, z: fl.z });
    } else if ((stage === 0 || stage === 1) && !isWateredToday(fl)) {
      // 追加(水やり): 収穫より優先度を上げる必要は無いが、放置すると成長が
      // 止まってしまうので収穫と同様に「作業が必要な管理地」として扱う。
      list.push({ kind: 'farmland', task: 'water', ref: fl, x: fl.x, z: fl.z });
    } else if (stage === -1 && !fl.cropType && fl.lastCropType && (maid.carrySeed[fl.lastCropType] || 0) > 0) {
      // 追加(仕事内容変更 仕様2・5): 収穫後(または元から空)の畑に、既に所持している
      // 種があれば種まきを行う。種を持っていない場合はここには含めず、
      // maidHasSeedNeed()経由で農協へ種を買いに行く判断に回す。
      list.push({ kind: 'farmland', task: 'sow', ref: fl, x: fl.x, z: fl.z, cropId: fl.lastCropType });
    }
  }
  return list;
}
function maidRanchCenterPoint(r) {
  if (!r.cellsArr || !r.cellsArr.length) return null;
  const parts = r.cellsArr[0].split(',').map(Number);
  return farmlandCellCenter(parts[0], parts[1]);
}
// 牧場で詰まった時の安全弁: 同じ牧場のセルのうち、家畜・勇者から最も離れている(空いている)順に
// 数セルだけA*で到達確認し、到達できる最初のセルを返す。無ければnull。
function maidRanchPickAltPoint(maid, r) {
  const px = maid.group.position.x, pz = maid.group.position.z;
  const cells = [];
  for (const ck of (r.cellsArr || [])) {
    const parts = ck.split(',').map(Number);
    const c = farmlandCellCenter(parts[0], parts[1]);
    if (Math.hypot(c.x - maid.destX, c.z - maid.destZ) < 0.01) continue; // 今の目的地は除く
    if (maidWildMonsterNear(c.x, c.z, CONFIG.maid.wildAvoidDist)) continue; // 性格(臆病): 野生モンスターの近くのセルは選ばない
    let clear = Infinity; // maidLocalBlockedと同じ半径を差し引いた「空き」
    for (const e of enemies) {
      if (!e.alive) continue;
      clear = Math.min(clear, Math.hypot(c.x - e.mesh.position.x, c.z - e.mesh.position.z) - (0.5 + 0.4 * (e.baseScale || 1)));
    }
    if (player) clear = Math.min(clear, Math.hypot(c.x - player.position.x, c.z - player.position.z) - 0.5);
    cells.push({ c, clear });
  }
  cells.sort((p, q) => q.clear - p.clear);
  for (const it of cells.slice(0, 4)) {
    const path = maidFindPath(px, pz, it.c.x, it.c.z);
    if (path) return { x: it.c.x, z: it.c.z, path };
  }
  return null;
}
// 牧場へ向かう途中で詰まった時(既存のstuck判定が上限を超えた時)に呼ぶ。
// true=別セルへ目的地を変えて移動を続ける / false=この牧場を一定時間候補から外した
// (呼び出し側が既存のmaidDecideNext()で次の仕事選択へ戻す)。
function maidRanchStuckRecover(maid) {
  const r = maid.destRef;
  if (!r || !ranches.includes(r)) return false;
  maid.ranchAltCount = (maid.ranchAltCount || 0) + 1;
  if (maid.ranchAltCount <= CONFIG.maid.ranchAltMaxTries) {
    const alt = maidRanchPickAltPoint(maid, r);
    if (alt) {
      maid.destX = alt.x; maid.destZ = alt.z;
      maid.path = alt.path; maid.pathIndex = 0;
      maidResetStuckTracking(maid);
      return true;
    }
  }
  if (!maid.ranchSkipUntil) maid.ranchSkipUntil = new Map();
  maid.ranchSkipUntil.set(r, performance.now() + CONFIG.maid.ranchSkipSec * 1000);
  return false;
}
function maidRanchSkipped(maid, r) {
  const until = maid.ranchSkipUntil && maid.ranchSkipUntil.get(r);
  if (!until) return false;
  if (performance.now() >= until) { maid.ranchSkipUntil.delete(r); return false; }
  return true;
}
function maidRanchCandidates(maid) {
  const list = [];
  if (maidFloorYieldedToVillagers()) return list; // 変更1: 領民がいるフロアの牧場は領民が担当する
  // 変更(領民の生活仕様): 「領民がいるフロアではメイド停止」を廃止し、領民が予約中(対応中)の
  // 牧場だけを避ける(js/villager.jsの_villagerReserved)。
  for (const r of ranches) {
    if (r._maidReserved && r._maidReserved !== maid.id) continue;
    if (r._villagerReserved) continue;
    if (!ranchHarvestReady(r)) continue;
    if (maidRanchSkipped(maid, r)) continue;
    const p = maidRanchCenterPoint(r);
    if (!p) continue;
    if (maidWildMonsterNear(p.x, p.z, CONFIG.maid.wildAvoidDist)) continue; // 性格(臆病): 野生モンスターの近くの牧場には行かない
    list.push({ kind: 'ranch', ref: r, x: p.x, z: p.z });
  }
  return list;
}
function maidHasCarry(maid) {
  for (const k in maid.carryCrop) if (maid.carryCrop[k] > 0) return true;
  for (const k in maid.carryMaterial) if (maid.carryMaterial[k] > 0) return true;
  return false;
}
// 仕様8: 直線距離が近い順に数件だけ、実際のA*経路長で比較し直す(重い全探索を避ける)
function maidPickNearestCandidate(maid, candidates) {
  if (!candidates.length) return null;
  const px = maid.group.position.x, pz = maid.group.position.z;
  candidates.sort((c1, c2) => Math.hypot(c1.x - px, c1.z - pz) - Math.hypot(c2.x - px, c2.z - pz));
  const shortlist = candidates.slice(0, 3);
  let best = null, bestLen = Infinity, bestPath = null, sawWildBlock = false;
  for (const c of shortlist) {
    const path = maidFindPath(px, pz, c.x, c.z);
    if (!path) continue;
    if (maidPathNearWild(path, px, pz)) { sawWildBlock = true; continue; } // 性格(臆病): 野生モンスターに近づく道は通らない
    const len = maidPathLength(path, px, pz);
    if (len < bestLen) { bestLen = len; best = c; bestPath = path; }
  }
  if (!best) { if (sawWildBlock) maidHoldBecauseWild(maid); return null; }
  return { candidate: best, path: bestPath, length: bestLen };
}

function maidReleaseReservation(maid) {
  if (maid.destRef && (maid.destKind === 'farmland' || maid.destKind === 'ranch')) {
    if (maid.destRef._maidReserved === maid.id) maid.destRef._maidReserved = null;
  }
}
function maidValidateDest(maid) {
  if (!maid.destKind) return false;
  // 変更1: 移動中・作業中に領民が来たら、その対象はもう担当しない(maidDecideNextへ戻る)
  if ((maid.destKind === 'farmland' || maid.destKind === 'ranch') && maidFloorYieldedToVillagers()) return false;
  if (maid.destKind === 'farmland') {
    if (!farmlands.includes(maid.destRef)) return false;
    if (maid.destTask === 'water') {
      const stage = computeCropStage(maid.destRef);
      return (stage === 0 || stage === 1) && !isWateredToday(maid.destRef);
    }
    if (maid.destTask === 'sow') {
      return !maid.destRef.cropType && maid.destRef.lastCropType === maid.destCropId && (maid.carrySeed[maid.destCropId] || 0) > 0;
    }
    return computeCropStage(maid.destRef) === 2; // 'harvest'
  }
  if (maid.destKind === 'ranch') {
    return ranches.includes(maid.destRef) && ranchHarvestReady(maid.destRef);
  }
  if (maid.destKind === 'agri' || maid.destKind === 'church' || maid.destKind === 'wander') return true;
  return false;
}

/* ------------------------------- 生活: 睡眠と食事(勇者と同じ時間割) -------------------------------
   【睡眠】 ゲーム内21:00〜翌6:00は就寝時間。メイドは教会の入口まで歩いて「おやすみなさい」を言い、
   中へ入って眠る(姿が見えなくなる)。朝6:00になると教会の入口に出てきて、仕事を再開する。
   勇者が教会で眠った時(夜に教会へ入った/21時の強制就寝)は、メイドも一緒に眠る(maidOnHeroSleep)。
   勇者が眠ると、ゲーム内の時計だけが朝6:00へ進むため、メイドも同じ瞬間に起きる。
   【食事】 空腹度(0〜100%)は勇者と同じ速さで減る(ゲーム内1時間で10%)。眠っている間と食事中は減らない。
   空腹度が eatBelow 以下になり、食堂が営業中(モーニング6-9 / ランチ11-14 / ディナー17-20)なら、
   食堂の入口まで歩いて行き、ゲーム内0.5時間かけて食べる。食べ終わると空腹度100%。
   食費はメイド自身の負担(payMeals=false。勇者のゴールドは減らない)。trueにすると、食べ終わったときに勇者のゴールドから払う(足りない時は食べに行かない)。
   【優先順位】 就寝 > 食事 > 仕事・うろつき。仕事中(収穫・売却の最中)は、その作業が終わってから切り替える。
   【性格(臆病)との関係】 食堂への道が野生モンスターに近い時は行かず、食事中・移動中に野生モンスターが
   近づけば、これまでどおり勇者の後ろに隠れる(隠れ終わったら、また就寝/食事を判断し直す)。
   既存のA*(maidFindPath)・移動(maidStepMove)はそのまま使うので、瞬間移動はしない
   (勇者の就寝に合わせて眠る時と、セーブから眠った状態で復元する時だけ、教会の入口で眠った扱いにする)。 */
const MAID_REAL_MS_PER_GAME_MIN = 2500; // ゲーム内1分 = 実時間2500ms(実1時間 = ゲーム内24時間。js/survival.jsと同じ)
const MAID_GOOD_NIGHT_LINES = [
  '姫様、もうお休みの時間ですわ。わたくしも休みますね。',
  'ふぁ…今日も一日お疲れさまでした、姫様。おやすみなさいませ。',
  'おやすみなさいませ、姫様。良い夢を…♡',
  '夜更かしは美容の大敵ですわよ、姫様。おやすみなさい。',
];
const MAID_WAKE_LINES = [
  'おはようございます、姫様! 今日もお仕事がんばりますね♪',
  '朝ですわ、姫様。しっかり休めましたか?',
  'ふぁ…おはようございます。朝ごはんは食堂で6時から9時ですよ。',
  '姫様、おはようございます! 今日も元気にまいりましょう♡',
  'ぐっすり眠れましたわ。さあ、お仕事の時間です!',
];
const MAID_MEAL_LINES = [
  'いただきます♪ …もぐもぐ。',
  'お腹ぺこぺこでしたの。いただきます!',
  '食堂のごはんは美味しいですわ♪ もぐもぐ…',
];
const MAID_FULL_LINES = [
  'ごちそうさまでした! これでまた働けますわ♪',
  'お腹いっぱいです♡ 午後もがんばります!',
  'ふぅ、満足ですわ。姫様もちゃんと召し上がってくださいね。',
];
const maidLineLast = {}; // 種類ごとに直前に使ったセリフの番号(同じセリフが続けて出ないようにする)
function maidPickLine(list, kind) {
  let idx = Math.floor(Math.random() * list.length);
  if (list.length > 1 && idx === maidLineLast[kind]) idx = (idx + 1) % list.length;
  maidLineLast[kind] = idx;
  return list[idx];
}
function maidLifeReady() {
  return CONFIG.maid.lifeEnabled !== false && typeof CONFIG.survival === 'object' && !!CONFIG.survival
    && typeof gameNow === 'function' && typeof computeGameClock === 'function'
    && typeof GameTime !== 'undefined' && !!GameTime.gameEpoch0;
}
function maidClockMinutes() {
  const c = computeGameClock(gameNow());
  return c.hour * 60 + c.minute;
}
function maidSleepHour() { return (CONFIG.survival && typeof CONFIG.survival.forceSleepHour === 'number') ? CONFIG.survival.forceSleepHour : 21; }
function maidWakeHour() { return (CONFIG.survival && typeof CONFIG.survival.wakeHour === 'number') ? CONFIG.survival.wakeHour : 6; }
function maidHungerMax() { return (CONFIG.survival && CONFIG.survival.hungerMax) || 100; }
function maidHungerPerSec() {
  const S = CONFIG.survival;
  return S ? S.hungerDropPerGameHour / S.gameHourRealSec : 0;
}
// 就寝時間(ゲーム内の時計): 21:00以上、または6:00未満
function maidIsBedtime() {
  if (!maidLifeReady()) return false;
  const h = computeGameClock(gameNow()).hour;
  return h >= maidSleepHour() || h < maidWakeHour();
}
// 今営業中の食事(モーニング/ランチ/ディナー)。営業終了まであと minLeftMin 分以上あるものだけ。無ければnull。
function maidOpenMeal(minLeftMin) {
  if (!CONFIG.survival || !Array.isArray(CONFIG.survival.meals)) return null;
  const m = maidClockMinutes();
  return CONFIG.survival.meals.find(x => m >= x.from * 60 && m + (minLeftMin || 0) < x.to * 60) || null;
}
function maidMealPrice(meal) { return CONFIG.maid.payMeals ? meal.price : 0; }
function maidWantsMeal(maid) {
  if (!maidLifeReady() || maidIsBedtime()) return false;
  if (maid.hunger > CONFIG.maid.eatBelow) return false;
  const meal = maidOpenMeal(CONFIG.maid.mealMinOpenLeftMin);
  if (!meal) return false;
  if (playerGold < maidMealPrice(meal)) return false; // お金が足りない時は食べに行かない
  return true;
}
// 教会の入口(寝る場所)・食堂の入口: 建物の+z側(看板と同じ向き)の、建物の当たり判定(半径3.2)の外側
function maidChurchDoorPoint() { return { x: CHURCH_POS.x, z: CHURCH_POS.z + CONFIG.maid.doorOffset }; }
function maidDinerBuilding() { return buildings.find(b => b.kind === 'diner') || null; }
function maidDinerDoorPoint() {
  const b = maidDinerBuilding();
  return b ? { x: b.x, z: b.z + CONFIG.maid.doorOffset } : null;
}
// 今の仕事・予約・目的地の情報を片付ける(就寝/食事へ切り替える時に使う。荷物(carry)はそのまま持つ)
function maidLifeClearTask(maid) {
  maidReleaseReservation(maid);
  maid.destRef = null; maid.destTask = null; maid.destCropId = null;
  maid.ranchAltCount = 0;
  maid.workHoldPose = null;
}
// 就寝/食事の目的地へ向かう。向かえたらtrue。経路が無い・食堂への道が危ない時はfalse(しばらく待ってからやり直す)。
function maidLifeGoTo(maid, kind) {
  const p = (kind === 'bed') ? maidChurchDoorPoint() : maidDinerDoorPoint();
  const now = performance.now();
  if (!p) { maid.lifeRetryAt = now + CONFIG.maid.lifeRetrySec * 1000; return false; }
  const mx = maid.group.position.x, mz = maid.group.position.z;
  const path = maidFindPath(mx, mz, p.x, p.z);
  if (!path) { maid.lifeRetryAt = now + CONFIG.maid.lifeRetrySec * 1000; return false; }
  // 食堂へ行く道・食堂の前が野生モンスターに近い時は行かない(臆病)。就寝は、教会が安全な場所なので
  // ここでは確かめず、道中で近づかれた時の「勇者の後ろに隠れる」に任せる。
  if (kind === 'diner' && (maidWildMonsterNear(p.x, p.z, CONFIG.maid.wildAvoidDist) || maidPathNearWild(path, mx, mz))) {
    maid.lifeRetryAt = now + CONFIG.maid.lifeRetrySec * 1000;
    return false;
  }
  const wasHeading = (maid.destKind === kind);
  maidLifeClearTask(maid);
  maid.destKind = kind; maid.destX = p.x; maid.destZ = p.z;
  maid.path = path; maid.pathIndex = 0;
  maid.lastReassessAt = now;
  maidResetStuckTracking(maid);
  maid.state = MAID_STATE.RETURNING;
  if (kind === 'bed' && !wasHeading) maidSay(maid, maidPickLine(MAID_GOOD_NIGHT_LINES, 'goodnight'), CONFIG.maid.bubbleSec);
  return true;
}
// 就寝時間なら教会へ、空腹で食堂が営業中なら食堂へ。向かえたらtrue。
function maidLifeDecide(maid) {
  if (!maidLifeReady() || !maid.group) return false;
  if (performance.now() < (maid.lifeRetryAt || 0)) return false;
  if (maidIsBedtime()) return maidLifeGoTo(maid, 'bed');
  if (maidWantsMeal(maid)) return maidLifeGoTo(maid, 'diner');
  return false;
}
// 毎フレーム(updateMaid): 空腹度を減らす/動いている最中に就寝・食事の時間になったら切り替える
function maidLifeTick(maid, dt) {
  if (!maidLifeReady()) return;
  if (maid.state !== MAID_STATE.SLEEPING && maid.state !== MAID_STATE.EATING) {
    maid.hunger = Math.max(0, maid.hunger - dt * maidHungerPerSec());
  }
  const now = performance.now();
  if (now < (maid.lifeCheckAt || 0)) return;
  maid.lifeCheckAt = now + 1000; // 切り替えの判断は1秒に1回
  // 動いている/待っている最中だけ割り込む(収穫・売却・隠れている最中は、終わってから maidDecideNext で判断する)
  if (maid.state !== MAID_STATE.WAITING && maid.state !== MAID_STATE.MOVING && maid.state !== MAID_STATE.RETURNING) return;
  if (maid.destKind === 'bed' || maid.destKind === 'diner') return; // もう向かっている
  maidLifeDecide(maid);
}

/* --- 睡眠 --- */
// 教会の入口に着いた: おやすみを言ってから、中へ入って眠る(maidHandleSleepingStateで姿を消す)
function maidStartSleeping(maid) {
  maid.state = MAID_STATE.SLEEPING;
  maid.sleepPhase = 'enter';
  maid.sleepEnterAt = performance.now() + CONFIG.maid.sleepEnterSec * 1000;
  maid.path = null; maid.pathIndex = 0; maid.moving = false;
  maid.destKind = 'bed';
  maid.group.rotation.y = Math.PI; // 教会(入口の奥=-z方向)のほうを向く
  playMaidPose(maid, MAID_POSE.IDLE, 0.2);
}
// すぐに教会の中で眠っている状態にする(勇者の就寝・セーブからの復元で使う)
function maidSleepNow(maid) {
  const p = maidChurchDoorPoint();
  maid.group.position.set(p.x, heightAt(p.x, p.z), p.z);
  maid.path = null; maid.pathIndex = 0; maid.moving = false;
  maid.destKind = 'bed';
  maid.state = MAID_STATE.SLEEPING;
  maid.sleepPhase = 'asleep';
  if (maid.bubble) maid.bubble.sprite.visible = false;
  maid.group.visible = false;
}
function maidHandleSleepingState(maid) {
  // 朝6:00(または生活の処理が無効になった時)に起きる
  if (!maidIsBedtime()) { maidWake(maid); return; }
  if (maid.sleepPhase === 'enter' && performance.now() >= maid.sleepEnterAt) {
    maid.sleepPhase = 'asleep';
    if (maid.bubble) maid.bubble.sprite.visible = false;
    maid.group.visible = false; // 教会の中へ入った
  }
}
function maidWake(maid) {
  const p = maidChurchDoorPoint();
  maid.group.visible = true;
  maid.group.position.set(p.x, heightAt(p.x, p.z), p.z);
  maid.group.rotation.y = 0; // 入口から外(+z方向)を向く
  maid.sleepPhase = null;
  maid.path = null; maid.pathIndex = 0; maid.moving = false;
  maid.lifeRetryAt = 0;
  maid.destKind = 'church';
  maidSay(maid, maidPickLine(MAID_WAKE_LINES, 'wake'), CONFIG.maid.bubbleSec);
  playMaidPose(maid, MAID_POSE.IDLE, 0.2);
  maidDecideNext(maid); // 空腹なら朝食へ、そうでなければ仕事へ
}
// 勇者が教会で眠った時(js/survival.jsのsvRunSleepから呼ばれる)に、メイドも一緒に眠る。
// この直後にゲーム内の時計が朝6:00へ進むので、次のフレームでmaidHandleSleepingStateが起こす。
function maidOnHeroSleep() {
  if (!maidLifeReady()) return;
  for (const maid of maids) {
    if (!maid.ready || maid.state === MAID_STATE.SLEEPING) continue;
    maidLifeClearTask(maid);
    maidSleepNow(maid);
  }
}

/* --- 食事 --- */
// 食堂の入口に着いた: 営業中でお金が足りていれば、食事を始める(ゲーム内0.5時間)
function maidStartEating(maid) {
  const meal = maidOpenMeal(0);
  if (!meal || playerGold < maidMealPrice(meal)) {
    // 営業時間が終わっていた/お金が足りない: しばらく食堂へは行かない
    maid.lifeRetryAt = performance.now() + CONFIG.maid.lifeRetrySec * 4000;
    maidDecideNext(maid);
    return;
  }
  maid.state = MAID_STATE.EATING;
  maid.eatMeal = meal;
  maid.eatEndAt = gameNow() + CONFIG.survival.dinerMealGameHours * 60 * MAID_REAL_MS_PER_GAME_MIN;
  maid.path = null; maid.pathIndex = 0; maid.moving = false;
  maid.destKind = 'diner';
  const b = maidDinerBuilding();
  if (b) maid.group.rotation.y = Math.atan2(b.x - maid.group.position.x, b.z - maid.group.position.z); // 食堂のほうを向く
  playMaidPose(maid, MAID_POSE.IDLE, 0.2);
  maidSay(maid, `${meal.icon} ` + maidPickLine(MAID_MEAL_LINES, 'meal'), CONFIG.maid.bubbleSec);
}
function maidHandleEatingState(maid) {
  // 性格(臆病): 食事中に野生モンスターが近づいたら、食事を中断して勇者の後ろに隠れる(食事代は払わない)
  if (maidShouldFleeWild(maid) && maidStartHiding(maid)) { maid.eatMeal = null; return; }
  // 食事中に就寝時間になった(勇者が眠ったなど): 食事を切り上げて、判断し直す
  if (maidIsBedtime()) { maid.eatMeal = null; maidDecideNext(maid); return; }
  if (gameNow() < maid.eatEndAt) return;
  const meal = maid.eatMeal;
  const price = meal ? Math.min(maidMealPrice(meal), playerGold) : 0;
  if (price > 0) {
    playerGold -= price;
    if (typeof updateRewardHud === 'function') updateRewardHud();
    spawnFloatingText(maid.group.position, `🍽-${price}G`, '#ffb4a0');
  }
  maid.hunger = maidHungerMax();
  maid.eatMeal = null;
  maidSay(maid, maidPickLine(MAID_FULL_LINES, 'full'), CONFIG.maid.bubbleSec);
  playMaidPose(maid, MAID_POSE.IDLE, 0.15);
  maidDecideNext(maid);
}

/* ------------------------------- 状態決定(SEARCHING) ------------------------------- */
function maidDecideNext(maid) {
  maidReleaseReservation(maid);
  maid.ranchAltCount = 0;
  maid.state = MAID_STATE.SEARCHING;
  // 生活(睡眠・食事)を最優先: 就寝時刻なら教会へ、空腹で食堂が営業中なら食堂へ向かう(行けない時は従来の仕事探しへ)
  if (maidLifeDecide(maid)) return;
  const candidates = [...maidFarmlandCandidates(maid), ...maidRanchCandidates(maid)];
  if (candidates.length > 0) {
    const picked = maidPickNearestCandidate(maid, candidates);
    if (picked) {
      maid.destKind = picked.candidate.kind;
      maid.destRef = picked.candidate.ref;
      maid.destTask = picked.candidate.task || null; // 'harvest' | 'water' | 'sow' (牧場の場合はnull)
      maid.destCropId = picked.candidate.cropId || null; // 'sow'タスクでまく作物の種類
      maid.destRef._maidReserved = maid.id; // 将来の複数メイド対応: 同じ管理地への重複進行を防ぐ
      maid.destX = picked.candidate.x; maid.destZ = picked.candidate.z;
      maid.path = picked.path; maid.pathIndex = 0;
      maid.lastReassessAt = performance.now();
      maidResetStuckTracking(maid);
      maid.state = MAID_STATE.MOVING;
      return;
    }
  }
  // 追加(仕事内容変更 仕様3・5): 売る荷物が無くても、種が足りない畑があれば
  // 農協へ買い出しに行く(既存の「売る荷物があれば農協へ」という判断を拡張)。
  if (maidHasCarry(maid) || maidHasSeedNeed(maid)) {
    const p = maidAgriSellPoint();
    const path = maidFindPath(maid.group.position.x, maid.group.position.z, p.x, p.z);
    const agriUnsafe = !!path && maidPathNearWild(path, maid.group.position.x, maid.group.position.z); // 性格(臆病)
    if (agriUnsafe) maidHoldBecauseWild(maid);
    if (path && !agriUnsafe) {
      maid.destKind = 'agri'; maid.destRef = null; maid.destTask = null; maid.destX = p.x; maid.destZ = p.z;
      maid.path = path; maid.pathIndex = 0;
      maid.lastReassessAt = performance.now();
      maidResetStuckTracking(maid);
      maid.state = MAID_STATE.MOVING;
      return;
    }
  }
  maidGoHome(maid);
}

/* --- 変更2(仕事が無いメイドは勇者の近くをうろつく) ---
   勇者の現在位置を基準に、wanderMinDist〜wanderMaxDistの範囲から安全な地点を最大wanderPickTries個
   試し、既存のA*(maidFindPath)で実際に到達できる最初の地点を目的地にする。
   ・歩ける場所(maidCellWalkable: 建物/掲示板/ゲストハウス/通行不可地形の外)だけを選ぶ
   ・作物の上・牧場の中では立ち止まらない(領民の徘徊と同じ基準)
   ・移動は通常のメイドの移動(maidStepMove)なので瞬間移動はしない
   見つからなければnullを返し、呼び出し側(maidGoHome)が従来の教会待機へフォールバックする。 */
function maidPickWanderTarget(maid) {
  if (!player || !maid.group) return null;
  const C = CONFIG.maid;
  const hx = player.position.x, hz = player.position.z;
  const mx = maid.group.position.x, mz = maid.group.position.z;
  for (let i = 0; i < C.wanderPickTries; i++) {
    const ang = Math.random() * Math.PI * 2;
    const d = C.wanderMinDist + Math.random() * (C.wanderMaxDist - C.wanderMinDist);
    const tx = hx + Math.cos(ang) * d, tz = hz + Math.sin(ang) * d;
    if (!isPassable(tx, tz)) continue;
    if (maidWildMonsterNear(tx, tz, C.wildAvoidDist)) continue; // 性格(臆病): 野生モンスターの近くではうろつかない
    const c = farmlandCellOf(tx, tz);
    if (!maidCellWalkable(c.a, c.b)) continue;
    const ck = farmlandCellKey(c.a, c.b);
    if (filledFarmlandCells.has(ck) || ranchZoneCellSet.has(ck)) continue;
    if (Math.hypot(tx - mx, tz - mz) < 1.0) continue; // 今いる場所とほぼ同じ地点は選び直す
    const path = maidFindPath(mx, mz, tx, tz);
    if (!path) continue;
    if (maidPathNearWild(path, mx, mz)) continue; // 性格(臆病): 野生モンスターに近づく道は通らない
    return { x: tx, z: tz, path };
  }
  return null;
}
// 待機中(WAITING)の毎フレーム呼ばれる。一定時間待ったら、または勇者が離れた/すぐ近くに来たら、
// 勇者の現在位置を基準に新しい目的地を選び直す(maidGoHome)。
function maidWanderTick(maid) {
  if (!player || !maid.group) return;
  const now = performance.now();
  if (maid.wanderRetryAt && now < maid.wanderRetryAt) return; // 直前に目的地が見つからなかった: 少し待つ
  const dHero = Math.hypot(maid.group.position.x - player.position.x, maid.group.position.z - player.position.z);
  const far = dHero > CONFIG.maid.wanderLeashDist;
  const near = dHero < CONFIG.maid.wanderNearDist;
  const scared = maidShouldFleeWild(maid); // 性格(臆病): 野生モンスターが近くに来たら勇者の後ろへ隠れる
  if (scared && maidStartHiding(maid)) return;
  if (far || near || scared || maid.destKind === 'church' || now >= (maid.wanderIdleUntil || 0)) maidGoHome(maid);
}

function maidGoHome(maid) {
  // 変更2: 通常動作は「勇者の近くをうろつく」。教会での待機は、目的地が見つからない時の
  // フォールバック(下の従来処理)としてのみ残している。
  const wt = maidPickWanderTarget(maid);
  if (wt) {
    maid.destKind = 'wander'; maid.destRef = null; maid.destTask = null; maid.destCropId = null;
    maid.destX = wt.x; maid.destZ = wt.z;
    maid.path = wt.path; maid.pathIndex = 0;
    maid.wanderRetryAt = 0;
    maid.lastReassessAt = performance.now();
    maidResetStuckTracking(maid);
    maid.state = MAID_STATE.RETURNING;
    return;
  }
  maid.wanderRetryAt = performance.now() + CONFIG.maid.wanderRetrySec * 1000;
  const home = maidChurchWaitPoint();
  const d = Math.hypot(maid.group.position.x - home.x, maid.group.position.z - home.z);
  maid.destKind = 'church'; maid.destRef = null; maid.destTask = null; maid.destX = home.x; maid.destZ = home.z;
  if (d <= CONFIG.maid.arriveDist * 2) {
    maid.state = MAID_STATE.WAITING;
    maid.path = null; maid.pathIndex = 0;
    return;
  }
  const path = maidFindPath(maid.group.position.x, maid.group.position.z, home.x, home.z);
  if (!path) { maid.state = MAID_STATE.WAITING; return; } // 安全側: 経路が無ければその場で待機に切り替える
  maid.path = path; maid.pathIndex = 0;
  maid.lastReassessAt = performance.now();
  maidResetStuckTracking(maid);
  maid.state = MAID_STATE.RETURNING;
}

/* ------------------------------- 30秒ごとの再判定・スタック対策 ------------------------------- */
function maidResetStuckTracking(maid) {
  maid.stuckCheckAt = performance.now();
  maid.stuckCheckPos = { x: maid.group.position.x, z: maid.group.position.z };
  maid.stuckRetries = 0;
}
function maidReassessIfNeeded(maid) {
  const now = performance.now();
  if (now - maid.lastReassessAt < CONFIG.maid.reassessIntervalSec * 1000) return;
  maid.lastReassessAt = now;
  if (maid.destKind === 'farmland' || maid.destKind === 'ranch') {
    if (!maidValidateDest(maid)) { maidDecideNext(maid); return; }
  }
  const px = maid.group.position.x, pz = maid.group.position.z;
  const stillPath = maidFindPath(px, pz, maid.destX, maid.destZ);
  if (!stillPath) { maidDecideNext(maid); return; }
  if (maid.destKind === 'farmland' || maid.destKind === 'ranch') {
    const remaining = maidPathLength(maid.path.slice(maid.pathIndex), px, pz);
    const candidates = [...maidFarmlandCandidates(maid), ...maidRanchCandidates(maid)]
      .filter(c => c.ref !== maid.destRef);
    const picked = maidPickNearestCandidate(maid, candidates);
    if (picked && picked.length + CONFIG.maid.reassessMinGainDist < remaining) {
      maidReleaseReservation(maid);
      maid.destKind = picked.candidate.kind; maid.destRef = picked.candidate.ref;
      maid.destTask = picked.candidate.task || null;
      maid.destCropId = picked.candidate.cropId || null;
      maid.destRef._maidReserved = maid.id;
      maid.destX = picked.candidate.x; maid.destZ = picked.candidate.z;
      maid.path = picked.path; maid.pathIndex = 0;
      maidResetStuckTracking(maid);
      return;
    }
  }
  maid.path = stillPath; maid.pathIndex = 0;
}
function maidCheckStuck(maid) {
  const now = performance.now();
  if (now - maid.stuckCheckAt < CONFIG.maid.stuckCheckIntervalSec * 1000) return false;
  const moved = Math.hypot(maid.group.position.x - maid.stuckCheckPos.x, maid.group.position.z - maid.stuckCheckPos.z);
  maid.stuckCheckAt = now;
  maid.stuckCheckPos = { x: maid.group.position.x, z: maid.group.position.z };
  if (moved >= CONFIG.maid.stuckMinMoveDist) { maid.stuckRetries = 0; return false; }
  maid.stuckRetries++;
  return true;
}

/* ------------------------------- 移動処理 ------------------------------- */
function maidLocalBlocked(nx, nz) {
  for (const f of fences) {
    if (f.isGate) continue;
    if (distanceToFenceSegment(nx, nz, f) < 0.42) return true;
  }
  if (player) {
    const d = Math.hypot(nx - player.position.x, nz - player.position.z);
    if (d < 0.5) return true;
  }
  for (const e of enemies) {
    if (!e.alive) continue;
    // 家畜化済みモンスターはメイドの移動障害物にしない。
    // A*の経路探索でも動的モンスターは障害物として登録していないため、
    // ここでもtamedを除外し、牧場内の家畜がメイドの進路を塞がないようにする。
    if (e.tamed) continue;
    const d = Math.hypot(nx - e.mesh.position.x, nz - e.mesh.position.z);
    if (d < 0.5 + 0.4 * (e.baseScale || 1)) return true;
  }
  return false;
}
function maidStepMove(maid, dt) {
  if (!maid.path || maid.pathIndex >= maid.path.length) return true;
  const wp = maid.path[maid.pathIndex];
  const dx = wp.x - maid.group.position.x, dz = wp.z - maid.group.position.z;
  const dist = Math.hypot(dx, dz);
  if (dist <= CONFIG.maid.arriveDist) {
    maid.pathIndex++;
    return maid.pathIndex >= maid.path.length;
  }
  const dirX = dx / dist, dirZ = dz / dist;
  const step = CONFIG.maid.moveSpeed * dt;
  const nx = maid.group.position.x + dirX * Math.min(step, dist);
  const nz = maid.group.position.z + dirZ * Math.min(step, dist);
  if (!maidLocalBlocked(nx, nz)) {
    maid.group.position.x = nx;
    maid.group.position.z = nz;
    maid.group.position.y = heightAt(nx, nz);
    maid.moving = true;
  } else {
    maid.moving = false; // 勇者/モンスターに一時的に道を塞がれている。次のフレームで再試行。
  }
  const targetAngle = Math.atan2(dirX, dirZ);
  maid.group.rotation.y = lerpAngle(maid.group.rotation.y, targetAngle, 1 - Math.pow(0.001, dt * CONFIG.maid.turnLerp));
  return false;
}

/* ------------------------------- 状態別ハンドラ ------------------------------- */
function maidHandleWaitingState(maid) {
  playMaidPose(maid, MAID_POSE.IDLE, 0.2);
  // 仕様11: WAITING中に新しい管理地(または売るべき荷物)が発生したら即座にSEARCHINGへ
  // 性格(臆病): 野生モンスターのせいで仕事に行けなかった直後は、少し待ってから探し直す(毎フレームのA*を避ける)
  const wildHold = maid.wildHoldUntil && performance.now() < maid.wildHoldUntil;
  if (!wildHold) {
    const candidates = [...maidFarmlandCandidates(maid), ...maidRanchCandidates(maid)];
    if (candidates.length > 0 || maidHasCarry(maid)) { maidDecideNext(maid); return; }
  }
  // 変更2: 仕事が無い間は勇者の近くをうろつく(一定時間待機→勇者を基準に新しい目的地を選ぶ)
  if (maid.destKind === 'wander' || maid.destKind === 'church') maidWanderTick(maid);
}
function maidHandleMovingState(maid, dt) {
  // 変更1: 向かっている途中で領民が来た(または領民のいるフロアへ移動した)場合は、
  // 農地・牧場への移動、および「種の買い出しだけ」の農協行きを取りやめる。
  if (maidFloorYieldedToVillagers() &&
      (maid.destKind === 'farmland' || maid.destKind === 'ranch' || (maid.destKind === 'agri' && !maidHasCarry(maid)))) {
    maidDecideNext(maid); return;
  }
  // 性格変更: 移動中に野生モンスターが近くへ来たら、勇者の後ろへ隠れる(隠れられない時は下の従来処理へ)。
  if (maidShouldFleeWild(maid) && maidStartHiding(maid)) return;
  // 性格(臆病): 野生モンスターが近くに来た/残りの経路が野生モンスターに近づくなら、行き先を選び直す。
  // (教会へ戻る最終フォールバックだけは対象外にして、選び直しの繰り返しを防ぐ)
  // 目的地そのものが野生モンスターに近づいた、または残りの経路が野生モンスターへ近づくなら選び直す。
  // 「今いる場所が野生モンスターに近い」だけでは選び直さない(すでに離れる方向へ歩いている間に何度も選び直さないため)。
  if (maid.destKind !== 'church' && maid.destKind !== 'bed' && maid.destKind !== 'diner' && maid.path && maid.pathIndex < maid.path.length) {
    const now2 = performance.now();
    if (!maid.wildMoveCheckAt || now2 - maid.wildMoveCheckAt >= CONFIG.maid.wildCheckIntervalSec * 1000) {
      maid.wildMoveCheckAt = now2;
      if (maidWildMonsterNear(maid.destX, maid.destZ, CONFIG.maid.wildAvoidDist) ||
          maidPathNearWild(maid.path.slice(maid.pathIndex), maid.group.position.x, maid.group.position.z)) {
        maidHoldBecauseWild(maid); maidDecideNext(maid); return;
      }
    }
  }
  // 変更2: 勇者が大きく移動して目的地が離れすぎたら、勇者の現在位置を基準に目的地を選び直す
  if (maid.destKind === 'wander' && player && !(maid.wanderRetryAt && performance.now() < maid.wanderRetryAt)) {
    if (Math.hypot(maid.destX - player.position.x, maid.destZ - player.position.z) > CONFIG.maid.wanderLeashDist) {
      maidGoHome(maid); return;
    }
  }
  if (!maid.path) {
    const path = maidFindPath(maid.group.position.x, maid.group.position.z, maid.destX, maid.destZ);
    if (!path) { maidDecideNext(maid); return; }
    maid.path = path; maid.pathIndex = 0;
    maid.lastReassessAt = performance.now();
    maidResetStuckTracking(maid);
  }
  maidReassessIfNeeded(maid);
  if (maidCheckStuck(maid)) {
    if (maid.stuckRetries > CONFIG.maid.stuckMaxRetries) {
      if (maid.destKind === 'ranch' && maidRanchStuckRecover(maid)) return;
      // 生活: 就寝/食堂へ行けずに詰まった時は、少し(10秒)待ってから従来の仕事探しへ(同じ場所へ再挑戦し続けない)
      if (maid.destKind === 'bed' || maid.destKind === 'diner') maid.lifeRetryAt = performance.now() + 10000;
      maidDecideNext(maid); return;
    }
    const newPath = maidFindPath(maid.group.position.x, maid.group.position.z, maid.destX, maid.destZ);
    if (newPath && !(maid.destKind !== 'church' && maidPathNearWild(newPath, maid.group.position.x, maid.group.position.z))) { maid.path = newPath; maid.pathIndex = 0; }
    else { maidDecideNext(maid); return; }
  }
  const arrived = maidStepMove(maid, dt);
  if (!arrived) return;
  if (maid.destKind === 'farmland' || maid.destKind === 'ranch') {
    if (!maidValidateDest(maid)) { maidDecideNext(maid); return; }
    maidStartWorking(maid);
  } else if (maid.destKind === 'agri') {
    maidStartSelling(maid);
  } else if (maid.destKind === 'church') {
    maid.state = MAID_STATE.WAITING;
    playMaidPose(maid, MAID_POSE.IDLE, 0.2);
  } else if (maid.destKind === 'bed') {
    // 生活: 教会の入口に着いた。まだ就寝時間なら眠る(時刻が過ぎていれば通常のAIへ)
    if (maidIsBedtime()) maidStartSleeping(maid); else maidDecideNext(maid);
  } else if (maid.destKind === 'diner') {
    maidStartEating(maid); // 生活: 食堂の入口に着いた
  } else if (maid.destKind === 'wander') {
    // 変更2: 目的地に着いたら少しその場で待機し、時間が来たら次の目的地を選ぶ(maidWanderTick)
    maid.state = MAID_STATE.WAITING;
    maid.wanderIdleUntil = performance.now() + (CONFIG.maid.wanderIdleMinSec + Math.random() * (CONFIG.maid.wanderIdleMaxSec - CONFIG.maid.wanderIdleMinSec)) * 1000;
    playMaidPose(maid, MAID_POSE.IDLE, 0.2);
  }
}
function maidStartWorking(maid) {
  maid.state = MAID_STATE.WORKING;
  maid.workSwings = 0; maid.workPhase = 'up'; maid.workTimer = 0;
  if (maid.destKind === 'ranch') {
    maid.workHoldPose = MAID_POSE.BAG;
  } else if (maid.destKind === 'farmland' && maid.destTask === 'water') {
    maid.workHoldPose = MAID_POSE.WATER; // 追加(水やり): ジョウロを構えるモーションを保持し続ける
  } else if (maid.destKind === 'farmland' && maid.destTask === 'sow') {
    // 追加(仕事内容変更): 種まき専用モーションはGLBに無いため、種袋を扱う動作として
    // 既存のBAGポーズ(牧場素材回収と同じ)を流用する。新しいGLBアニメーションは追加しない。
    maid.workHoldPose = MAID_POSE.BAG;
  } else {
    maid.workHoldPose = null; // ナイフの振り上げ/振り下ろし(収穫)
  }
  if (maid.workHoldPose) playMaidPose(maid, maid.workHoldPose, 0.1);
  else playMaidPose(maid, MAID_POSE.KNIFE_UP, 0.08);
}
function maidHandleWorkingState(maid, dt) {
  if (!maidValidateDest(maid)) { maidDecideNext(maid); return; }
  // 性格(臆病): 作業中に野生モンスターが近くへ来たら、作業を中断して離れる(予約は maidDecideNext が解放する)
  // 性格変更: 離れる(逃げる)のではなく勇者の後ろへ隠れる。隠れられない時だけ従来どおり行動を選び直す。
  if (maidShouldFleeWild(maid)) {
    if (maidStartHiding(maid)) return;
    maidHoldBecauseWild(maid); maidDecideNext(maid); return;
  }
  maid.workTimer += dt;
  if (maid.workHoldPose) {
    const cycle = CONFIG.maid.workSwingUpTime + CONFIG.maid.workSwingDownTime;
    if (maid.workTimer >= cycle) {
      maid.workTimer = 0; maid.workSwings++;
      if (maid.workSwings >= CONFIG.maid.workRequiredSwings) { maidFinishWorking(maid); return; }
      playMaidPose(maid, maid.workHoldPose, 0.05);
    }
    return;
  }
  const upT = CONFIG.maid.workSwingUpTime, downT = CONFIG.maid.workSwingDownTime;
  if (maid.workPhase === 'up' && maid.workTimer >= upT) {
    maid.workTimer = 0; maid.workPhase = 'down';
    playMaidPose(maid, MAID_POSE.KNIFE_DOWN, 0.05);
  } else if (maid.workPhase === 'down' && maid.workTimer >= downT) {
    maid.workSwings++;
    if (maid.workSwings >= CONFIG.maid.workRequiredSwings) { maidFinishWorking(maid); return; }
    maid.workTimer = 0; maid.workPhase = 'up';
    playMaidPose(maid, MAID_POSE.KNIFE_UP, 0.05);
  }
}
function maidFinishWorking(maid) {
  if (maid.destKind === 'farmland') {
    if (maid.destTask === 'water') waterCrop(maid.destRef, Date.now());
    else if (maid.destTask === 'sow') maidSowCrop(maid, maid.destRef, maid.destCropId);
    else maidHarvestCrop(maid, maid.destRef);
  } else if (maid.destKind === 'ranch') {
    maidCollectRanchMaterial(maid, maid.destRef);
  }
  maidReleaseReservation(maid);
  maid.destCropId = null;
  playMaidPose(maid, MAID_POSE.IDLE, 0.15);
  maidDecideNext(maid);
}
function maidStartSelling(maid) {
  maid.state = MAID_STATE.SELLING;
  maid.workTimer = 0;
  playMaidPose(maid, MAID_POSE.BAG, 0.1);
}
function maidHandleSellingState(maid, dt) {
  maid.workTimer += dt;
  if (maid.workTimer < CONFIG.maid.sellPauseSec) return;
  maidFinishSelling(maid);
}
function maidFinishSelling(maid) {
  let earned = 0;
  for (const cropId in maid.carryCrop) {
    const count = maid.carryCrop[cropId];
    if (count <= 0) continue;
    const def = getCropDef(cropId);
    if (def) earned += def.sellPrice * count;
    maid.carryCrop[cropId] = 0;
  }
  for (const key in maid.carryMaterial) {
    const count = maid.carryMaterial[key];
    if (count <= 0) continue;
    const def = Object.values(MONSTER_DEFS).find(d => d.material && d.material.key === key);
    if (def) earned += def.material.sellPrice * count;
    maid.carryMaterial[key] = 0;
  }
  if (earned > 0) {
    playerGold += earned;
    if (typeof royalRecordIncome === 'function') royalRecordIncome(earned); // 王家への仕送り(js/royal.js): 今月の収入に記録(精算は月替わり)
    updateRewardHud();
    spawnFloatingText(maid.group.position, `🧺+${earned}G`, '#ffe37a');
    showToast(`🧺 お助けメイドが素材・作物を売って${earned}Gを得た`, 1800);
  }
  // 追加(仕事内容変更 仕様5・6): 農協に来たついでに、種が足りない畑の分をまとめて購入する。
  maidBuySeedsAtAgri(maid);
  playMaidPose(maid, MAID_POSE.IDLE, 0.15);
  maidDecideNext(maid);
}

/* ------------------------------- アニメーション ------------------------------- */
function playMaidPose(maid, name, fadeTime) {
  if (!maid.poseActions) return;
  fadeTime = fadeTime === undefined ? 0.15 : fadeTime;
  const next = maid.poseActions[name];
  if (!next || next === maid.currentPose) return;
  next.reset();
  next.fadeIn(fadeTime);
  next.play();
  if (maid.currentPose) maid.currentPose.fadeOut(fadeTime);
  maid.currentPose = next;
}
function maidUpdateAnimationFrame(maid, dt) {
  if (maid.state === MAID_STATE.MOVING || maid.state === MAID_STATE.RETURNING || maid.state === MAID_STATE.HIDING) {
    if (maid.moving) {
      maid.runCycleTimer += dt;
      const RUN_STEP_TIME = 0.16;
      if (maid.runCycleTimer > RUN_STEP_TIME) {
        maid.runCycleTimer = 0;
        maid.runCycleIndex = (maid.runCycleIndex + 1) % maidRunCycleNames.length;
        playMaidPose(maid, maidRunCycleNames[maid.runCycleIndex], 0.08);
      }
    } else {
      playMaidPose(maid, MAID_POSE.IDLE, 0.2);
    }
  }
}

/* ------------------------------- メインの更新ループ ------------------------------- */
function updateMaid(maid, dt) {
  maidLifeTick(maid, dt); // 生活: 空腹度の減少・就寝/食事への切り替え
  switch (maid.state) {
    case MAID_STATE.WAITING: maidHandleWaitingState(maid); break;
    case MAID_STATE.MOVING:
    case MAID_STATE.RETURNING: maidHandleMovingState(maid, dt); break;
    case MAID_STATE.WORKING: maidHandleWorkingState(maid, dt); break;
    case MAID_STATE.SELLING: maidHandleSellingState(maid, dt); break;
    case MAID_STATE.HIDING: maidHandleHidingState(maid, dt); break;
    case MAID_STATE.EATING: maidHandleEatingState(maid); break;
    case MAID_STATE.SLEEPING: maidHandleSleepingState(maid); break;
  }
  maidUpdateAnimationFrame(maid, dt);
  maidGreetTick(maid); // 勇者から1コマ以内で挨拶/吹き出しの表示管理
}
function updateMaids(dt) {
  for (const maid of maids) {
    if (!maid.ready) continue;
    if (maid.mixer) maid.mixer.update(dt);
    updateMaid(maid, dt);
  }
}

/* ------------------------------- GLB読み込み・生成 ------------------------------- */
function ensureMaidBufferDecoded() {
  if (maidGlbArrayBuffer || maidLoadFailed) return;
  try {
    maidGlbArrayBuffer = base64ToArrayBuffer(MAID_GLB_BASE64);
  } catch (e) {
    console.error('メイドGLBのデコードに失敗しました:', e);
    maidLoadFailed = true;
  }
}
// メイド1体分のビジュアル一式を新たにパースして作る。単純なObject3D.clone()では
// スキンメッシュ(ボーン)が正しく複製されない(r128にSkeletonUtilsが同梱されていない)ため、
// 複数体になってもメイドごとに独立してGLBをパースする方式にする。
function loadMaidVisuals(onReady) {
  ensureMaidBufferDecoded();
  if (!maidGlbArrayBuffer) { onReady(null); return; }
  const loader = new THREE.GLTFLoader();
  loader.parse(maidGlbArrayBuffer.slice(0), '', (gltf) => {
    const model = gltf.scene;
    const box = new THREE.Box3().setFromObject(model);
    const size = new THREE.Vector3(); box.getSize(size);
    const targetHeight = 1.6; // 勇者よりわずかに小柄にして見分けやすくする
    const scale = size.y > 0 ? targetHeight / size.y : 1;
    model.scale.setScalar(scale);
    const box2 = new THREE.Box3().setFromObject(model);
    model.position.y -= box2.min.y;
    const mixer = new THREE.AnimationMixer(model);
    const poseActions = {};
    gltf.animations.forEach(clip => {
      const action = mixer.clipAction(clip);
      action.clampWhenFinished = true;
      action.loop = THREE.LoopOnce;
      poseActions[clip.name] = action;
    });
    onReady({ model, mixer, poseActions });
  }, (err) => {
    console.error('メイドGLBの読込に失敗しました:', err);
    onReady(null);
  });
}

/* ---------------------------------------------------------------------
   ユーザーGLB選択(メイドモデルの外部差し替え) 【今回追加・安全な拡張】
   既存の MAID_GLB_BASE64 埋め込み方式(ensureMaidBufferDecoded/loadMaidVisuals)は
   一切変更しない。ユーザーが選択した場合はmaidGlbArrayBufferを直接差し替えるだけなので、
   以後スポーンする新しいメイドにも自動的に反映される(loadMaidVisualsは
   「メイドごとに独立してGLBをパースする」既存の安全な仕組みをそのまま使う)。
   既に配置済みのメイドは1体ずつ再パースしてモデル/ミキサー/ポーズを差し替える。
   一部/全部の再パースに失敗しても既存メイドはそのまま維持され、ゲームは止まらない。
--------------------------------------------------------------------- */
const maidGlbFileInput = document.getElementById('maidGlbFileInput');
const maidGlbSelectBtn = document.getElementById('maidGlbSelectBtn');
const maidGlbStatusTextEl = document.getElementById('maidGlbStatusText');

function setMaidGlbStatus(msg, isError) {
  if (!maidGlbStatusTextEl) return;
  if (!msg) { maidGlbStatusTextEl.style.display = 'none'; maidGlbStatusTextEl.textContent = ''; return; }
  maidGlbStatusTextEl.style.display = 'block';
  maidGlbStatusTextEl.textContent = msg;
  maidGlbStatusTextEl.style.color = isError ? '#ff8c8c' : '#ffffff';
}

function applyUserMaidGlbBuffer(buffer) {
  maidGlbArrayBuffer = buffer;
  maidLoadFailed = false;

  const readyMaids = maids.filter(m => m.ready);
  if (readyMaids.length === 0) {
    setMaidGlbStatus('GLB読み込み完了(次に雇うメイドから反映されます)');
    return;
  }

  let remaining = readyMaids.length;
  let successCount = 0;
  readyMaids.forEach((maid) => {
    loadMaidVisuals((visuals) => {
      remaining--;
      if (visuals) {
        successCount++;
        const oldModel = maid.model;
        if (oldModel && oldModel.parent) oldModel.parent.remove(oldModel);
        maid.model = visuals.model;
        maid.mixer = visuals.mixer;
        maid.poseActions = visuals.poseActions;
        maid.currentPose = null;
        if (maid.group) maid.group.add(maid.model);
        if (oldModel) disposeUserModel(oldModel);
        playMaidPose(maid, MAID_POSE.IDLE, 0); // 次フレームで各状態のポーズ更新処理が正しいポーズに上書きする
      }
      if (remaining === 0) {
        setMaidGlbStatus(successCount > 0
          ? `GLB読み込み完了(メイド${successCount}体に反映しました)`
          : 'GLB読み込みに失敗しました', successCount === 0);
      }
    });
  });
}

if (maidGlbFileInput) {
  maidGlbFileInput.addEventListener('change', () => {
    const file = maidGlbFileInput.files && maidGlbFileInput.files[0];
    maidGlbFileInput.value = '';
    if (!file) return;

    const lowerName = (file.name || '').toLowerCase();
    if (!lowerName.endsWith('.glb')) {
      setMaidGlbStatus('.glb形式のファイルを選択してください', true);
      return;
    }
    if (file.size > USER_GLB_MAX_BYTES) {
      setMaidGlbStatus('ファイルサイズが大きすぎるため読み込めませんでした', true);
      return;
    }

    setMaidGlbStatus('読み込み中…');

    Promise.resolve().then(() => file.arrayBuffer()).then((buffer) => {
      applyUserMaidGlbBuffer(buffer);
    }).catch((err) => {
      console.error('メイドGLBファイルの読み込みに失敗しました:', err);
      setMaidGlbStatus('GLB読み込みに失敗しました', true);
    });
  });
}

if (maidGlbSelectBtn) {
  maidGlbSelectBtn.addEventListener('click', () => {
    if (maidGlbFileInput) maidGlbFileInput.click();
  });
}

function maidApplyRestoredState(maid, opts) {
  if (!opts.restoreState) return;
  if (opts.restoreState === 'HIDING' || opts.restoreDestKind === 'hide') { maidDecideNext(maid); return; } // 念のため(通常はセーブされない)
  // 生活: 眠っている状態でセーブされていて、ロード時もまだ就寝時間なら、そのまま教会で眠っている状態から始める
  if (opts.restoreState === MAID_STATE.SLEEPING) {
    if (maidLifeReady() && maidIsBedtime()) maidSleepNow(maid); else maidDecideNext(maid);
    return;
  }
  let destRef = null, valid = true;
  if (opts.restoreDestKind === 'farmland') {
    destRef = farmlands.find(fl => fl.id === opts.restoreFarmlandId) || null;
    valid = !!destRef;
  } else if (opts.restoreDestKind === 'ranch') {
    destRef = ranches.find(r => r.cellKey === opts.restoreRanchCellKey) || null;
    valid = !!destRef;
  }
  if (!valid || !opts.restoreDestKind) { maidDecideNext(maid); return; }
  maid.destKind = opts.restoreDestKind;
  maid.destRef = destRef;
  maid.destTask = opts.restoreDestTask || null;
  maid.destCropId = opts.restoreDestCropId || null;
  if (destRef) destRef._maidReserved = maid.id;
  maid.destX = typeof opts.restoreDestX === 'number' ? opts.restoreDestX : maid.destX;
  maid.destZ = typeof opts.restoreDestZ === 'number' ? opts.restoreDestZ : maid.destZ;
  if (opts.restoreState === MAID_STATE.WORKING && (maid.destKind === 'farmland' || maid.destKind === 'ranch')) {
    maidStartWorking(maid);
  } else if (opts.restoreState === MAID_STATE.SELLING) {
    maidStartSelling(maid);
  } else if (opts.restoreState === MAID_STATE.WAITING) {
    maid.state = MAID_STATE.WAITING;
  } else {
    maid.state = (maid.destKind === 'church' || maid.destKind === 'wander') ? MAID_STATE.RETURNING : MAID_STATE.MOVING;
    maid.path = null; // 次のupdateMaidsで経路を計算し直す
  }
}
function spawnMaid(opts) {
  opts = opts || {};
  const home = maidChurchWaitPoint();
  const startX = typeof opts.x === 'number' ? opts.x : home.x;
  const startZ = typeof opts.z === 'number' ? opts.z : home.z;
  const maid = {
    id: maidIdCounter++,
    role: 'any', // 将来の役割分担(農地担当/牧場担当など)用のプレースホルダ。今回は未使用。
    ready: false,
    group: null, model: null, mixer: null, poseActions: null, currentPose: null,
    state: MAID_STATE.WAITING,
    destKind: 'church', destRef: null, destTask: null, destCropId: null, destX: home.x, destZ: home.z,
    path: null, pathIndex: 0,
    moving: false, runCycleIndex: 0, runCycleTimer: 0,
    workSwings: 0, workPhase: 'up', workTimer: 0, workHoldPose: null,
    carryCrop: {}, carryMaterial: {}, carrySeed: {},
    hunger: (typeof opts.hunger === 'number' && Number.isFinite(opts.hunger)) ? Math.max(0, Math.min(maidHungerMax(), opts.hunger)) : maidHungerMax(), // 生活: 空腹度(旧セーブには無い→満腹から)
    lifeRetryAt: 0, lifeCheckAt: 0, sleepPhase: null, sleepEnterAt: 0, eatMeal: null, eatEndAt: 0,
    lastReassessAt: performance.now(),
    stuckCheckAt: performance.now(), stuckCheckPos: { x: startX, z: startZ }, stuckRetries: 0,
  };
  CROPS.forEach(c => {
    maid.carryCrop[c.id] = (opts.carryCrop && opts.carryCrop[c.id]) || 0;
    maid.carrySeed[c.id] = (opts.carrySeed && opts.carrySeed[c.id]) || 0;
  });
  Object.values(MONSTER_DEFS).forEach(d => {
    if (d.material) maid.carryMaterial[d.material.key] = (opts.carryMaterial && opts.carryMaterial[d.material.key]) || 0;
  });
  maids.push(maid);
  loadMaidVisuals((visuals) => {
    if (!visuals) {
      maidLoadFailed = true;
      const idx = maids.indexOf(maid);
      if (idx >= 0) maids.splice(idx, 1);
      return;
    }
    maid.model = visuals.model; maid.mixer = visuals.mixer; maid.poseActions = visuals.poseActions;
    maid.group = new THREE.Group();
    maid.group.add(maid.model);
    maid.group.position.set(startX, heightAt(startX, startZ), startZ);
    scene.add(maid.group);
    maid.ready = true;
    maidApplyRestoredState(maid, opts);
    if (maid.state === MAID_STATE.WAITING) playMaidPose(maid, MAID_POSE.IDLE, 0);
  });
  return maid;
}
function clearAllMaids() {
  [...maids].forEach(m => {
    if (m.bubble) { m.bubble.tex.dispose(); m.bubble.sprite.material.dispose(); }
    if (m.group) scene.remove(m.group);
  });
  maids.length = 0;
}

/* ------------------------------- セーブ/ロード連携(仕様18) ------------------------------- */
function gatherMaidsSaveData() {
  return maids.filter(m => m.ready).map(m => ({
    id: m.id,
    x: m.group.position.x, z: m.group.position.z,
    // 隠れている最中・食事中はセーブ上は待機扱い(ロード後に通常AIが再開する)。眠っている間はSLEEPINGのまま保存する。
    state: (m.state === MAID_STATE.HIDING || m.state === MAID_STATE.EATING) ? MAID_STATE.WAITING : m.state,
    destKind: (m.state === MAID_STATE.HIDING || m.state === MAID_STATE.EATING) ? 'church' : m.destKind,
    hunger: Math.round(m.hunger * 100) / 100, // 生活: 空腹度(追加キー。旧セーブには無く、読み込み側で満腹扱い)
    destTask: m.destTask,
    destCropId: m.destCropId,
    destX: m.destX, destZ: m.destZ,
    destFarmlandId: (m.destKind === 'farmland' && m.destRef) ? m.destRef.id : null,
    destRanchCellKey: (m.destKind === 'ranch' && m.destRef) ? m.destRef.cellKey : null,
    carryCrop: { ...m.carryCrop },
    carryMaterial: { ...m.carryMaterial },
    carrySeed: { ...m.carrySeed },
  }));
}
// farmlands/ranchesの復元が完了した後に呼ぶこと(destFarmlandId/destRanchCellKeyの解決に必要)。
// 注: オフライン中の仕事の反映(仕様8-11)は、この関数の呼び出し前にrunMaidOfflineWork()で
// 済ませておく(farmlands/ranchesの状態を直接進めるだけで、メイド個体には依存しないため)。
function restoreMaidsFromSave(list) {
  clearAllMaids();
  if (!Array.isArray(list) || list.length === 0) {
    spawnMaid({}); // 仕様1: 旧セーブデータでも必ず1人はいる状態にする
    return;
  }
  let maxId = 0;
  list.forEach(rec => {
    spawnMaid({
      x: rec.x, z: rec.z,
      carryCrop: rec.carryCrop, carryMaterial: rec.carryMaterial, carrySeed: rec.carrySeed,
      hunger: rec.hunger,
      restoreState: rec.state, restoreDestKind: rec.destKind, restoreDestTask: rec.destTask,
      restoreDestCropId: rec.destCropId,
      restoreDestX: rec.destX, restoreDestZ: rec.destZ,
      restoreFarmlandId: rec.destFarmlandId, restoreRanchCellKey: rec.destRanchCellKey,
    });
    if (typeof rec.id === 'number') maxId = Math.max(maxId, rec.id);
  });
  maidIdCounter = Math.max(maidIdCounter, maxId + 1);
}

/* ------------------------------- デバッグ表示(仕様22) ------------------------------- */
function maidDestLabel(maid) {
  if (maid.destKind === 'hide') return '勇者の後ろ(隠れる)';
  if (maid.destKind === 'church') return '教会';
  if (maid.destKind === 'bed') return '教会(就寝)';
  if (maid.destKind === 'diner') return '食堂';
  if (maid.destKind === 'wander') return '勇者の近く';
  if (maid.destKind === 'agri') return '農協';
  if (maid.destKind === 'farmland') return '農地';
  if (maid.destKind === 'ranch') return '牧場';
  return 'なし';
}
function maidWorkLabel(maid) {
  if (maid.state !== MAID_STATE.WORKING) return 'なし';
  if (maid.destKind === 'ranch') return '素材回収';
  if (maid.destKind === 'farmland') {
    if (maid.destTask === 'water') return '水やり';
    if (maid.destTask === 'sow') return '種まき';
    return '収穫';
  }
  return 'なし';
}
function updateMaidDebugPanel() {
  if (!maidDebugVisible || !debugInfoEl) return;
  if (!maids.length) { debugInfoEl.textContent = 'メイド: なし'; return; }
  const lines = maids.map((m, i) => {
    if (!m.ready) return `メイド${i + 1}: 読み込み中...`;
    const remain = Math.max(0, CONFIG.maid.reassessIntervalSec * 1000 - (performance.now() - m.lastReassessAt)) / 1000;
    const pathLen = m.path ? (m.path.length - m.pathIndex) : 0;
    return [
      `メイド${i + 1}状態: ${m.state}`,
      `目的地: ${maidDestLabel(m)}`,
      `残り経路: ${pathLen}点`,
      `現在の作業: ${maidWorkLabel(m)}`,
      `空腹度: ${Math.round(m.hunger)}%`,
      `次回再判定まで: ${remain.toFixed(1)}秒`,
      `所持している種: ${Object.entries(m.carrySeed || {}).filter(([, v]) => v > 0).map(([k, v]) => `${k}x${v}`).join(', ') || 'なし'}`,
    ].join('\n');
  });
  debugInfoEl.textContent = lines.join('\n---\n');
}
/* =====================================================================================
   オフライン処理(仕事内容変更 仕様8〜11) 【今回追加】
   -------------------------------------------------------------------------------------
   設計方針:
   ・ユーザーがゲームを閉じている間も、メイドは畑と牧場の世話を続けていたものとして
     扱う。ただし仕様8により「3Dキャラクターを実際に歩かせる必要はない」ため、
     移動・所持品(carryCrop等)は一切使わず、farmlands/ranchesの状態と
     playerGoldだけを、経過した実時間ぶんまとめて前進させる「状態のみ」の処理にする。
   ・時間の進め方は、既存の仕組み(作物: CROPS[].growSeconds/accumulatedSec、
     牧場: ranches[].nextHarvestAt/CONFIG.ranchHarvestGameDaySec)をそのまま使う。
     新しい時間体系や「経過時間×固定額」のような簡易計算は行わない(仕様10で明示的に
     禁止されている)。
   ・二重適用防止: 「最後にオフライン処理を実行した時刻」(maidWorkLastProcessedAt)を
     セーブデータに保持し、そこから現在時刻までの分だけを1回だけ処理する
     (game.html側のapplySaveData()から一度だけ呼ばれる想定)。
   ===================================================================================== */
let maidWorkLastProcessedAt = null; // セーブデータのworldState.maidOfflineState.lastProcessedAtと対応

const MAID_OFFLINE_MAX_CYCLES = 3000; // 極端に長いオフライン期間でも処理が必ず終わるようにする安全弁

// 種を購入できるか試す(状態のみ)。既存の農協の価格(seedPrice)をそのまま使い、
// ゴールドが足りなければ購入しない(仕様10: ゴールドをマイナスにしない)。
function maidOfflineTryBuySeed(cropId) {
  const def = getCropDef(cropId);
  if (!def) return false;
  if (playerGold < def.seedPrice) return false;
  playerGold -= def.seedPrice;
  if (typeof MaidReport !== 'undefined') MaidReport.record('seed', -def.seedPrice); // メイドからの報告(js/maid-report.js): 内訳の記録のみ
  return true;
}
// 1枚の畑について、[fromEpoch, toEpoch)の間の「(収穫後なら)同じ作物の種をまく→
// 生育→収穫して農協で売る」というサイクルを、既存のgrowSeconds/accumulatedSecの
// 仕組みをそのまま使ってまとめて進める。移動を伴わないため、収穫物はその場で
// 農協に売った結果(playerGoldの増加)として扱う(仕様8: 状態だけ反映する)。
function maidOfflineAdvanceFarmland(fl, fromEpoch, toEpoch) {
  let cursor = fromEpoch;
  let cycles = 0;
  while (cursor < toEpoch && cycles < MAID_OFFLINE_MAX_CYCLES) {
    cycles++;
    if (!fl.cropType) {
      // 収穫後(または元から未使用)の畑: 直前と同じ作物の種があれば(無ければ購入して)まく
      if (!fl.lastCropType) break; // 一度も収穫したことがない畑は自動まき直しの対象外(仕様2)
      if (!maidOfflineTryBuySeed(fl.lastCropType)) break; // ゴールド不足: この畑はここで打ち切る(仕様3・10)
      fl.cropType = fl.lastCropType;
      fl.growthState = { plantedAt: cursor, accumulatedSec: 0, lastAccrualAt: cursor, lastWateredDay: currentGameDayIndex(cursor) };
      fl.cropStage = -1;
      continue;
    }
    const def = getCropDef(fl.cropType);
    if (!def) break;
    const remainSec = Math.max(0, def.growSeconds - fl.growthState.accumulatedSec);
    const remainMs = remainSec * 1000;
    if (cursor + remainMs <= toEpoch) {
      // このサイクル内に収穫期まで到達する: 収穫して農協で売り、次のループで種をまき直す
      cursor += remainMs;
      playerGold += def.sellPrice;
      if (typeof MaidReport !== 'undefined') MaidReport.record('crop', def.sellPrice); // メイドからの報告: 農作物販売
      fl.lastCropType = fl.cropType;
      fl.cropType = null; fl.growthState = null; fl.cropStage = -1;
    } else {
      // 期間内には収穫できない: 経過した分だけ育てて終了
      const elapsedSec = (toEpoch - cursor) / 1000;
      fl.growthState.accumulatedSec += elapsedSec;
      fl.growthState.lastAccrualAt = toEpoch;
      fl.growthState.lastWateredDay = currentGameDayIndex(toEpoch);
      cursor = toEpoch;
    }
  }
}
// 1つの牧場について、素材の剥ぎ取りクールダウン(既存のr.nextHarvestAt/
// CONFIG.ranchHarvestGameDaySec)をそのまま使い、toEpochまでに剥ぎ取り可能になった
// 回数分だけ剥ぎ取り→農協で売る(仕様4・10: 同じサイクルを二重に処理しない)。
function maidOfflineAdvanceRanch(r, toEpoch) {
  let cycles = 0;
  // nextHarvestAtはゲーム内時刻(gameNow基準)なので、実時刻toEpochにskewを足して同じ基準で比べる
  const toGameEpoch = toEpoch + farmSkewMs();
  while (r.count > 0 && r.nextHarvestAt <= toGameEpoch && cycles < MAID_OFFLINE_MAX_CYCLES) {
    cycles++;
    const def = MONSTER_DEFS[r.type];
    if (def && def.material) {
      const amount = r.count * CONFIG.ranchHarvestPerHead;
      playerGold += amount * def.material.sellPrice;
      if (typeof MaidReport !== 'undefined') MaidReport.record('material', amount * def.material.sellPrice); // メイドからの報告: 素材販売
    }
    r.lastHarvestAt = r.nextHarvestAt;
    r.nextHarvestAt = ranchNextMorningAfter(r.nextHarvestAt); // 次の朝6:00
  }
}
// エントリポイント。game.html側のapplySaveData()から、farmlands/ranchesの復元
// (worldState.farmlands / worldState.ranches の反映)が終わった後、
// restoreMaidsFromSave()より前に1回だけ呼ぶ。
function runMaidOfflineWork(fromEpoch, toEpoch) {
  if (!(toEpoch > fromEpoch)) return { gained: 0 };
  const beforeGold = playerGold;
  farmlands.forEach(fl => maidOfflineAdvanceFarmland(fl, fromEpoch, toEpoch));
  ranches.forEach(r => maidOfflineAdvanceRanch(r, toEpoch));
  refreshAllCrops(); // 直接書き換えたcropType/growthStateを見た目に反映する(farmland.js)
  const gained = playerGold - beforeGold;
  // 王家への仕送り(js/royal.js): 閉じていた間の収益を月ごとの収入として記録する(精算は月替わりに1回)
  if (gained > 0 && typeof royalRecordIncome === 'function') {
    royalRecordIncome(gained, { spanMonths: royalSpanMonths(fromEpoch, toEpoch) });
  }
  return { gained };
}

const debugInfoEl = document.getElementById('debugInfo');
const maidDebugBtnEl = document.getElementById('maidDebugBtn');
if (maidDebugBtnEl) {
  maidDebugBtnEl.addEventListener('click', () => {
    maidDebugVisible = !maidDebugVisible;
    if (debugInfoEl) {
      debugInfoEl.style.display = maidDebugVisible ? 'block' : 'none';
      if (!maidDebugVisible) debugInfoEl.textContent = '';
    }
  });
}
