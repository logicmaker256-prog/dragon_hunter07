/* ---------------------------------------------------------------------
   睡眠・空腹度・食堂(js/survival.js)

   このファイルが追加する機能:

   【睡眠】
   ・夜(ゲーム内18:00〜翌6:00)に教会へ入ると、そのまま眠り、翌朝6:00に起きる。
   ・ゲーム内時刻が21:00を過ぎる(21:00〜翌6:00未満)と、メイドに強制的に教会へ連れて
     こられて寝かしつけられる。
   ・起床時はHP・MPが全回復する(CONFIG.survival.healOnWake。不要ならfalseにする)。
   ・眠っている間は空腹度は減らない。
   ・教会の中のセーブ/ロードは game.html 側(#churchSaveBar)。いつでも使える。
     (教会に近づくと出ていた「セーブ/ロード」プロンプトは廃止した)

   【空腹度】
   ・食事直後100%。ゲーム内1時間ごとに10%ずつ減る
     (ゲーム内1時間 = 実時間150秒。姫歴は実時間1時間=ゲーム内24時間のため)。
   ・食堂(新しい建物): 食事はゲーム内0.5時間かかる。営業時間(ゲーム内時刻)は
       モーニング 3G 6:00-9:00 / ランチ 3G 11:00-14:00 / ディナー 4G 17:00-20:00
   ・アイテム屋で携帯食(8G)を買える(js/shop.js)。食べるのはインベントリ(js/inventory.js)から。
     携帯食の食事は時間がかからない。
   ・空腹度が0になると、メイドに強制的に「メイド飯」を食べさせられる。何を食べたか思い出せない
     ほど不味く、HP・MPが半分になる(空腹度は100%に戻る)。

   【時間の進め方】
   ゲーム内時計は実時間(Date.now())から計算している(game.html「03. ゲーム内時間(姫歴)」)。
   睡眠・食堂での食事で実際に待たせる代わりに、GameTime.skewMs(進めた分の実時間ms)を足して
   「ゲーム内時計だけ」を先へ進める。gameNow() = Date.now() + skewMs。skewMsはセーブされる。
   作物・樹木・牧場・ボスのリポップなど、実時間基準で動いているものは、時計を進めても変わらない。

   game.html 本編(CONFIG / player / buildings / CHURCH_POS / GameTime / gameNow / computeGameClock /
   getGameTime / isGameNight / updateGameTime / updateGameClockHud / closeAllModals / modalBackdrop /
   showToast / updateBars / updateRewardHud / hp / mp / hpMax / mpMax / playerGold /
   playerInvincibleTimer / playerDeadLock / placementActive / heightAt / loadingScreen)と
   js/church.js(openChurchInterior)・js/inventory.js(Inventory)のグローバルをそのまま利用する。
   このファイルは js/church.js より後、game.html の最後の <script> より前に読み込むこと。

   【メイドとの連携】 メイドも勇者と同じ時間割で生活する(js/maid-ai.js「生活: 睡眠と食事」)。
   就寝・起床の時刻、空腹度の減り方、食堂のメニュー/営業時間/食事時間はこのファイルのCONFIG.survivalを共有する。
   勇者が眠る時は svRunSleep から maidOnHeroSleep() を呼び、メイドも一緒に眠らせる。
--------------------------------------------------------------------- */

CONFIG.survival = {
  hungerMax: 100,
  hungerDropPerGameHour: 10,   // ゲーム内1時間あたりに減る空腹度(%)
  gameHourRealSec: 150,        // ゲーム内1時間 = 実時間150秒(実1時間=ゲーム内24時間)
  rationPrice: 8,              // 携帯食の値段(G)
  dinerMealGameHours: 0.5,     // 食堂での食事にかかるゲーム内時間(時間)
  forceSleepHour: 21,          // この時刻(ゲーム内)を過ぎたらメイドに教会へ連れて行かれる
  wakeHour: 6,                 // 起床時刻(ゲーム内)
  healOnWake: true,            // 起床時にHP・MPを全回復するか
  maidMealRate: 0.5,           // メイド飯でHP・MPが残る割合(0.5=半減)
  maidMealHungerAfter: 100,    // メイド飯のあとの空腹度(%)
  warnAt: [30, 10],            // 空腹度がこの値以下になったら一度だけお知らせする
  dinerEnterRadius: 3.5,       // 食堂の入店プロンプトが出る距離(アイテム屋と同じ)
  dinerSafeRadius: 4.5,        // 食堂にはモンスターは入れない(アイテム屋・農協と同じ)
  sleepAnimMs: 3600,           // 就寝中の暗転演出(時計が進んで見える)の長さ(ms)
  meals: [
    { id: 'morning', name: 'モーニング', icon: '🥐', price: 3, from: 6,  to: 9  },
    { id: 'lunch',   name: 'ランチ',     icon: '🍛', price: 3, from: 11, to: 14 },
    { id: 'dinner',  name: 'ディナー',   icon: '🍖', price: 4, from: 17, to: 20 },
  ],
};
// ゲーム内1分 = 実時間2500ms(実1時間 = ゲーム内24時間 = 1440分)
const SV_REAL_MS_PER_GAME_MIN = 3600000 / 1440;

