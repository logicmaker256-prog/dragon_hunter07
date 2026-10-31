/* ---------------------------------------------------------------------
   インベントリ管理(js/inventory.js)

   「インベントリ管理 安全実装プロンプト」への対応。勇者の持ち物のうち
     ・HP全回復薬 / MP全回復薬
     ・木材 / 苗木 / 種(作物ごと)
     ・購入した武器 / 防具(まだ装備していないもの)
   を、最大40枠のスロット(スタック管理)で持つようにする。

   【安全方針:既存コードを書き換えない「互換層」方式】
   既存コードは inventory.wood / inventory.sapling / inventory.hpPotion /
   inventory.mpPotion / inventory.seed[作物ID] を直接読み書きしている。
   これらを一括で書き換える代わりに、上記プロパティを「getter/setter」
   (または Proxy)に差し替え、中身をスロットの合計で返す・増減をスロットへ
   反映する、という形にした。そのため農地・建築・伐採・農協・領民・メイド
   などの既存コードは1行も変更しなくても、従来どおり動く。
     読む   : inventory.wood            → スロット内の木材合計
     増やす : inventory.wood += 5       → 共通の「追加処理」invAdd(満杯なら超過分は消える)
     減らす : inventory.wood -= 5       → 共通の「削除処理」invRemove
   上記以外の所持品(柵・作物・牧場素材など)は従来どおりの単純な数値のまま。

   【装備品の扱い】
   現在装備している武器/防具は、従来どおり js/status.js の
   equippedWeapon / equippedArmor が保持する(装備データ・能力値の作り直しはしない)。
   装備中のものはスロットに入っていないので、売却・消失・二重所有が構造的に起きない。
   別の装備に着替えたときは、外した装備がスロットへ戻る。

   【読み込み順】game.html 本編(inventory / CROPS を定義するscript)の直後、
   js/shop.js より前に読み込むこと。
--------------------------------------------------------------------- */

const INV_SLOT_COUNT = 40;
// スタック上限(アイテム種類ごと)。ここに無い種類は「上限なし」(従来どおり数量を制限しない)。
const INV_STACK_MAX = { seed: 1000, wood: 100, sapling: 100, weapon: 1, armor: 1, ration: 99, fish: 99 };
const INV_SIMPLE_KEYS = ['hpPotion', 'mpPotion', 'wood', 'sapling']; // inventory直下の数値として互換層にするもの

let invSlots = new Array(INV_SLOT_COUNT).fill(null); // 各要素: null か { key, n }

/* --- アイテム種類の定義(key から表示名・上限などを引く) ---
   key: 'hpPotion' / 'mpPotion' / 'wood' / 'sapling' / 'seed:<作物ID>' / 'weapon:<index>' / 'armor:<index>' */
