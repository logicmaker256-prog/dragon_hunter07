/* ---------------------------------------------------------------------
   留守の島の経過処理(js/island-offscreen.js)
   「勇者がいない島でも領民・農地・牧場の活動を継続させる(朝6:00に収支集計・報告)」対応。

   【停止原因(調査で確認したこと)】
   ・領民は updateVillagerWalk() が「v.floor !== currentFloor」の領民を動かさず、
     villagerListWorkTargets() / villagerExecuteWork() も「現在の階」だけを対象にしている。
   ・farmlands / ranches は「今いる階」のデータだけを入れたライブ配列で、他の階の農地・牧場は
     floorWorldStates[階] に“ただのデータ”として退避されたまま動かない(作物の水やり日・牧場の
     次回収穫時刻も進まない)。
   → 勇者が別の島にいる間、その島の領民の仕事は丸ごと止まっていた。

   【この処理の方針】
   ・勇者がいない島の floorWorldStates[階](農地・牧場のデータ)を、キャラクターの移動や描画を
     一切せずに「状態だけ」まとめて前進させる(軽量なオフスクリーン処理)。
   ・勇者がいる島は従来のリアルタイム処理のまま(ここでは触らない=二重処理しない)。
   ・作物の育ち方・水やり・牧場の剥ぎ取り周期は既存ルールをそのまま使う:
       作物: growSeconds / growthState.accumulatedSec / lastWateredDay(水をやった日だけ育つ。実時間基準)
       牧場: nextHarvestAt(ゲーム内の朝6:00ごとに1回)
       収入: 領民経由の売上は税として勇者へ floor(売値×taxRate)(js/villager.jsと同じ式)
       種:   持っていればそれを使い、無ければ seedPrice で購入(ゴールド不足なら買わず止まる)
   ・領民が作業できる条件は既存ルールに合わせる: その島に領民がいる/安全地帯の島/
     農地・牧場が領民の担当地区(縦5×横5)の中/1人の1日の作業量に上限。
   ・島ごとに「最後に処理した時刻(ゲーム内g と実時間r)」を持ち、セーブに保存する
     (worldState.islandOffscreen)。その時刻から今までの未処理分だけを1回だけ処理する。
   ・計算結果(農地・牧場・ゴールド・種・処理済み時刻)は、全部計算し終えてから一緒に反映する。
     計算中に例外が出たら何も反映しない(収支だけ先に反映される不整合を避ける)。

   【呼ばれるタイミング】
   ・onMorning(): 勇者が眠って朝6:00に目覚めた直後(js/survival.js)。勇者がいない全島を処理。
   ・onLeave(階): 勇者が島を離れる時。その島の「処理済み時刻」を今にする(ライブ処理がそこまで進めたため)。
   ・onArrive(階): 勇者が島に着く時(農地を復元する直前)。前回の集計から今までの未処理分だけを
     その島で処理して取り込む(朝6:00以外の島移動でも未処理分を失わない)。

   【再現しないもの(未対応)】
   領民の見た目の移動・歩行、メイドの作業、領民の維持費(既存の月替わり処理が全島分をすでに
   徴収している)、王家への仕送りの月ごとの精算(既存の royal.js が行う。ここでは収入の記録だけ)。
--------------------------------------------------------------------- */