/* ---------------------------------------------------------------------
   状態
--------------------------------------------------------------------- */
let playerHunger = CONFIG.survival.hungerMax; // 空腹度(0〜100)
const svState = {
  busy: false,           // 睡眠/食事/メイド飯の演出中(この間は他の演出を始めない・空腹度は減らない・無敵)
  pendingMaidMeal: false,
  warned: {},            // { 30: true, 10: true }
  cooldownUntil: 0,      // 演出が失敗した場合に延々と再発動しないための休止(performance.now基準)
  hudLast: null,
};

const svOverlayEl = document.getElementById('svOverlay');
const svTitleEl = document.getElementById('svTitle');
const svClockEl = document.getElementById('svClock');
const svTextEl = document.getElementById('svText');
const hungerTextEl = document.getElementById('hungerText');
const dinerPromptEl = document.getElementById('dinerPrompt');
const dinerModalEl = document.getElementById('dinerModal');
const dinerBodyEl = document.getElementById('dinerBody');
const dinerGoldEl = document.getElementById('dinerGold');
const DINER_POS = (() => { const b = buildings.find(x => x.kind === 'diner'); return { x: b.x, z: b.z }; })();

/* ---------------------------------------------------------------------
   時刻ヘルパー(ゲーム内時計 = gameNow() 基準)
--------------------------------------------------------------------- */
function svClockMinutes() {
  const c = computeGameClock(gameNow());
  return c.hour * 60 + c.minute;
}
function svFmtMin(m) {
  m = ((Math.floor(m) % 1440) + 1440) % 1440;
  return pad2(Math.floor(m / 60)) + ':' + pad2(m % 60);
}
// 今から次の起床時刻(6:00)までに進める実時間(ms)。ちょうど6:00を少しだけ過ぎた時刻に着地させる。
function svMsUntilWake() {
  const now = gameNow();
  const msIntoHour = ((now % 3600000) + 3600000) % 3600000;
  const target = (CONFIG.survival.wakeHour * 60) / 1440 * 3600000;
  let d = target - msIntoHour;
  if (d <= 0) d += 3600000;
  return Math.ceil(d) + 600;
}
function svAdvanceClock(ms) {
  GameTime.skewMs = (GameTime.skewMs || 0) + ms;
  updateGameTime();      // 姫歴HUD・月替わりのお知らせ
  updateGameClockHud();  // 昼夜HUD
}
function svMealOpen(meal, minutes) {
  return minutes >= meal.from * 60 && minutes < meal.to * 60;
}

/* ---------------------------------------------------------------------
   空腹度
--------------------------------------------------------------------- */
function svRefreshHungerHud() {
  const v = Math.round(playerHunger);
  if (v === svState.hudLast) return;
  svState.hudLast = v;
  hungerTextEl.textContent = v + '%';
  hungerTextEl.style.color = v <= 20 ? '#FF6A5A' : (v <= 50 ? '#FFB347' : '#FFD08A');
}
function svSetHunger(v) {
  playerHunger = Math.max(0, Math.min(CONFIG.survival.hungerMax, v));
  if (playerHunger > 0) svState.pendingMaidMeal = false;
  CONFIG.survival.warnAt.forEach(t => { if (playerHunger > t) svState.warned[t] = false; });
  svRefreshHungerHud();
}
function svHungerPerSec() {
  return CONFIG.survival.hungerDropPerGameHour / CONFIG.survival.gameHourRealSec;
}
function svLoadingVisible() {
  return loadingScreen.style.display !== 'none';
}
function svUpdate(dt) {
  if (svState.busy) {
    // 演出中は勇者が攻撃されないようにする(教会の中に居ても敵が近づいている場合があるため)
    playerInvincibleTimer = Math.max(playerInvincibleTimer, 0.6);
    return;
  }
  if (!player || !GameTime.gameEpoch0 || svLoadingVisible() || playerDeadLock) return;
  if (playerHunger > 0) {
    playerHunger = Math.max(0, playerHunger - dt * svHungerPerSec());
    svRefreshHungerHud();
    CONFIG.survival.warnAt.forEach(t => {
      if (playerHunger <= t && !svState.warned[t]) {
        svState.warned[t] = true;
        showToast(t >= 20 ? `🍙 お腹が空いてきた…(空腹度${t}%以下)` : `⚠ 空腹度が${t}%以下!食事をとらないとメイドに飯を食べさせられる…`, 2800);
      }
    });
  }
  if (playerHunger <= 0) svState.pendingMaidMeal = true;
}