function invItemInfo(key) {
  if (typeof key !== 'string') return null;
  if (key === 'hpPotion') return { key, kind: 'potion', icon: '🧪', name: 'HP全回復薬', max: Infinity };
  if (key === 'mpPotion') return { key, kind: 'potion', icon: '💧', name: 'MP全回復薬', max: Infinity };
  // 睡眠・空腹度仕様: 携帯食(アイテム屋で購入。インベントリから「食べる」と空腹度100%。時間はかからない)
  if (key === 'ration') return { key, kind: 'food', icon: '🍙', name: '携帯食', max: INV_STACK_MAX.ration };
  if (key === 'wood') return { key, kind: 'material', icon: '🪵', name: '木材', max: INV_STACK_MAX.wood };
  if (key === 'sapling') return { key, kind: 'material', icon: '🌱', name: '苗木', max: INV_STACK_MAX.sapling };
  const sep = key.indexOf(':');
  if (sep < 0) return null;
  const type = key.slice(0, sep), id = key.slice(sep + 1);
  if (type === 'seed') {
    const c = (typeof getCropDef === 'function') ? getCropDef(id) : null;
    if (!c) return null;
    return { key, kind: 'seed', icon: c.icon || '🌱', name: `${c.name}の種`, max: INV_STACK_MAX.seed };
  }
  // ルアーフィッシング: 魚はサイズ(整数cm・20〜100)ごとに別のキー 'fish:<サイズ>' で持つ(サイズ情報を失わない。同じサイズだけスタックする)
  if (type === 'fish') {
    const sz = Number(id);
    if (!/^\d+$/.test(id) || !Number.isInteger(sz) || sz < 20 || sz > 100) return null;
    return { key, kind: 'fish', icon: '🐟', name: `魚(${sz}cm)`, max: INV_STACK_MAX.fish, sizeCm: sz, bonusText: '農協で売れます' };
  }
  if (type === 'weapon' || type === 'armor') {
    const list = type === 'weapon' ? WEAPONS : ARMORS;
    const idx = Number(id);
    if (!Number.isInteger(idx) || !list[idx]) return null;
    const it = list[idx];
    return { key, kind: type, icon: type === 'weapon' ? '⚔️' : '🛡️', name: it.name,
      max: INV_STACK_MAX[type], index: idx, item: it,
      bonusText: type === 'weapon' ? `攻撃力+${it.atk}` : `防御力+${it.def}` };
  }
  return null;
}

/* --- スロット操作の共通処理 --- */
function invTotal(key) {
  let t = 0;
  for (const s of invSlots) if (s && s.key === key) t += s.n;
  return t;
}
function invUsedSlots() { return invSlots.reduce((c, s) => c + (s ? 1 : 0), 0); }

// key を n 個入れたとき、実際に収納できる個数(満杯なら n より小さい)
function invFreeCapacity(key) {
  const info = invItemInfo(key);
  if (!info) return 0;
  let cap = 0;
  for (const s of invSlots) {
    if (!s) cap += info.max;
    else if (s.key === key) cap += Math.max(0, info.max - s.n);
    if (cap === Infinity) return Infinity;
  }
  return cap;
}
function invCanAdd(key, n) { return invFreeCapacity(key) >= n; }

// 共通の「追加処理」。同じ種類の空きがあるスタックから埋め、足りなければ空きスロットへ新しいスタックとして入れる。
// 40枠すべて使用中で入らない分は消える(戻り値: 実際に収納できた個数)。
function invAdd(key, n) {
  const info = invItemInfo(key);
  n = Math.floor(n);
  if (!info || !(n > 0)) return 0;
  let left = n;
  for (const s of invSlots) {
    if (left <= 0) break;
    if (s && s.key === key && s.n < info.max) {
      const put = Math.min(left, info.max - s.n);
      s.n += put; left -= put;
    }
  }
  for (let i = 0; i < invSlots.length && left > 0; i++) {
    if (invSlots[i]) continue;
    const put = Math.min(left, info.max);
    invSlots[i] = { key, n: put }; left -= put;
  }
  return n - left;
}
// 共通の「削除処理」。後ろのスロットから減らし、0になったスタックは削除する(戻り値: 実際に減らせた個数)。
function invRemove(key, n) {
  n = Math.floor(n);
  if (!(n > 0)) return 0;
  let left = n;
  for (let i = invSlots.length - 1; i >= 0 && left > 0; i--) {
    const s = invSlots[i];
    if (!s || s.key !== key) continue;
    const take = Math.min(left, s.n);
    s.n -= take; left -= take;
    if (s.n <= 0) invSlots[i] = null;
  }
  return n - left;
}
// 互換層のsetter用: 合計が v になるよう増減する(増える分は満杯なら消える)
function invSetTotal(key, v) {
  v = Number(v);
  if (!Number.isFinite(v)) return;
  v = Math.max(0, Math.floor(v));
  const cur = invTotal(key);
  if (v > cur) invAdd(key, v - cur);
  else if (v < cur) invRemove(key, cur - v);
}

