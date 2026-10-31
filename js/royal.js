/* ---------------------------------------------------------------------
   王家への仕送り(js/royal.js)

   「放置しているうちにゴールドが貯まりすぎる」問題への対応として、勇者が
   「実家の王家」へ収入の一部を仕送りする仕組みを追加する。

   ■ 徴収のタイミング(領民の維持費と同じ「姫歴の月替わりに1回」)
     ・収入が入った時点では何も引かない(ゴールドは今までどおり全額入る)。
       その月の「自動収入」の合計だけを記録しておく。
     ・姫歴の月が変わった時に、前の月の収入に段階税率をかけた額を、
       1回だけまとめて勇者のゴールドから王家へ送る。
     ・処理する前に先に「最後に処理した月」を更新するので、同じ月を二重に
       徴収しない(js/villager.jsの維持費と同じ考え方)。
     ・ゴールドが足りない時は、払えるだけ払って、残りは次の月替わりに
       繰り越す(ゴールドを使い切って徴収を逃れることはできない)。
     ・ゲームを閉じていて複数ヶ月が過ぎていた場合は、閉じていた間の収益を
       月数で等分して月ごとに計算し、ゲームを開いた時にまとめて精算する。

   ■ 仕送りの対象(自動で入ってくる収入だけ)
     ・お助けメイドが農協で売った分(js/maid-ai.js)
     ・メイドのオフライン処理(ゲームを閉じている間の畑・牧場の収益)
     ・領民の売上から勇者へ入る税収(js/villager.js)
     ※勇者が自分で農協・ショップで売った分、モンスター討伐の報酬は対象外。

   ■ 仕送り額(累進)
     ・その月の自動収入の合計に段階税率をかける(所得税のように、超えた分に
       だけ高い率がかかる)。CONFIG.royal.brackets で変更できる。

   ■ 見返り
     ・累計仕送り額が一定額に達すると、王家から称号・回復薬・レア武器・
       伝説級アイテムが届く(CONFIG.royal.rewards)。
     ・レア武器/伝説級アイテムは既存のrareWeapons/legendaryItems(牧場メニューの
       「レアコレクション」)へ入る。

   ■ 画面
     ・教会の紫水晶パネルに「👑 王家への仕送り」ボタンを追加(状況の確認用)。

   ■ セーブ
     ・worldState.royalRemittance として保存。旧セーブには無いキーなので、
       無ければ初期値(累計0)で始まる。

   読み込み順: js/church.js(churchFloorPanel)・js/villager.js より後。
   game.html側は、各フックを typeof で存在確認してから呼ぶ(このファイルが
   無くても従来どおり動く)。
--------------------------------------------------------------------- */

CONFIG.royal = {
  // 月ごとの自動収入に対する段階税率(upToまでの部分にrateがかかる)
  brackets: [
    { upTo: 500,      rate: 0.10 },
    { upTo: 2000,     rate: 0.25 },
    { upTo: 5000,     rate: 0.40 },
    { upTo: Infinity, rate: 0.55 },
  ],
  // 累計仕送り額(need)に達すると届く見返り。needの小さい順に並べること。
  rewards: [
    { id: 'r1', need: 500,   title: '王家の使い',   text: 'HP/MP全回復薬 各3個',
      hp: 3, mp: 3 },
    { id: 'r2', need: 1500,  title: '',             text: '王家の細剣(攻撃力+90)',
      weapon: { name: '王家の細剣', atk: 90 } },
    { id: 'r3', need: 4000,  title: '王家の騎士',   text: '王家の騎士剣(攻撃力+150)・回復薬 各10個',
      weapon: { name: '王家の騎士剣', atk: 150 }, hp: 10, mp: 10 },
    { id: 'r4', need: 10000, title: '王家の守護者', text: '王家の聖剣(攻撃力+230)',
      weapon: { name: '王家の聖剣', atk: 230 } },
    { id: 'r5', need: 25000, title: '王国の英雄',   text: '伝説級アイテム「王家の宝冠」',
      legendary: { name: '王家の宝冠', icon: '👑' } },
  ],
};

const RoyalState = {
  total: 0,          // 累計仕送り額(G。実際に支払えた分だけ)
  monthIndex: null,  // 「今月」の通し月番号(姫歴)。最後に精算した月でもある
  monthIncome: 0,    // 今月入った自動収入の合計(G)
  owed: 0,           // 精算済みの月の未払い分(G。ゴールド不足で払えなかった分・ゲームを閉じていた間の月の分)
  lastRemit: 0,      // 直近の精算で実際に送った額(G)
  claimed: {},       // { rewardId: true } 受け取り済みの見返り
  title: '',         // 現在の称号
};