/* ---------------------------------------------------------------------
   演出オーバーレイ(暗転)
--------------------------------------------------------------------- */
function svSet(title, text, clock) {
  svTitleEl.textContent = title || '';
  svTextEl.textContent = text || '';
  svClockEl.textContent = clock || '';
}
function svShow(title, text, clock) {
  svSet(title, text, clock);
  svOverlayEl.style.display = 'flex';
  void svOverlayEl.offsetWidth; // display切替直後にopacityの遷移を効かせる
  svOverlayEl.style.opacity = '1';
}
function svHide() {
  svOverlayEl.style.opacity = '0';
  setTimeout(() => { if (svOverlayEl.style.opacity === '0') svOverlayEl.style.display = 'none'; }, 700);
}
const svWait = ms => new Promise(r => setTimeout(r, ms));
// 時計表示を startMin から deltaMin(ゲーム内分)だけ進めて見せる
function svAnimateClock(startMin, deltaMin, ms) {
  return new Promise(resolve => {
    const t0 = performance.now();
    const step = () => {
      const p = Math.min(1, (performance.now() - t0) / ms);
      svClockEl.textContent = svFmtMin(startMin + deltaMin * p);
      if (p >= 1) resolve(); else requestAnimationFrame(step);
    };
    step();
  });
}
function svChurchOpen() {
  return churchInteriorOverlay.style.display === 'block';
}
// 演出を始める前の共通準備: 建築の仮設置・開いている画面を片付け、勇者を守る
function svPrepare() {
  if (typeof Fishing !== 'undefined' && Fishing.isActive()) Fishing.stop('scene'); // 釣り中なら先に釣りモードだけを終える(勇者が動かされる前に)
  if (typeof placementActive !== 'undefined' && placementActive) {
    const cancel = document.getElementById('placeCancelBtn');
    if (cancel) cancel.click();
  }
  const wasInChurch = svChurchOpen();
  closeAllModals(); // 食堂・アイテム屋・インベントリ等を閉じる(教会内部も閉じるので、下で必要なら戻す)
  if (wasInChurch) churchInteriorOverlay.style.display = 'block';
  playerInvincibleTimer = Math.max(playerInvincibleTimer, 2);
  return wasInChurch;
}
function svCanInterrupt() {
  return !!player && !svState.busy && !playerDeadLock && !!GameTime.gameEpoch0
    && !svLoadingVisible() && performance.now() >= svState.cooldownUntil;
}
// 演出の共通ラッパー: 例外が出ても必ずbusyを解除し、暗転を消す
async function svRunScene(fn) {
  if (svState.busy) return;
  svState.busy = true;
  try {
    await fn();
  } catch (e) {
    console.error('睡眠・空腹度の演出でエラー:', e);
    svOverlayEl.style.opacity = '0';
    svOverlayEl.style.display = 'none';
  } finally {
    svState.busy = false;
    svState.cooldownUntil = performance.now() + 4000; // 万一の再発動ループ防止
    playerInvincibleTimer = Math.max(playerInvincibleTimer, 2);
  }
}