const IslandOffscreen = (() => {
  const CFG = {
    version: 1,
    dayWorkPerVillager: 40, // 領民1人が1ゲーム日にこなせる作業数(水やり/収穫/植え付け/牧場回収を各1回)
    maxCatchUpDays: 36,     // 1回の処理で遡る最大日数(超えた古い分は切り捨てて新しい36日分だけ処理)
  };
  const DAY_MS = 3600000;   // ゲーム内1日 = 実1時間(farmMorningDayIndexと同じ)

  let state = {};           // { [階]: { g: 最後に処理したゲーム内時刻(ms), r: そのときの実時刻(ms) } }
  let lastReport = null;    // 直近の集計結果(確認・デバッグ用)

  const isNum = n => typeof n === 'number' && Number.isFinite(n);
  const clone = o => JSON.parse(JSON.stringify(o));
  const nowG = () => (typeof gameNow === 'function') ? gameNow() : Date.now();

  /* ---------- 島の表示名 ---------- */
  function floorLabel(floor) {
    try {
      if (typeof IslandManager !== 'undefined') {
        const nm = IslandManager.getDefaultName(IslandManager.legacyFloorToIslandId(floor));
        if (nm) return `${floor}階の島「${nm}」`;
      }
    } catch (e) { /* 名前が取れなくても番号で表示する */ }
    return `${floor}階の島`;
  }

  /* ---------- 1つの島を [fromG, toG] まで進める(状態のコピーに対してだけ行う。何も書き換えない) ----------
     pool: { gold, seeds } 全島で共有する「計算中の所持金・種」(呼び出し側のコピー) */
  function computeIsland(floor, fromG, fromR, toG, toR, pool) {
    const out = { floor, processed: false, reason: '', income: 0, expense: 0, net: 0, cropTax: 0, ranchTax: 0,
                  seedCost: 0, harvests: 0, ranchHarvests: 0, planted: 0, watered: 0, seedsUsed: {}, stalled: 0,
                  truncated: false, farmlands: null, ranches: null };
    const st = floorWorldStates[floor];
    const vs = villagers.filter(v => v && v.floor === floor && Number.isInteger(v.no));
    if (!st) { out.reason = 'データなし'; return out; }
    if (!vs.length) { out.reason = '領民なし'; return out; }
    if (typeof isFloorSafeZone === 'function' && !isFloorSafeZone(floor)) { out.reason = '安全地帯ではない'; return out; }
    let spanG = toG - fromG;
    if (!(spanG > 0)) { out.reason = '経過なし'; return out; }
    let realSpan = Math.max(0, toR - fromR);
    const capMs = CFG.maxCatchUpDays * DAY_MS;
    if (spanG > capMs) { realSpan = realSpan * capMs / spanG; fromG = toG - capMs; spanG = capMs; out.truncated = true; }

    const farmlands2 = clone(Array.isArray(st.farmlands) ? st.farmlands : []);
    const ranches2 = clone(Array.isArray(st.ranches) ? st.ranches : []);
    const taxRate = CONFIG.villager.taxRate;

    // 担当地区: その点を担当地区に含む領民の番号(複数いれば全員が候補)
    const eligOf = (x, z) => { const a = []; vs.forEach((v, i) => { if (villagerPointInDistrict(v.no, x, z)) a.push(i); }); return a; };
    // 1日ごとの各領民の残り作業枠
    const budgets = new Map();
    const take = (day, elig) => {
      let b = budgets.get(day);
      if (!b) { b = vs.map(() => CFG.dayWorkPerVillager); budgets.set(day, b); }
      for (const i of elig) { if (b[i] > 0) { b[i]--; return true; } }
      return false;
    };
    const ownedSeedId = () => {
      if (typeof CROPS === 'undefined') return null;
      for (const c of CROPS) if ((pool.seeds[c.id] || 0) > 0) return c.id;
      return null;
    };

    /* --- 農地(既存の「水をやった日だけ育つ」ルール) --- */
    const fromDay = farmMorningDayIndex(fromG), toDay = farmMorningDayIndex(toG);
    const fls = farmlands2.map(fl => ({ fl, elig: (fl && isNum(fl.x) && isNum(fl.z)) ? eligOf(fl.x, fl.z) : [] }));
    for (let D = fromDay; D <= toDay; D++) {
      const segS = Math.max(fromG, farmMorningStartOfDay(D)), segE = Math.min(toG, farmMorningStartOfDay(D + 1));
      if (!(segE > segS)) continue;
      const credit0 = realSpan / 1000 * (segE - segS) / spanG; // この区間に割り当てる実時間の秒数(成長に使える分)
      for (const it of fls) {
        const fl = it.fl;
        if (!fl || !it.elig.length) continue;
        if (fl.growthState && !isNum(fl.growthState.accumulatedSec)) continue; // 旧形式の生育データは触らない(ロード時の既存変換に任せる)
        let credit = credit0, guard = 0;
        while (guard++ < 20) {
          if (fl.cropType && fl.growthState) {
            const def = getCropDef(fl.cropType);
            if (!def) break;
            const gs = fl.growthState;
            if (gs.accumulatedSec < def.growSeconds) {
              if (gs.lastWateredDay !== D) {
                if (!take(D, it.elig)) { out.stalled++; break; } // 人手不足: この日は水やりできず育たない
                gs.lastWateredDay = D; out.watered++;
              }
              const need = def.growSeconds - gs.accumulatedSec;
              if (credit < need) { gs.accumulatedSec += credit; break; }
              gs.accumulatedSec = def.growSeconds; credit -= need; // 収穫期に到達
            }
            if (!take(D, it.elig)) { out.stalled++; break; }
            // 収穫→農協で販売: 領民経由の売上のうち勇者へ入る税(villagerSellCrop と同じ式)
            const tax = Math.floor(def.sellPrice * taxRate);
            out.income += tax; out.cropTax += tax; out.harvests++;
            fl.lastCropType = fl.cropType; fl.cropType = null; fl.growthState = null;
            continue; // 次のループで植え直し
          }
          // 空の畑: 収穫済み(lastCropTypeあり)は同じ作物を植え直す。新規の畑は「持っている種」がある時だけ。
          let cropId = null, buy = false;
          if (fl.lastCropType) {
            cropId = fl.lastCropType;
            const def = getCropDef(cropId);
            if (!def) break;
            if ((pool.seeds[cropId] || 0) > 0) buy = false;
            else if (pool.gold >= def.seedPrice) buy = true;
            else { out.stalled++; break; } // 種もゴールドも足りない: 既存仕様どおり植えずに止まる
          } else {
            cropId = ownedSeedId();
            if (!cropId) break;
          }
          if (!take(D, it.elig)) { out.stalled++; break; }
          if (buy) { const price = getCropDef(cropId).seedPrice; pool.gold -= price; out.expense += price; out.seedCost += price; }
          else { pool.seeds[cropId]--; out.seedsUsed[cropId] = (out.seedsUsed[cropId] || 0) + 1; }
          fl.cropType = cropId;
          fl.growthState = { plantedAt: toR, accumulatedSec: 0, lastAccrualAt: toR, lastWateredDay: null };
          out.planted++;
        }
      }
    }
    // 反映後にゲーム側の settleCropGrowth が同じ分を二重に加算しないよう、「今」まで加算済みにしておく
    farmlands2.forEach(fl => { if (fl && fl.cropType && fl.growthState && isNum(fl.growthState.accumulatedSec)) fl.growthState.lastAccrualAt = toR; });

    /* --- 牧場(ゲーム内の朝6:00ごとに1回の剥ぎ取り。既存の nextHarvestAt をそのまま使う) --- */
    for (const r of ranches2) {
      if (!r || !(r.count > 0) || typeof r.cellKey !== 'string') continue;
      const first = r.cellKey.split('|')[0].split(',').map(Number);
      if (first.length < 2 || !first.every(isNum)) continue;
      const c = farmlandCellCenter(first[0], first[1]);
      const elig = eligOf(c.x, c.z);
      if (!elig.length) continue;
      const def = MONSTER_DEFS[r.type];
      let next = isNum(r.nextHarvestAt) ? r.nextHarvestAt : fromG, guard = 0;
      while (next <= toG && guard++ < 400) {
        const h = Math.max(next, fromG);                 // 勇者が島を離れた時刻より前には遡らない
        if (!take(farmMorningDayIndex(h), elig)) { out.stalled++; break; } // 人手不足: 次の処理に持ち越す
        if (def && def.material) {
          const amount = r.count * CONFIG.ranchHarvestPerHead;
          const tax = Math.floor(def.material.sellPrice * amount * taxRate);
          if (amount > 0) { out.income += tax; out.ranchTax += tax; }
        }
        out.ranchHarvests++;
        r.lastHarvestAt = Math.min(toR, Math.round(toR - (toG - h)));
        next = ranchNextMorningAfter(h);
        r.nextHarvestAt = next;
      }
    }

    out.net = out.income - out.expense;
    out.farmlands = farmlands2; out.ranches = ranches2;
    out.processed = true;
    return out;
  }

  /* ---------- 複数の島をまとめて処理して、一度だけ反映する ---------- */
  // floors: 処理する階の配列。toG/toR: 集計時刻
  function settle(floors, toG, toR) {
    const results = [], markers = {};
    // 共有プール(計算中の所持金・種のコピー)。成功してから実際の値へ反映する
    const pool = { gold: Math.max(0, playerGold), seeds: {} };
    if (typeof CROPS !== 'undefined') CROPS.forEach(c => { pool.seeds[c.id] = (inventory.seed && inventory.seed[c.id]) || 0; });
    const startGold = pool.gold, startSeeds = clone(pool.seeds);
    let fromGmin = Infinity;
    for (const f of floors) {
      const m = state[f];
      if (!m || !isNum(m.g) || !isNum(m.r)) { markers[f] = { g: toG, r: toR }; continue; } // 記録なし(旧セーブ等): 今を基準にして遡って処理しない
      if (m.g > toG) { markers[f] = { g: toG, r: toR }; continue; }                        // 時計が戻った: 処理せず基準だけ合わせる
      const res = computeIsland(f, m.g, m.r, toG, toR, pool);
      markers[f] = { g: toG, r: toR };
      if (res.processed) { results.push(res); fromGmin = Math.min(fromGmin, m.g); }
    }
    const totalIncome = results.reduce((s, x) => s + x.income, 0);
    const totalExpense = results.reduce((s, x) => s + x.expense, 0);
    const totalNet = totalIncome - totalExpense;
    // ---- ここまで何も書き換えていない。以下で一緒に反映する ----
    const backup = { gold: playerGold, seeds: {}, recs: {}, state: clone(state) };
    try {
      results.forEach(x => {
        const st = floorWorldStates[x.floor];
        backup.recs[x.floor] = { farmlands: st.farmlands, ranches: st.ranches };
        st.farmlands = x.farmlands; st.ranches = x.ranches;
      });
      playerGold += totalNet;
      Object.keys(startSeeds).forEach(id => {
        const used = results.reduce((s, x) => s + (x.seedsUsed[id] || 0), 0);
        if (used > 0) { backup.seeds[id] = inventory.seed[id]; inventory.seed[id] = Math.max(0, (inventory.seed[id] || 0) - used); }
      });
      Object.keys(markers).forEach(f => { state[f] = markers[f]; });
    } catch (e) {
      // 途中で失敗したら全部元に戻す(収支だけ・状態だけが反映された不整合を残さない)
      playerGold = backup.gold;
      Object.keys(backup.recs).forEach(f => { floorWorldStates[f].farmlands = backup.recs[f].farmlands; floorWorldStates[f].ranches = backup.recs[f].ranches; });
      Object.keys(backup.seeds).forEach(id => { inventory.seed[id] = backup.seeds[id]; });
      state = backup.state;
      throw e;
    }
    if (totalIncome > 0 && typeof royalRecordIncome === 'function') {
      try { // 王家への仕送り(js/royal.js): 自動収入として記録のみ(精算は月替わりに既存処理が行う)
        const span = (typeof royalSpanMonths === 'function' && isFinite(fromGmin)) ? royalSpanMonths(fromGmin, toG) : 1;
        royalRecordIncome(totalIncome, { spanMonths: span });
      } catch (e) { console.error('留守の島の収入の仕送り記録でエラー(ゴールド・農地は反映済み):', e); }
    }
    if (totalNet !== 0 && typeof updateRewardHud === 'function') updateRewardHud();
    return { results, totalIncome, totalExpense, totalNet };
  }

  /* ---------- 表示用の文章 ---------- */
  const sg = n => (n > 0 ? '+' : n < 0 ? '−' : '±') + Math.abs(n) + 'G';
  const gIn = n => '+' + n + 'G';
  const gOut = n => (n > 0 ? '−' : '') + n + 'G';
  function formatLines(rep) {
    const lines = [];
    rep.results.forEach(x => {
      if (x.income === 0 && x.expense === 0) { lines.push(`🏝 ${floorLabel(x.floor)}: 大きな収支変動はありません`); return; }
      lines.push(`🏝 ${floorLabel(x.floor)}`);
      lines.push(`　収入${gIn(x.income)} 支出${gOut(x.expense)} 差引${sg(x.net)}`);
    });
    if (rep.results.length >= 2) lines.push(`🏝 合計: 収入${gIn(rep.totalIncome)} 支出${gOut(rep.totalExpense)} 差引${sg(rep.totalNet)}`);
    return lines;
  }

  /* ---------- 入口 ---------- */
  // 勇者がいない島のうち、領民がいる島の階番号
  function candidateFloors(skipCurrent) {
    const set = new Set();
    villagers.forEach(v => { if (v && Number.isInteger(v.floor)) set.add(v.floor); });
    Object.keys(state).forEach(k => set.add(Number(k)));
    return Array.from(set).filter(f => !(skipCurrent && f === currentFloor)).sort((a, b) => a - b);
  }
  // 朝6:00に目覚めた直後。戻り値: { text, lines, ... }(報告対象が無ければ text は空)
  function onMorning() {
    const rep = settle(candidateFloors(true), nowG(), Date.now());
    const lines = formatLines(rep);
    lastReport = rep;
    return { text: lines.length ? ['【留守の島の報告】'].concat(lines).join('\n') : '', lines, report: rep };
  }
  function onLeave(floor) {
    if (!Number.isInteger(floor)) return;
    state[floor] = { g: nowG(), r: Date.now() };
  }
  // startFloor() が移動先の農地を復元する直前に呼ぶ。未処理分をこの島の分だけ処理して取り込む。
  function onArrive(floor) {
    if (!Number.isInteger(floor)) return null;
    const m = state[floor];
    if (!m) return null; // 一度も離れていない島(初回など)は何もしない
    const rep = settle([floor], nowG(), Date.now());
    lastReport = rep;
    const x = rep.results[0];
    if (!x || (x.income === 0 && x.expense === 0)) return null;
    return `🏝 留守中の収支: 収入${gIn(x.income)} 支出${gOut(x.expense)} 差引${sg(x.net)}`;
  }

  /* ---------- セーブ/ロード(worldState.islandOffscreen。旧セーブには無いキー) ---------- */
  function getSaveData() {
    const floors = {};
    Object.keys(state).forEach(f => { const m = state[f]; if (m && isNum(m.g) && isNum(m.r)) floors[f] = { g: m.g, r: m.r }; });
    return { v: CFG.version, floors };
  }
  function restoreFromSave(rec) {
    state = {};
    if (!rec || typeof rec !== 'object' || !rec.floors || typeof rec.floors !== 'object') return; // 旧セーブ: 空で開始(初回の処理で今を基準にする)
    Object.keys(rec.floors).forEach(k => {
      const f = Number(k), m = rec.floors[k];
      if (Number.isInteger(f) && m && isNum(m.g) && isNum(m.r)) state[f] = { g: m.g, r: m.r };
    });
  }
  function reset() { state = {}; lastReport = null; }

  return {
    CFG, onMorning, onLeave, onArrive, getSaveData, restoreFromSave, reset,
    _settle: settle, _computeIsland: computeIsland, _state: () => state, _last: () => lastReport,
  };
})();