/* ---------- 月番号(js/villager.jsの維持費と同じ基準) ---------- */
function royalMonthIndexAt(epochMs) {
  if (typeof GameTime === 'undefined' || !GameTime.gameEpoch0 || typeof computeHimeReki !== 'function') return null;
  const cal = computeHimeReki(GameTime.gameEpoch0, epochMs);
  return (cal.year - 1) * 12 + (cal.month - 1);
}
// fromEpoch〜toEpochにまたがる姫歴の月数(同じ月なら1)
function royalSpanMonths(fromEpoch, toEpoch) {
  const a = royalMonthIndexAt(fromEpoch), b = royalMonthIndexAt(toEpoch);
  if (a === null || b === null) return 1;
  return Math.max(1, b - a + 1);
}

/* ---------- 段階税率 ---------- */
function royalBracketTax(income) {
  if (!(income > 0)) return 0;
  let tax = 0, lower = 0;
  for (const b of CONFIG.royal.brackets) {
    if (income <= lower) break;
    const part = Math.min(income, b.upTo) - lower;
    tax += part * b.rate;
    lower = b.upTo;
  }
  return tax;
}
// 今月の収入額がいま入っている区分の税率
function royalCurrentRate() {
  const inc = RoyalState.monthIncome;
  for (const b of CONFIG.royal.brackets) {
    if (inc < b.upTo) return b.rate;
  }
  return CONFIG.royal.brackets[CONFIG.royal.brackets.length - 1].rate;
}

/* ---------- 精算(月替わりに1回) ---------- */
// 未払い分(owed)を、払えるだけ勇者のゴールドから王家へ送る。
function royalCollect() {
  const due = Math.floor(RoyalState.owed);
  if (due <= 0) { if (RoyalState.owed < 1) RoyalState.owed = 0; return; }
  const pay = Math.min(due, Math.max(0, Math.floor(playerGold)));
  playerGold -= pay;
  if (typeof MaidReport !== 'undefined') MaidReport.record('royal', -pay); // メイドからの報告(js/maid-report.js): 内訳の記録のみ
  RoyalState.owed -= pay;
  if (RoyalState.owed < 1) RoyalState.owed = 0;
  RoyalState.total += pay;
  RoyalState.lastRemit = pay;
  if (typeof updateRewardHud === 'function') updateRewardHud();
  if (typeof showToast === 'function') {
    if (pay > 0) {
      showToast(`👑 月替わり: 王家へ ${pay}G を仕送りした(累計 ${RoyalState.total}G)`
        + (RoyalState.owed > 0 ? `(${Math.floor(RoyalState.owed)}G は払えず次回へ繰り越し)` : ''), 3000);
    } else {
      showToast(`👑 王家への仕送り ${Math.floor(RoyalState.owed)}G が払えず、次回へ繰り越し`, 3000);
    }
  }
}
// 月が変わっていたら、前の月の収入に段階税率をかけて精算する。
function royalSettleIfMonthChanged() {
  const cur = royalMonthIndexAt((typeof gameNow === 'function') ? gameNow() : Date.now()); // 睡眠・食事で進めた時間も反映(HUDの月と一致させる)
  if (cur === null) return;
  if (!Number.isFinite(RoyalState.monthIndex)) { RoyalState.monthIndex = cur; return; } // 記録なし(旧セーブ/新規): 基準月だけ記録
  if (cur === RoyalState.monthIndex) return;
  if (cur < RoyalState.monthIndex) { RoyalState.monthIndex = cur; return; }              // 時計が戻った場合は精算しない
  const prevIncome = RoyalState.monthIncome;
  RoyalState.monthIndex = cur;        // 先に記録する(この月を二重に処理しない)
  RoyalState.monthIncome = 0;
  RoyalState.owed += royalBracketTax(prevIncome);
  royalCollect();
}

/* 自動収入gross(G)を「今月の収入」に記録する(ゴールド自体は呼び出し側が全額加えること)。
   opts.spanMonths: ゲームを閉じていた間の収益をまとめて渡す時の月数(省略=1)。 */
function royalRecordIncome(gross, opts) {
  gross = Math.floor(gross);
  if (!(gross > 0)) return;
  royalSettleIfMonthChanged();
  const span = Math.max(1, Math.floor((opts && opts.spanMonths) || 1));
  let lastPart = gross;
  if (span > 1) {
    // 閉じていた間に過ぎた月: それぞれ独立した1か月として計算し、ゲームを開いた今、まとめて精算する
    const per = gross / span;
    RoyalState.owed += royalBracketTax(per) * (span - 1);
    lastPart = gross - per * (span - 1); // 最後の1か月分は「今月」の収入に加える
    royalCollect();
  }
  RoyalState.monthIncome += lastPart;
}