/* ---------------------------------------------------------------------
   睡眠
--------------------------------------------------------------------- */
function svTeleportToChurchDoor() {
  // セーブ/ロード後の復帰座標(教会のトビラの前)と同じ位置
  const x = CHURCH_POS.x, z = CHURCH_POS.z + 1.5;
  player.position.set(x, heightAt(x, z), z);
}
const SV_WAKE_LINES = [
  'メイド「おはようございます、姫様。よくお休みになれましたか?」',
  'メイド「朝でございますよ、姫様。今日も一日、がんばりましょうね」',
  'メイド「姫様、おはようございます。朝食は食堂で6時から9時までですよ」',
  'メイド「ぐっすりでしたね。寝顔が可愛くて、ずっと見ていました」',
];
function svRunSleep(reason) {
  return svRunScene(async () => {
    const wasInChurch = svPrepare();
    if (reason === 'forced') {
      svShow('🌙 もう夜更かしはいけません',
        `メイド「姫様、ゲーム内の${CONFIG.survival.forceSleepHour}時を過ぎました!\nさあ、教会へ参りますよ。お休みの時間です」`);
      await svWait(3400);
      if (!wasInChurch) {
        svTeleportToChurchDoor();
        openChurchInterior(); // busy中なので、教会に入った時の就寝フック(onChurchEnter)は何もしない
      }
    } else {
      svShow('', '');
    }
    // メイドも一緒に眠る(js/maid-ai.js)。下で時計が朝6:00へ進むと、メイドも同時に起きて仕事を再開する。
    if (typeof maidOnHeroSleep === 'function') maidOnHeroSleep();
    const startMin = svClockMinutes();
    const ms = svMsUntilWake();
    const deltaMin = ms / SV_REAL_MS_PER_GAME_MIN;
    svSet('💤 ぐっすり眠っています…', 'zzz…', svFmtMin(startMin));
    await svAnimateClock(startMin, deltaMin, CONFIG.survival.sleepAnimMs);

    svAdvanceClock(ms); // 翌朝6:00へ
    let healText = '';
    if (CONFIG.survival.healOnWake) {
      hp = hpMax; mp = mpMax;
      updateBars();
      healText = '\nHP・MPが全回復した';
    }
    const line = SV_WAKE_LINES[Math.floor(Math.random() * SV_WAKE_LINES.length)];
    // 留守の島の経過処理(js/island-offscreen.js): 朝6:00に、勇者がいない島の農地・牧場の収支を集計して
    // 所持金へ反映し、メイドの朝の挨拶の下に島ごとの結果を並べる。失敗しても挨拶と睡眠は続ける。
    let islandText = '';
    if (typeof IslandOffscreen !== 'undefined') {
      try { const rep = IslandOffscreen.onMorning(); if (rep && rep.text) islandText = '\n\n' + rep.text; }
      catch (e) { console.error('留守の島の朝の集計でエラー(睡眠は続行):', e); }
    }
    svSet('☀ おはようございます', `${getGameTime().text}${healText}\n${line}${islandText}`, svFmtMin(svClockMinutes()));
    await svWait(islandText ? 7500 : 3000);
    svHide();
    await svWait(700);
  });
}

/* ---------------------------------------------------------------------
   メイド飯(空腹度0)
--------------------------------------------------------------------- */
function svRunMaidMeal() {
  return svRunScene(async () => {
    svPrepare();
    svShow('🍲 メイド飯',
      'お腹が空いて、勇者は動けなくなってしまった…\nメイド「姫様、お倒れになる前にこれをお召し上がりください!」');
    await svWait(3400);
    svSet('🍲 メイド飯', '……もぐもぐ…\n何を食べたのか思い出せないほど、不味かった…');
    await svWait(3400);
    const rate = CONFIG.survival.maidMealRate;
    hp = Math.max(1, Math.floor(hp * rate));
    mp = Math.max(0, Math.floor(mp * rate));
    svSetHunger(CONFIG.survival.maidMealHungerAfter);
    updateBars();
    svSet('🍲 メイド飯', `空腹度は${Math.round(playerHunger)}%になったが…\nHPとMPが半分になってしまった!`);
    await svWait(3000);
    svHide();
    await svWait(700);
  });
}

