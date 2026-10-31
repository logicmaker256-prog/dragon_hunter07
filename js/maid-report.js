/* ---------------------------------------------------------------------
   メイドからの報告(js/maid-report.js)

   セーブデータをロードして始めるとき、「前回セーブしてからのゴールドの変化」を
   メイドが報告するページを表示する。

   ■ 報告する内容
     1. ゴールド全体の変化(例: 1,200G → 1,850G(+650G))
     2. その内訳(素材販売 / 農作物販売 / 種の購入 / 領民の維持費 / 王家への仕送り など。
        動きのあった項目だけ表示)
     3. 姫を励ますメッセージ(10回続けて同じメッセージが出ないようにしてある)

   ■ 「前回セーブしてからの変化」の意味
     ゲームを閉じている間は何も動かないので、セーブ後〜ロードまでの変化は、ロード時の
     「留守中の処理」で起きたものだけになる。具体的には:
       ・メイドのオフライン処理(畑の収穫→農協で販売、牧場の素材→販売、種の買い直し)
       ・姫歴の月が変わっていた場合の、領民の維持費と王家への仕送り
     これらを game.html の applySaveData() の中で「記録中」にして集計する。
     (プレイ中の売買など、ロード後のゴールドの動きは記録しない。)

   ■ 記録のしかた
     ゴールドを増減させる箇所が MaidReport.record(項目, 金額) を呼ぶ(増加は+、減少は-)。
     記録中(MaidReport.active === true)でなければ何もしない。呼び出し側は
     typeof MaidReport !== 'undefined' を確認してから呼ぶので、このファイルが無くても
     従来どおり動く。
     全体の変化は「ロード直後のゴールド」と「記録終了時のゴールド」の差から求め、
     内訳の合計とずれた分があれば「その他」として表示する(表示と実際の所持金を必ず一致させる)。

   ■ 励ましメッセージが重複しないしくみ
     メッセージは MESSAGES に40個以上用意し、「直近に出した20個」を履歴として覚えておき、
     その中からは選ばない(=少なくとも20回は同じメッセージが出ない)。
     履歴は localStorage と、セーブデータ(worldState.maidReportRecent)の両方に残す
     (どちらかが使えない/消えても、もう片方から復元する)。
     MESSAGES を増やす場合は、HISTORY_SIZE より多い数を保つこと。

   game.html 本編の playerGold / playerInvincibleTimer / showToast に依存する。
   js/royal.js より後、game.html の最後の <script> より前に読み込むこと。
--------------------------------------------------------------------- */