/* ---------- 見返りの受け取り(メインループの低頻度パートから呼ぶ) ---------- */
function royalGrantReward(rw) {
  const lines = [];
  if (rw.title) { RoyalState.title = rw.title; lines.push(`称号「${rw.title}」`); }
  if (rw.weapon && typeof rareWeapons !== 'undefined') {
    rareWeapons.push({ id: rareWeaponIdCounter++, name: rw.weapon.name, atk: rw.weapon.atk, floor: 0, source: '王家からの贈り物' });
    lines.push(`${rw.weapon.name}(攻撃力+${rw.weapon.atk})`);
  }
  if (rw.legendary && typeof legendaryItems !== 'undefined') {
    legendaryItems.push({ id: legendaryIdCounter++, name: rw.legendary.name, icon: rw.legendary.icon, floor: 0, source: '王家からの贈り物' });
    lines.push(`伝説級「${rw.legendary.name}」`);
  }
  let overflow = false;
  if (rw.hp && typeof invAdd === 'function') { if (invAdd('hpPotion', rw.hp) < rw.hp) overflow = true; lines.push(`HP全回復薬×${rw.hp}`); }
  if (rw.mp && typeof invAdd === 'function') { if (invAdd('mpPotion', rw.mp) < rw.mp) overflow = true; lines.push(`MP全回復薬×${rw.mp}`); }
  return { text: lines.join('・'), overflow };
}
function royalTick() {
  try {
    royalSettleIfMonthChanged();
    let granted = 0;
    for (const rw of CONFIG.royal.rewards) {
      if (RoyalState.total < rw.need || RoyalState.claimed[rw.id]) continue;
      RoyalState.claimed[rw.id] = true; // 先に記録する(二重に受け取らない)
      const res = royalGrantReward(rw);
      const msg = `👑 王家から見返りが届いた!${res.text}` + (res.overflow ? '(持ち物がいっぱいで一部は受け取れなかった)' : '');
      // 月替わりの仕送りのお知らせ(3秒)と重ならないよう、少し遅らせて表示する
      if (typeof showToast === 'function') setTimeout(() => showToast(msg, 3600), 3200 + granted * 3800);
      granted++;
    }
    if (granted > 0 && typeof updateRewardHud === 'function') updateRewardHud();
  } catch (e) {
    console.error('王家の仕送り・見返り処理でエラーが発生しました:', e);
  }
}

/* ---------- セーブ/ロード ---------- */
function royalGetSaveData() {
  return {
    total: RoyalState.total,
    monthIndex: Number.isFinite(RoyalState.monthIndex) ? RoyalState.monthIndex : null,
    monthIncome: RoyalState.monthIncome,
    owed: RoyalState.owed,
    lastRemit: RoyalState.lastRemit,
    claimed: { ...RoyalState.claimed },
    title: RoyalState.title,
  };
}
function royalRestoreFromSave(rec) {
  const num = v => (Number.isFinite(v) && v >= 0) ? v : 0;
  RoyalState.total = num(rec && rec.total);
  RoyalState.monthIndex = (rec && Number.isFinite(rec.monthIndex)) ? rec.monthIndex : null;
  RoyalState.monthIncome = num(rec && rec.monthIncome);
  RoyalState.owed = num(rec && rec.owed);
  RoyalState.lastRemit = num(rec && rec.lastRemit);
  RoyalState.claimed = (rec && rec.claimed && typeof rec.claimed === 'object') ? { ...rec.claimed } : {};
  RoyalState.title = (rec && typeof rec.title === 'string') ? rec.title : '';
}