/* --- 互換層の取り付け(inventory.wood 等を、スロット合計と連動するプロパティに差し替える) --- */
const invSeedView = new Proxy({}, {
  get(_t, prop) {
    if (typeof prop !== 'string' || prop === 'toJSON') return undefined;
    return invTotal('seed:' + prop);
  },
  set(_t, prop, value) {
    if (typeof prop !== 'string') return true;
    if (!invItemInfo('seed:' + prop)) return true; // 未知の作物IDは無視(クラッシュさせない)
    invSetTotal('seed:' + prop, value);
    return true;
  },
  has(_t, prop) {
    return typeof prop === 'string' && !!invItemInfo('seed:' + prop);
  },
  ownKeys() { return (typeof CROPS !== 'undefined' ? CROPS : []).map(c => c.id); },
  getOwnPropertyDescriptor(_t, prop) {
    if (typeof prop !== 'string' || !invItemInfo('seed:' + prop)) return undefined;
    return { value: invTotal('seed:' + prop), writable: true, enumerable: true, configurable: true };
  },
});

(function invInstallCompat() {
  // 取り付け前の(単純な数値だった)所持数をスロットへ移す。既に取り付け済みなら何もしない。
  const desc = Object.getOwnPropertyDescriptor(inventory, 'wood');
  if (desc && desc.get) return;
  const initial = {};
  INV_SIMPLE_KEYS.forEach(k => { initial[k] = Number(inventory[k]) || 0; });
  const oldSeed = (inventory.seed && typeof inventory.seed === 'object') ? inventory.seed : {};

  INV_SIMPLE_KEYS.forEach(k => {
    Object.defineProperty(inventory, k, {
      configurable: true, enumerable: true,
      get() { return invTotal(k); },
      set(v) { invSetTotal(k, v); },
    });
  });
  Object.defineProperty(inventory, 'seed', {
    configurable: true, enumerable: true,
    get() { return invSeedView; },
    set(obj) { // inventory.seed = {...} の形での代入にも対応(各作物の所持数を設定する)
      if (!obj || typeof obj !== 'object') return;
      Object.keys(obj).forEach(id => { if (invItemInfo('seed:' + id)) invSetTotal('seed:' + id, obj[id]); });
    },
  });
  INV_SIMPLE_KEYS.forEach(k => { if (initial[k] > 0) invAdd(k, initial[k]); });
  Object.keys(oldSeed).forEach(id => { if (invItemInfo('seed:' + id) && oldSeed[id] > 0) invAdd('seed:' + id, oldSeed[id]); });
})();

/* --- 装備(インベントリのスロット → 勇者の装備) --- */
function invGearKey(kind, index) { return `${kind}:${index}`; }
function invEquippedIndex(kind) {
  if (kind === 'weapon') return equippedWeapon ? WEAPONS.indexOf(equippedWeapon) : -1;
  return equippedArmor ? ARMORS.indexOf(equippedArmor) : -1;
}
// スロット番号 slotIndex の武器/防具を装備する。外した装備はスロットへ戻す。
// 戻り値: { ok, msg }
function invEquipFromSlot(slotIndex) {
  const s = invSlots[slotIndex];
  if (!s) return { ok: false, msg: 'アイテムがありません' };
  const info = invItemInfo(s.key);
  if (!info || (info.kind !== 'weapon' && info.kind !== 'armor')) return { ok: false, msg: '装備できないアイテムです' };
  const kind = info.kind;
  const backup = invSlots.map(x => x ? { key: x.key, n: x.n } : null);
  const prevIdx = invEquippedIndex(kind);

  s.n -= 1;
  if (s.n <= 0) invSlots[slotIndex] = null;
  if (prevIdx >= 0) {
    // 外した装備をインベントリへ戻す。入らなければ(念のため)元に戻して中止する=装備が消えない。
    if (invAdd(invGearKey(kind, prevIdx), 1) < 1) {
      invSlots = backup;
      return { ok: false, msg: 'インベントリに空きがないため、装備を変更できません' };
    }
  }
  if (kind === 'weapon') {
    equippedWeapon = info.item;
    // 従来どおり、通常武器を装備したらレア武器の装備は解除する(playerATK()がレア武器を優先するため)
    if (typeof equippedRareWeaponId !== 'undefined') equippedRareWeaponId = null;
  } else {
    equippedArmor = info.item;
  }
  if (typeof updateRewardHud === 'function') updateRewardHud();
  if (typeof updateBars === 'function') updateBars();
  return { ok: true, msg: `${info.icon} ${info.name}を装備した` };
}