const MaidReport = (() => {
  const HISTORY_SIZE = 20;                    // 直近これだけの数のメッセージは再び選ばない
  const STORAGE_KEY = 'dragonHunterMaidReportRecent';

  // 内訳の項目(表示順)。入ってくるお金(+)と出ていくお金(-)を同じ仕組みで扱う。
  const CATEGORIES = [
    { id: 'material', icon: '🧺', label: '素材販売' },
    { id: 'crop',     icon: '🌾', label: '農作物販売' },
    { id: 'tax',      icon: '🏠', label: '領民からの税収' },
    { id: 'seed',     icon: '🌱', label: '種の購入' },
    { id: 'upkeep',   icon: '👥', label: '領民の維持費' },
    { id: 'royal',    icon: '👑', label: '王家への仕送り' },
    { id: 'other',    icon: '💰', label: 'その他' },
  ];

  // 励ましメッセージ(メイド=姫の姉のような存在、の口調)。40個以上。
  const MESSAGES = [
    '姫様なら、きっと大丈夫です。わたくしは、いつでも姫様の味方ですから。',
    '今日も姫様は、世界でいちばん頑張っていらっしゃいます。',
    '無理はなさらないでくださいね。疲れたら、いつでもわたくしを頼ってください。',
    '姫様の笑顔が見られるだけで、わたくしは十分に幸せです。',
    'ドラゴンも、きっと姫様の前では小さく見えますわ。',
    '一歩ずつで大丈夫です。姫様は、ちゃんと前に進んでいらっしゃいます。',
    '失敗しても気にしないでください。わたくしが何度でも支えますから。',
    '姫様のお帰りを、ずっとお待ちしておりました。',
    '領地が賑やかになってきましたね。みんな、姫様のおかげです。',
    '姫様の剣は、きっと誰かを守る力になります。自信をお持ちください。',
    '温かいお茶を用意しておきますから、少し休んでからにしましょう。',
    '姫様が元気でいてくださること。それが、わたくしの一番の願いです。',
    '大丈夫。姫様が思っているより、ずっとずっと強いのですよ。',
    '畑の作物も、姫様を見習ってすくすく育っておりますわ。',
    'メイド長の座を捨ててついてきて、本当によかったと思っております。',
    '姫様は、わたくしの自慢です。どこへでも胸を張って参りましょう。',
    '今日も一日、良い冒険になりますように。わたくしがお供いたします。',
    '焦らなくても大丈夫です。姫様のペースで参りましょう。',
    '怖いときは、わたくしの後ろ…ではなく、隣にいてくださいませ。ふふ。',
    '姫様が諦めないかぎり、道はちゃんと続いていきます。',
    'お腹がすいたら言ってくださいね。美味しいものを用意いたします。',
    '姫様の頑張りは、わたくしがちゃんと見ております。',
    '少しずつ強くなっていく姫様を見るのが、わたくしの楽しみなのです。',
    '今日の姫様も、とてもお美しゅうございます。',
    '姫様、深呼吸をひとつ。……はい、もう大丈夫ですわ。',
    '王家の皆様も、きっと姫様を誇りに思っていらっしゃいます。',
    '姫様の優しさは、領民のみんなにちゃんと届いておりますよ。',
    'うまくいかない日があっても、姫様の価値は少しも変わりません。',
    'さあ、胸を張って。姫様はこの領地の主なのですから。',
    '姫様が楽しそうだと、わたくしまで嬉しくなってしまいます。',
    '夜はゆっくりお休みくださいね。明日もきっと良い日になります。',
    'どんな強敵でも、姫様なら乗り越えられると信じております。',
    '無事に帰ってきてくださるだけで、わたくしは安心なのです。',
    '今日は何から始めましょうか。姫様のお決めになることなら、何でもお手伝いします。',
    '小さな一歩の積み重ねが、いつか大きな冒険になりますわ。',
    '姫様、頑張りすぎていませんか? たまには甘えてくださってよいのですよ。',
    'わたくしの自慢の妹…いえ、自慢の姫様です。',
    '姫様の夢は、きっと叶います。わたくしが保証いたしますわ。',
    '春の風のように、のんびり参りましょう。姫様らしく。',
    '姫様が前を向いているかぎり、わたくしは何があっても付き従います。',
    '今日の冒険の分まで、たっぷり褒めて差し上げますからね。',
    '勇気を出した姫様は、いつだって格好いいのです。',
    '帰る場所はここにありますから、思いきり暴れてきてくださいませ。',
    '姫様が笑えば、領地中が明るくなりますわ。',
    '困ったことがあれば、いつでもお呼びください。すぐに駆けつけます。',
  ];

  let active = false;            // 記録中か
  let ledger = {};               // { 項目id: 金額(+/-) }
  let startGold = 0;             // 記録開始時のゴールド
  let pending = null;            // 表示待ちの報告 { before, after, delta, rows, savedAt }
  let recentIdx = [];            // 直近に出したメッセージの番号(新しいものが末尾)
  let guardTimer = null;

  /* ---------- 履歴(メッセージの重複防止) ---------- */
  function sanitizeHistory(arr) {
    const out = [];
    if (Array.isArray(arr)) {
      for (const v of arr) {
        if (Number.isInteger(v) && v >= 0 && v < MESSAGES.length && !out.includes(v)) out.push(v);
      }
    }
    return out.slice(-HISTORY_SIZE);
  }
  function readStoredHistory() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? sanitizeHistory(JSON.parse(raw)) : [];
    } catch (e) { return []; }
  }
  function writeStoredHistory() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(recentIdx)); } catch (e) { /* 使えなくてもセーブ側に残る */ }
  }
  // 2つの履歴(新しい順序を保ったまま)を合わせる。後ろの引数ほど新しい扱い。
  function mergeHistory(a, b) {
    const out = [];
    for (const v of [...a, ...b]) {
      const i = out.indexOf(v);
      if (i >= 0) out.splice(i, 1);
      out.push(v);
    }
    return out.slice(-HISTORY_SIZE);
  }
  function pickMessage() {
    const used = new Set(recentIdx);
    const candidates = [];
    for (let i = 0; i < MESSAGES.length; i++) if (!used.has(i)) candidates.push(i);
    const pool = candidates.length > 0 ? candidates
      : Array.from({ length: MESSAGES.length }, (_, i) => i).filter(i => i !== recentIdx[recentIdx.length - 1]); // 念のため(MESSAGESが少ない場合)
    const idx = pool[Math.floor(Math.random() * pool.length)];
    recentIdx.push(idx);
    recentIdx = recentIdx.slice(-HISTORY_SIZE);
    writeStoredHistory();
    return MESSAGES[idx];
  }
  recentIdx = readStoredHistory();

  /* ---------- 記録 ---------- */
  function start() {
    active = true;
    ledger = {};
    startGold = playerGold;
  }
  // category: CATEGORIESのid / amount: 増加は+、減少は-
  function record(category, amount) {
    if (!active) return;
    amount = Number(amount);
    if (!Number.isFinite(amount) || amount === 0) return;
    ledger[category] = (ledger[category] || 0) + amount;
  }
  // 記録を終えて、表示待ちの報告を作る。
  function finish(savedAt) {
    if (!active) return null;
    active = false;
    const before = Math.round(startGold);
    const after = Math.round(playerGold);
    const delta = after - before;
    const rows = [];
    let sum = 0;
    for (const c of CATEGORIES) {
      if (c.id === 'other') continue;
      const v = Math.round(ledger[c.id] || 0);
      if (v !== 0) { rows.push({ icon: c.icon, label: c.label, value: v }); sum += v; }
    }
    // 記録に漏れた増減(内訳が全体とずれた分)があれば「その他」で埋める
    const rest = delta - sum;
    if (rest !== 0) {
      const o = CATEGORIES.find(c => c.id === 'other');
      rows.push({ icon: o.icon, label: o.label, value: rest });
    }
    pending = { before, after, delta, rows, savedAt: (typeof savedAt === 'number') ? savedAt : null };
    return pending;
  }
  // ロードに失敗した等で、記録を途中で打ち切る
  function abort() { active = false; ledger = {}; pending = null; }

  /* ---------- 表示 ---------- */
  const fmt = n => Number(n).toLocaleString('ja-JP');
  const signed = n => (n > 0 ? '+' : n < 0 ? '−' : '±') + fmt(Math.abs(n)) + 'G';
  const tone = n => (n > 0 ? 'mrPlus' : n < 0 ? 'mrMinus' : 'mrZero');

  function esc(s) { return String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])); }

  let overlay = null, bodyEl = null;
  function ensureDom() {
    if (overlay) return;
    const style = document.createElement('style');
    style.textContent = `
      #maidReportOverlay {
        position: fixed; inset: 0; z-index: 70; display: none; align-items: center; justify-content: center;
        background: rgba(8,6,16,0.78);
      }
      #maidReportCard {
        width: min(340px, 90vw); max-height: 86vh; overflow-y: auto;
        background: #1d1830; border: 1px solid rgba(255,215,140,0.55); border-radius: 16px;
        padding: 16px 16px 14px; color: #f3ecff; box-shadow: 0 10px 30px rgba(0,0,0,0.65);
      }
      #maidReportCard h2 { margin: 0 0 4px; font-size: 17px; text-align: center; color: #ffe9a8; }
      #maidReportCard .mrSub { text-align: center; font-size: 11.5px; color: #cbb8e8; margin-bottom: 10px; }
      #maidReportCard .mrGreet { font-size: 13px; line-height: 1.7; margin: 0 0 10px; }
      #maidReportCard .mrTotal {
        background: rgba(255,255,255,0.07); border-radius: 12px; padding: 10px 12px; margin-bottom: 10px; text-align: center;
      }
      #maidReportCard .mrTotal .mrLabel { font-size: 11.5px; color: #cbb8e8; }
      #maidReportCard .mrTotal .mrBig { font-size: 26px; font-weight: bold; letter-spacing: 1px; margin: 2px 0; }
      #maidReportCard .mrTotal .mrFromTo { font-size: 12px; color: #d8d0ee; }
      #maidReportCard .mrPlus { color: #8ff0a4; }
      #maidReportCard .mrMinus { color: #ff9a9a; }
      #maidReportCard .mrZero { color: #d8d0ee; }
      #maidReportCard .mrHead { font-size: 12px; color: #cbb8e8; margin: 0 0 4px; }
      #maidReportCard .mrRow {
        display: flex; justify-content: space-between; align-items: center; gap: 8px;
        font-size: 13px; padding: 6px 2px; border-bottom: 1px solid rgba(255,255,255,0.1);
      }
      #maidReportCard .mrRow b { font-weight: bold; white-space: nowrap; }
      #maidReportCard .mrNone { font-size: 12.5px; color: #d8d0ee; padding: 6px 2px; }
      #maidReportCard .mrMsg {
        margin: 12px 0 4px; padding: 10px 12px; font-size: 13px; line-height: 1.75; color: #fff3d6;
        background: rgba(255,224,138,0.1); border-left: 3px solid #ffe08a; border-radius: 6px;
      }
      #maidReportOk {
        display: block; margin: 12px auto 0; background: #ffe08a; color: #3a2600; border: none;
        border-radius: 10px; padding: 9px 26px; font-size: 14px; font-weight: bold;
      }
    `;
    document.head.appendChild(style);
    overlay = document.createElement('div');
    overlay.id = 'maidReportOverlay';
    overlay.innerHTML = '<div id="maidReportCard"></div>';
    document.body.appendChild(overlay);
    bodyEl = overlay.firstChild;
  }

  function buildHtml(rep) {
    let ago = '';
    if (rep.savedAt) {
      const hours = Math.max(0, (Date.now() - rep.savedAt) / 3600000);
      if (hours >= 1) ago = `前回のセーブから約${hours >= 48 ? Math.floor(hours / 24) + '日' : Math.floor(hours) + '時間'}ぶり`;
      else if (hours >= 1 / 60) ago = `前回のセーブから約${Math.max(1, Math.floor(hours * 60))}分ぶり`;
    }
    const cls = tone(rep.delta);
    let html = '<h2>🧹 メイドからの報告</h2>';
    html += `<div class="mrSub">${esc(ago || '前回のセーブからの報告')}</div>`;
    html += '<p class="mrGreet">姫様、おかえりなさいませ。前回セーブされてから、お財布の中身は次のように変わりました。</p>';
    html += '<div class="mrTotal"><div class="mrLabel">ゴールドの変化(全体)</div>'
      + `<div class="mrBig ${cls}">${rep.delta === 0 ? '変化なし' : signed(rep.delta)}</div>`
      + `<div class="mrFromTo">${fmt(rep.before)}G → ${fmt(rep.after)}G</div></div>`;
    html += '<div class="mrHead">内訳</div>';
    if (rep.rows.length === 0) {
      html += '<div class="mrNone">お金の動きはありませんでした。</div>';
    } else {
      for (const r of rep.rows) {
        html += `<div class="mrRow"><span>${r.icon} ${esc(r.label)}</span><b class="${tone(r.value)}">${signed(r.value)}</b></div>`;
      }
    }
    html += `<div class="mrMsg">💬 ${esc(pickMessage())}</div>`;
    html += '<button id="maidReportOk">はい、ありがとう</button>';
    return html;
  }

  // 報告ページを表示する(表示待ちの報告が無ければ何もしない)。閉じるまでは勇者は攻撃を受けない。
  function show() {
    if (!pending) return false;
    const rep = pending;
    pending = null;
    try {
      ensureDom();
      bodyEl.innerHTML = buildHtml(rep);
      overlay.style.display = 'flex';
      const guard = () => { try { if (typeof playerInvincibleTimer !== 'undefined') playerInvincibleTimer = Math.max(playerInvincibleTimer, 1); } catch (e) { /* 無敵にできなくても表示は続ける */ } };
      guard();
      if (guardTimer) clearInterval(guardTimer);
      guardTimer = setInterval(guard, 300);
      document.getElementById('maidReportOk').addEventListener('click', () => {
        overlay.style.display = 'none';
        if (guardTimer) { clearInterval(guardTimer); guardTimer = null; }
        try { if (typeof playerInvincibleTimer !== 'undefined') playerInvincibleTimer = Math.max(playerInvincibleTimer, 1.5); } catch (e) { /* 何もしない */ }
      });
      return true;
    } catch (e) {
      console.error('メイドからの報告の表示でエラーが発生しました:', e); // 表示に失敗してもゲームは続ける
      return false;
    }
  }

  /* ---------- セーブ/ロード(履歴だけ。worldState.maidReportRecent) ---------- */
  function getSaveData() { return recentIdx.slice(); }
  function restoreFromSave(rec) {
    // セーブ側の履歴と、この端末に残っている履歴を合わせる(どちらかが消えていても重複を避けられる)
    recentIdx = mergeHistory(sanitizeHistory(rec), readStoredHistory().length ? readStoredHistory() : recentIdx);
    writeStoredHistory();
  }

  return { start, record, finish, abort, show, getSaveData, restoreFromSave, get active() { return active; } };
})();