/* ---------- 教会の紫水晶パネルに「王家への仕送り」画面を追加 ---------- */
(function setupRoyalPanel() {
  const floorPanel = document.getElementById('churchFloorPanel');
  const closeBtn = document.getElementById('churchFloorCloseBtn');
  const bonusPanel = document.getElementById('churchBonusPanel');
  if (!floorPanel || !closeBtn || !bonusPanel || !bonusPanel.parentNode) return;

  const style = document.createElement('style');
  style.textContent = `
    #churchRoyalPanel {
      position: absolute; left: 50%; bottom: 8%; transform: translateX(-50%);
      z-index: 43; display: none; flex-direction: column; align-items: stretch;
      width: min(320px, 86vw); max-height: 60vh; overflow-y: auto;
      background: rgba(15,10,25,0.92); border: 1px solid rgba(255,215,120,0.6);
      border-radius: 14px; padding: 14px 16px; color: #f0e6ff;
      box-shadow: 0 8px 24px rgba(0,0,0,0.6);
    }
    #churchRoyalPanel h2 { margin: 0 0 6px; font-size: 15px; text-align: center; }
    #churchRoyalBody { font-size: 12.5px; }
    #churchRoyalBody .statRow span, #churchRoyalBody .statRow b { color: #f0e6ff; }
    #churchRoyalBody .royalNote { font-size: 11.5px; color: #cbb8e8; margin: 4px 0 8px; line-height: 1.5; }
    #churchRoyalBody .royalDone span { color: #ffe9a8; }
    #churchRoyalBody .royalNext span { color: #8fe0ff; }
    #churchRoyalCloseBtn {
      margin-top: 4px; align-self: center; background: rgba(255,255,255,0.12);
      border: 1px solid rgba(255,255,255,0.3); color: #fff; border-radius: 10px;
      padding: 8px 20px; font-size: 13px;
    }
    .churchRoyalOpenBtn { margin-top: 4px; background: #ffe08a !important; color: #3a2600 !important; }
  `;
  document.head.appendChild(style);

  const panel = document.createElement('div');
  panel.id = 'churchRoyalPanel';
  panel.innerHTML = '<h2>👑 王家への仕送り</h2><div id="churchRoyalBody"></div><button id="churchRoyalCloseBtn">戻る</button>';
  bonusPanel.parentNode.appendChild(panel);

  const openBtn = document.createElement('button');
  openBtn.id = 'churchRoyalOpenBtn';
  openBtn.className = 'churchFloorBtn churchRoyalOpenBtn';
  openBtn.textContent = '👑 王家への仕送り';
  floorPanel.insertBefore(openBtn, closeBtn);

  function render() {
    royalSettleIfMonthChanged();
    const body = document.getElementById('churchRoyalBody');
    const cfg = CONFIG.royal;
    const dueNow = Math.floor(royalBracketTax(RoyalState.monthIncome));
    let html = '<div class="royalNote">実家の王家へ、メイド・領民が稼いだ収入の一部を仕送りします。姫歴の月が変わる時に、その月の自動収入に応じた額を1回だけ送ります(収入が多いほど割合も上がります)。累計に応じて王家から見返りが届きます。</div>';
    html += `<div class="statRow"><span>称号</span><span>${RoyalState.title || 'なし'}</span></div>`;
    html += `<div class="statRow"><span>累計仕送り</span><span>${RoyalState.total}G</span></div>`;
    html += `<div class="statRow"><span>前回の仕送り</span><span>${RoyalState.lastRemit}G</span></div>`;
    html += `<div class="statRow"><span>今月の自動収入</span><span>${Math.floor(RoyalState.monthIncome)}G</span></div>`;
    html += `<div class="statRow"><span>月替わりの仕送り予定</span><span>${dueNow}G(いまの区分 ${Math.round(royalCurrentRate() * 100)}%)</span></div>`;
    if (RoyalState.owed >= 1) {
      html += `<div class="statRow"><span>繰り越し(未払い)</span><span>${Math.floor(RoyalState.owed)}G</span></div>`;
    }
    let lower = 0;
    const rows = cfg.brackets.map(b => {
      const label = (b.upTo === Infinity) ? `${lower}G〜` : `${lower}〜${b.upTo}G`;
      lower = b.upTo;
      return `${label}: ${Math.round(b.rate * 100)}%`;
    });
    html += `<div class="royalNote">月ごとの税率(超えた分にだけ高い率): ${rows.join(' / ')}</div>`;
    html += '<div class="statRow"><b>見返り</b></div>';
    let nextShown = false;
    cfg.rewards.forEach(rw => {
      const desc = `${rw.need}G: ${rw.text}${rw.title ? ' / 称号「' + rw.title + '」' : ''}`;
      if (RoyalState.claimed[rw.id]) {
        html += `<div class="statRow royalDone"><span>✅ ${desc}</span></div>`;
      } else if (!nextShown) {
        nextShown = true;
        html += `<div class="statRow royalNext"><span>▶ ${rw.need}G(あと${Math.max(0, rw.need - RoyalState.total)}G): ${rw.text}${rw.title ? ' / 称号「' + rw.title + '」' : ''}</span></div>`;
      } else {
        html += `<div class="statRow"><span>🔒 ${desc}</span></div>`;
      }
    });
    body.innerHTML = html;
  }
  openBtn.addEventListener('click', () => {
    floorPanel.style.display = 'none';
    render();
    panel.style.display = 'flex';
  });
  document.getElementById('churchRoyalCloseBtn').addEventListener('click', () => {
    panel.style.display = 'none';
    floorPanel.style.display = 'flex'; // 「戻る」: 移動石のコマンド一覧に戻る
  });
  // 教会から出る時は、他のパネルと同じく閉じておく
  const exitBtn = document.getElementById('churchInteriorCloseBtn');
  if (exitBtn) exitBtn.addEventListener('click', () => { panel.style.display = 'none'; });
})();