// 売却処理側の防止策: 「装備中」の武器/防具は売買の対象外。
// (装備中のものはそもそもスロットに存在しないが、将来の売却処理が使えるよう明示的な判定を用意する)
function invIsEquippedGear(kind, index) {
  if (kind === 'weapon') {
    const rw = (typeof equippedRareWeapon === 'function') ? equippedRareWeapon() : null;
    return !rw && invEquippedIndex('weapon') === index;
  }
  return invEquippedIndex('armor') === index;
}
/* --- 薬(インベントリから使う) --- 既存のHP/MP全回復処理(hp = hpMax など)をそのまま再利用 --- */
function invUsePotion(key) {
  if (key === 'hpPotion') {
    if (invTotal('hpPotion') <= 0) return { ok: false, msg: 'HP全回復薬がありません' };
    invRemove('hpPotion', 1);
    hp = hpMax; // HPだけを全回復
    updateBars(); updatePotionBar();
    spawnFloatingText(player.position, 'HP全回復', '#7CFC7C');
    return { ok: true, msg: '🧪 HPが全回復した' };
  }
  if (key === 'mpPotion') {
    if (invTotal('mpPotion') <= 0) return { ok: false, msg: 'MP全回復薬がありません' };
    invRemove('mpPotion', 1);
    mp = mpMax; // MPだけを全回復
    updateBars(); updatePotionBar();
    spawnFloatingText(player.position, 'MP全回復', '#7CC9FF');
    return { ok: true, msg: '💧 MPが全回復した' };
  }
  return { ok: false, msg: '使えないアイテムです' };
}

/* --- セーブ / ロード ---
   ・従来の inventory(数量)形式はそのまま出力する(旧バージョンでも読める・既存キーは削除しない)。
   ・新たに inventorySlots(スロット内容)を追加で保存する。
   ・ロード時は inventorySlots があればそれを優先、無ければ(旧セーブ)従来の数量をスロットへ変換する。 */