/* ---------------------------------------------------------------------
   食堂
--------------------------------------------------------------------- */
function svRenderDiner() {
  const m = svClockMinutes();
  const full = Math.round(playerHunger) >= CONFIG.survival.hungerMax;
  dinerGoldEl.textContent = `所持ゴールド: ${playerGold} G ／ 空腹度: ${Math.round(playerHunger)}% ／ ゲーム内 ${svFmtMin(m)}`;
  let html = `<div class="shopSectionTitle">メニュー(食事はゲーム内${CONFIG.survival.dinerMealGameHours}時間かかります)</div>`;
  CONFIG.survival.meals.forEach(meal => {
    const open = svMealOpen(meal, m);
    const poor = playerGold < meal.price;
    const dis = (!open || poor || full) ? 'disabled' : '';
    html += `<div class="shopItemRow"><div class="itemInfo"><span>${meal.icon} ${meal.name}</span>
      <small>${meal.price}G ・ 営業 ${pad2(meal.from)}:00〜${pad2(meal.to)}:00(ゲーム内) ・ ${open ? '営業中' : '営業時間外'}</small></div>
      <button class="shopBuyBtn" data-diner-meal="${meal.id}" ${dis}>${open ? '食べる' : '時間外'}</button></div>`;
  });
  if (full) html += '<div class="statRow"><span>お腹いっぱいです(空腹度100%)</span></div>';
  dinerBodyEl.innerHTML = html;
  dinerBodyEl.querySelectorAll('[data-diner-meal]').forEach(btn => {
    btn.addEventListener('click', () => svDineAt(btn.dataset.dinerMeal));
  });
}
function svOpenDiner() {
  if (svState.busy) return;
  svRenderDiner();
  modalBackdrop.style.display = 'block';
  dinerModalEl.style.display = 'flex';
}
function svDineAt(mealId) {
  const meal = CONFIG.survival.meals.find(x => x.id === mealId);
  if (!meal || svState.busy) return;
  const m = svClockMinutes();
  if (!svMealOpen(meal, m)) { showToast('いまは営業時間外です', 1800); svRenderDiner(); return; }
  if (playerGold < meal.price) { showToast('ゴールドが足りません', 1800); svRenderDiner(); return; }
  if (Math.round(playerHunger) >= CONFIG.survival.hungerMax) { showToast('お腹いっぱいです', 1800); svRenderDiner(); return; }
  playerGold -= meal.price;
  updateRewardHud();
  svRunScene(async () => {
    svPrepare();
    const startMin = svClockMinutes();
    const deltaMin = CONFIG.survival.dinerMealGameHours * 60;
    svShow(`${meal.icon} ${meal.name}`, `もぐもぐ…\n(食事でゲーム内${CONFIG.survival.dinerMealGameHours}時間が過ぎる)`, svFmtMin(startMin));
    await svAnimateClock(startMin, deltaMin, 2400);
    svAdvanceClock(deltaMin * SV_REAL_MS_PER_GAME_MIN);
    svSetHunger(CONFIG.survival.hungerMax);
    svSet('🍽 ごちそうさま!', `空腹度が100%になった\n${getGameTime().text}`, svFmtMin(svClockMinutes()));
    await svWait(1500);
    svHide();
    await svWait(700);
  });
}
function svUpdateDinerProximity() {
  if (!player) { dinerPromptEl.style.display = 'none'; return; }
  const d = Math.hypot(player.position.x - DINER_POS.x, player.position.z - DINER_POS.z);
  dinerPromptEl.style.display = (d < CONFIG.survival.dinerEnterRadius && !svState.busy) ? 'flex' : 'none';
}
document.getElementById('dinerEnterBtn').addEventListener('click', svOpenDiner);
document.getElementById('dinerCloseBtn').addEventListener('click', closeAllModals);

/* ---------------------------------------------------------------------
   携帯食(インベントリから食べる。時間はかからない)
--------------------------------------------------------------------- */
function svEatRation() {
  if (svState.busy) return { ok: false, msg: '今は食べられません' };
  if (Inventory.total('ration') <= 0) return { ok: false, msg: '携帯食がありません' };
  if (Math.round(playerHunger) >= CONFIG.survival.hungerMax) return { ok: false, msg: 'まだお腹は空いていません(空腹度100%)' };
  Inventory.remove('ration', 1);
  svSetHunger(CONFIG.survival.hungerMax);
  return { ok: true, msg: '🍙 携帯食を食べた(空腹度100%)' };
}

/* ---------------------------------------------------------------------
   メインループ・他ファイルからの窓口
--------------------------------------------------------------------- */
function svLowFreq() {
  svUpdateDinerProximity();
  if (!svCanInterrupt()) return;
  const h = computeGameClock(gameNow()).hour;
  // 21:00を過ぎた(21:00〜翌6:00未満)ら、メイドに強制的に寝かしつけられる
  if (h >= CONFIG.survival.forceSleepHour || h < CONFIG.survival.wakeHour) { svRunSleep('forced'); return; }
  if (playerHunger <= 0 || svState.pendingMaidMeal) svRunMaidMeal();
}
// 夜に教会へ入ったら、そのまま眠る(js/church.jsのopenChurchInteriorから呼ばれる)
function svOnChurchEnter() {
  if (!svCanInterrupt()) return;
  if (isGameNight()) svRunSleep('enter');
}
function svApplySave(data) {
  const v = (data && typeof data.hunger === 'number' && Number.isFinite(data.hunger)) ? data.hunger : CONFIG.survival.hungerMax;
  svState.warned = {};
  svState.pendingMaidMeal = false;
  svSetHunger(v);
  svState.cooldownUntil = performance.now() + 1500; // ロード直後に演出が割り込まないよう少し待つ
}
const Survival = {
  update: svUpdate,
  lowFreq: svLowFreq,
  onChurchEnter: svOnChurchEnter,
  eatRation: svEatRation,
  applySave: svApplySave,
  getSaveValue: () => Math.round(playerHunger * 100) / 100,
  getHunger: () => playerHunger,
  isBusy: () => svState.busy,
};
svRefreshHungerHud();