function invLegacySnapshot() {
  const out = {};
  Object.keys(inventory).forEach(k => { if (k !== 'seed') out[k] = inventory[k]; });
  const seeds = {};
  (typeof CROPS !== 'undefined' ? CROPS : []).forEach(c => { seeds[c.id] = invTotal('seed:' + c.id); });
  out.seed = seeds;
  return out;
}
function invGetSaveSlots() {
  return invSlots.map(s => s ? { key: s.key, n: s.n } : null);
}
// 保存データのスロットを検証しながら読み込む(壊れた/未知のデータは捨てるだけでクラッシュさせない)
function invParseSlots(raw) {
  if (!Array.isArray(raw)) return null;
  const slots = new Array(INV_SLOT_COUNT).fill(null);
  const overflow = [];
  raw.slice(0, INV_SLOT_COUNT).forEach((e, i) => {
    if (!e || typeof e !== 'object') return;
    const info = invItemInfo(e.key);
    const n = Math.floor(Number(e.n));
    if (!info || !(n > 0)) return;
    const put = Math.min(n, info.max);
    slots[i] = { key: e.key, n: put };
    if (n > put) overflow.push([e.key, n - put]);
  });
  return { slots, overflow };
}
function invApplySave(data) {
  const legacy = (data && data.inventory && typeof data.inventory === 'object') ? data.inventory : {};
  let parsed = null;
  try { parsed = invParseSlots(data && data.inventorySlots); } catch (e) { parsed = null; }

  // 従来どおり、スロット管理対象外のキー(柵・作物・牧場素材など)は保存値でそのまま上書きする
  Object.keys(legacy).forEach(k => {
    if (INV_SIMPLE_KEYS.indexOf(k) >= 0 || k === 'seed') return;
    inventory[k] = legacy[k];
  });

  if (parsed) {
    invSlots = parsed.slots;
    parsed.overflow.forEach(([key, n]) => invAdd(key, n));
    return;
  }
  // 旧セーブデータ: 数量(inventory.hpPotion/wood/seed 等)をスロットへ変換する。
  // セーブデータに無い項目は、従来の Object.assign と同じく「現在の値を保つ」。
  const keep = {};
  INV_SIMPLE_KEYS.forEach(k => { if (typeof legacy[k] !== 'number') keep[k] = invTotal(k); });
  const keepSeed = {};
  (typeof CROPS !== 'undefined' ? CROPS : []).forEach(c => {
    if (!(legacy.seed && typeof legacy.seed === 'object' && c.id in legacy.seed)) keepSeed[c.id] = invTotal('seed:' + c.id);
  });
  invSlots = new Array(INV_SLOT_COUNT).fill(null);
  INV_SIMPLE_KEYS.forEach(k => {
    const v = (typeof legacy[k] === 'number') ? legacy[k] : keep[k];
    if (v > 0) invAdd(k, v);
  });
  (typeof CROPS !== 'undefined' ? CROPS : []).forEach(c => {
    const v = (legacy.seed && typeof legacy.seed === 'object' && c.id in legacy.seed) ? Number(legacy.seed[c.id]) : keepSeed[c.id];
    if (v > 0) invAdd('seed:' + c.id, v);
  });
}

/* --- インベントリ画面(UI) --- */
const inventoryModal = document.getElementById('inventoryModal');
const inventoryBody = document.getElementById('inventoryBody');
const inventorySummaryEl = document.getElementById('inventorySummary');
const inventoryBtnEl = document.getElementById('inventoryBtn');

function invEscape(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function renderInventoryModal() {
  inventorySummaryEl.textContent = `使用中 ${invUsedSlots()} / ${INV_SLOT_COUNT} 枠`;
  let html = '<div class="shopSectionTitle">装備中</div>';
  const rw = (typeof equippedRareWeapon === 'function') ? equippedRareWeapon() : null;
  if (rw) {
    html += `<div class="shopItemRow"><div class="itemInfo"><span>⚔️ レア武器「${invEscape(rw.name)}」</span><small>攻撃力+${rw.atk}(🐾牧場メニューで管理)</small></div><span class="equippedTag">装備中</span></div>`;
  } else if (equippedWeapon) {
    html += `<div class="shopItemRow"><div class="itemInfo"><span>⚔️ ${invEscape(equippedWeapon.name)}</span><small>攻撃力+${equippedWeapon.atk}</small></div><span class="equippedTag">装備中</span></div>`;
  } else {
    html += '<div class="shopItemRow"><div class="itemInfo"><span>⚔️ 武器なし</span></div></div>';
  }
  if (equippedArmor) {
    html += `<div class="shopItemRow"><div class="itemInfo"><span>🛡️ ${invEscape(equippedArmor.name)}</span><small>防御力+${equippedArmor.def}</small></div><span class="equippedTag">装備中</span></div>`;
  } else {
    html += '<div class="shopItemRow"><div class="itemInfo"><span>🛡️ 防具なし</span></div></div>';
  }
  html += `<div class="shopSectionTitle">持ち物(${INV_SLOT_COUNT}枠)</div>`;
  invSlots.forEach((s, i) => {
    const no = String(i + 1).padStart(2, '0');
    if (!s) {
      html += `<div class="invEmptyRow"><span>${no}</span><span>— 空き —</span></div>`;
      return;
    }
    const info = invItemInfo(s.key);
    if (!info) return;
    const qty = (info.max === Infinity) ? `×${s.n}` : `×${s.n} / ${info.max}`;
    let action = '';
    if (info.kind === 'potion') action = `<button class="shopBuyBtn" data-inv-use="${i}">使う</button>`;
    else if (info.kind === 'food') action = `<button class="shopBuyBtn" data-inv-eat="${i}">食べる</button>`;
    else if (info.kind === 'weapon' || info.kind === 'armor') action = `<button class="shopBuyBtn" data-inv-equip="${i}">装備</button>`;
    const sub = info.bonusText ? `<small>${info.bonusText}</small>` : '';
    html += `<div class="shopItemRow"><div class="itemInfo"><span><span class="invNo">${no}</span> ${info.icon} ${invEscape(info.name)} <b>${qty}</b></span>${sub}</div>${action}</div>`;
  });
  inventoryBody.innerHTML = html;
  inventoryBody.querySelectorAll('[data-inv-use]').forEach(btn => {
    btn.addEventListener('click', () => {
      const s = invSlots[+btn.dataset.invUse];
      if (!s) return;
      const r = invUsePotion(s.key);
      if (typeof showToast === 'function') showToast(r.msg, 1600);
      renderInventoryModal();
    });
  });
  inventoryBody.querySelectorAll('[data-inv-eat]').forEach(btn => {
    btn.addEventListener('click', () => {
      const s = invSlots[+btn.dataset.invEat];
      if (!s) return;
      const r = (typeof Survival !== 'undefined') ? Survival.eatRation() : { ok: false, msg: '食べられません' };
      if (typeof showToast === 'function') showToast(r.msg, 1800);
      renderInventoryModal();
    });
  });
  inventoryBody.querySelectorAll('[data-inv-equip]').forEach(btn => {
    btn.addEventListener('click', () => {
      const r = invEquipFromSlot(+btn.dataset.invEquip);
      if (typeof showToast === 'function') showToast(r.msg, 1800);
      renderInventoryModal();
    });
  });
}
function openInventoryModal() {
  renderInventoryModal();
  modalBackdrop.style.display = 'block';
  inventoryModal.style.display = 'flex';
}
inventoryBtnEl.addEventListener('click', openInventoryModal);
document.getElementById('inventoryCloseBtn').addEventListener('click', closeAllModals);

/* アイテム屋・農協・他ファイルから使う窓口 */
const Inventory = {
  SLOT_COUNT: INV_SLOT_COUNT,
  STACK_MAX: INV_STACK_MAX,
  total: invTotal,
  canAdd: invCanAdd,
  add: invAdd,
  remove: invRemove,
  usedSlots: invUsedSlots,
  itemInfo: invItemInfo,
  gearKey: invGearKey,
  equipFromSlot: invEquipFromSlot,
  isEquippedGear: invIsEquippedGear,
  usePotion: invUsePotion,
  legacySnapshot: invLegacySnapshot,
  getSaveSlots: invGetSaveSlots,
  applySave: invApplySave,
  open: openInventoryModal,
  render: renderInventoryModal,
  // ルアーフィッシング(js/fishing.js・農協の魚売却から使う窓口)
  fishKey: (size) => 'fish:' + Math.round(Number(size)),
  canAddFish: (size) => invCanAdd('fish:' + Math.round(Number(size)), 1),
  addFish: (size) => { const k = 'fish:' + Math.round(Number(size)); return invItemInfo(k) ? invAdd(k, 1) === 1 : false; },
  // 持っている魚のスタック一覧(サイズの小さい順) [{ key, sizeCm, n }]
  fishStacks: () => {
    const m = {};
    invSlots.forEach(s => { if (s && s.key.startsWith('fish:')) m[s.key] = (m[s.key] || 0) + s.n; });
    return Object.keys(m).map(k => ({ key: k, sizeCm: Number(k.slice(5)), n: m[k] })).sort((a, b) => a.sizeCm - b.sizeCm);
  },
};
