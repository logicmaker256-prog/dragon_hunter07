/* ---------------------------------------------------------------------
   アイテム屋(js/shop.js)
   game.html の「20. ステータス画面 / アイテム屋UI」セクションから、アイテム屋に
   関する部分だけを安全に分離したファイル。
   CONFIG / buildings / player / inventory / playerGold / updateRewardHud() /
   updatePotionBar() / closeAllModals() / modalBackdrop / openStatusModal() など、
   game.html本編で定義されるグローバルをそのまま利用するため、このファイルは
   <script src="js/shop.js"> を game.html 本編の <script> より後に
   読み込む必要がある(現在の配置のまま変更しないこと)。
   WEAPONS / ARMORS / equippedWeapon / equippedArmor / equippedRareWeapon() /
   playerATK() / playerDEF() / tryEquipWeaponIfBetter() / tryEquipArmorIfBetter()
   は js/status.js(game.html本編より前に読み込み済み)のグローバルを利用する。

   【インベントリ管理対応】武器・防具の「購入」は従来どおりアイテム屋で行うが、
   購入した装備はインベントリ(js/inventory.js)に入るだけで、アイテム屋では
   装備しない(自動装備もやめた)。装備はインベントリ画面の「装備」から行う。
   (js/status.js の tryEquipWeaponIfBetter/tryEquipArmorIfBetter は残してあるが、
    アイテム屋からは呼ばない)
--------------------------------------------------------------------- */
const shopModal = document.getElementById('shopModal');
const shopBody = document.getElementById('shopBody');
const shopGoldEl = document.getElementById('shopGold');

function renderShopModal() {
  shopGoldEl.textContent = `所持ゴールド: ${playerGold} G`;
  // 仕様⑥: メイン画面のステータスボタンを削除した代わりに、アイテム屋でも
  // 簡単な現在のステータスを確認できるようにする(くわしくは下の
  // 「くわしいステータスを見る」ボタンからstatusModalを開ける)。
  let html = `<div class="statRow"><span>Lv.${playerLevel} ／ HP${hpMax} ／ MP${mpMax} ／ ATK${playerATK()} ／ DEF${playerDEF()}</span></div>`;
  html += '<div class="shopSectionTitle">回復アイテム</div>';
  html += `<div class="shopItemRow"><div class="itemInfo"><span>HP回復薬</span><small>${HP_POTION_PRICE}G ・ 使い捨て、HP全回復 ・ 所持${inventory.hpPotion}(インベントリから使う)</small></div>
    <button class="shopBuyBtn" id="buyHpPotion" ${playerGold < HP_POTION_PRICE ? 'disabled' : ''}>購入</button></div>`;
  html += `<div class="shopItemRow"><div class="itemInfo"><span>MP回復薬</span><small>${MP_POTION_PRICE}G ・ 使い捨て、MP全回復 ・ 所持${inventory.mpPotion}(インベントリから使う)</small></div>
    <button class="shopBuyBtn" id="buyMpPotion" ${playerGold < MP_POTION_PRICE ? 'disabled' : ''}>購入</button></div>`;

  // 睡眠・空腹度仕様: 携帯食(価格はCONFIG.survival.rationPrice=8G。食べるのはインベントリから・時間はかからない)
  const rationPrice = CONFIG.survival.rationPrice;
  html += `<div class="shopSectionTitle">食料</div>`;
  html += `<div class="shopItemRow"><div class="itemInfo"><span>🍙 携帯食</span><small>${rationPrice}G ・ 食べると空腹度100%(時間はかからない) ・ 所持${Inventory.total('ration')}(インベントリから食べる)</small></div>
    <button class="shopBuyBtn" id="buyRation" ${playerGold < rationPrice ? 'disabled' : ''}>購入</button></div>`;

  html += '<div class="shopSectionTitle">武器(購入するとインベントリに入ります・装備はインベントリから)</div>';
  if (equippedRareWeapon()) {
    html += `<div class="statRow"><span>⚔️ レア武器「${equippedRareWeapon().name}」を装備中(🐾牧場メニューで管理)</span></div>`;
  }
  WEAPONS.forEach((w, i) => {
    const isEquipped = equippedWeapon === w && !equippedRareWeapon();
    html += `<div class="shopItemRow"><div class="itemInfo"><span>${w.name}</span><small>${w.price}G ・ 攻撃力+${w.atk} ・ 所持${Inventory.total(Inventory.gearKey('weapon', i))}</small></div>
      ${isEquipped ? '<span class="equippedTag">装備中</span>' :
        `<button class="shopBuyBtn" data-weapon="${i}" ${playerGold < w.price ? 'disabled' : ''}>購入</button>`}</div>`;
  });

  html += '<div class="shopSectionTitle">防具(購入するとインベントリに入ります・装備はインベントリから)</div>';
  ARMORS.forEach((a, i) => {
    const isEquipped = equippedArmor === a;
    html += `<div class="shopItemRow"><div class="itemInfo"><span>${a.name}</span><small>${a.price}G ・ 防御力+${a.def} ・ 所持${Inventory.total(Inventory.gearKey('armor', i))}</small></div>
      ${isEquipped ? '<span class="equippedTag">装備中</span>' :
        `<button class="shopBuyBtn" data-armor="${i}" ${playerGold < a.price ? 'disabled' : ''}>購入</button>`}</div>`;
  });

  shopBody.innerHTML = html;
  const hpBtn = document.getElementById('buyHpPotion');
  if (hpBtn) hpBtn.addEventListener('click', () => {
    if (playerGold < HP_POTION_PRICE) return;
    // インベントリが満杯のときは、お金を払って薬が消えることのないよう購入しない
    if (!Inventory.canAdd('hpPotion', 1)) { showToast('インベントリがいっぱいです', 1800); return; }
    playerGold -= HP_POTION_PRICE; inventory.hpPotion++;
    updateRewardHud(); updatePotionBar(); renderShopModal();
  });
  const mpBtn = document.getElementById('buyMpPotion');
  if (mpBtn) mpBtn.addEventListener('click', () => {
    if (playerGold < MP_POTION_PRICE) return;
    if (!Inventory.canAdd('mpPotion', 1)) { showToast('インベントリがいっぱいです', 1800); return; }
    playerGold -= MP_POTION_PRICE; inventory.mpPotion++;
    updateRewardHud(); updatePotionBar(); renderShopModal();
  });
  const rationBtn = document.getElementById('buyRation');
  if (rationBtn) rationBtn.addEventListener('click', () => {
    const price = CONFIG.survival.rationPrice;
    if (playerGold < price) return;
    // インベントリが満杯のときは、お金を払って携帯食が消えることのないよう購入しない
    if (!Inventory.canAdd('ration', 1)) { showToast('インベントリがいっぱいです', 1800); return; }
    playerGold -= price; Inventory.add('ration', 1);
    updateRewardHud(); renderShopModal();
    showToast('🍙 携帯食を購入した(インベントリから食べられます)', 2000);
  });
  shopBody.querySelectorAll('[data-weapon]').forEach(btn => {
    btn.addEventListener('click', () => {
      const w = WEAPONS[+btn.dataset.weapon];
      if (playerGold < w.price) return;
      const key = Inventory.gearKey('weapon', +btn.dataset.weapon);
      if (!Inventory.canAdd(key, 1)) { showToast('インベントリがいっぱいです(購入できません)', 2000); return; }
      playerGold -= w.price;
      Inventory.add(key, 1); // 購入した武器はインベントリへ(装備はインベントリから)
      updateRewardHud(); renderShopModal();
      showToast(`🎒 ${w.name}を購入した(インベントリから装備できます)`, 2200);
    });
  });
  shopBody.querySelectorAll('[data-armor]').forEach(btn => {
    btn.addEventListener('click', () => {
      const a = ARMORS[+btn.dataset.armor];
      if (playerGold < a.price) return;
      const key = Inventory.gearKey('armor', +btn.dataset.armor);
      if (!Inventory.canAdd(key, 1)) { showToast('インベントリがいっぱいです(購入できません)', 2000); return; }
      playerGold -= a.price;
      Inventory.add(key, 1); // 購入した防具はインベントリへ(装備はインベントリから)
      updateRewardHud(); renderShopModal();
      showToast(`🎒 ${a.name}を購入した(インベントリから装備できます)`, 2200);
    });
  });
}
function openShopModal() {
  renderShopModal();
  modalBackdrop.style.display = 'block';
  shopModal.style.display = 'flex';
}

document.getElementById('shopCloseBtn').addEventListener('click', closeAllModals);
document.getElementById('shopEnterBtn').addEventListener('click', openShopModal);
// 仕様⑥: アイテム屋から、くわしいステータス画面(statusModal)を開けるようにする。
document.getElementById('shopStatusBtn').addEventListener('click', openStatusModal);

/* --- アイテム屋への出入り判定(近づくとプロンプト表示) / 敵はアイテム屋の中に入れない --- */
const shopPromptEl = document.getElementById('shopPrompt');
const SHOP_POS = { x: buildings[0].x, z: buildings[0].z };
const SHOP_ENTER_RADIUS = 3.5;
CONFIG.shopSafeRadius = 4.5;

function updateShopProximity() {
  if (!player) return;
  const d = Math.hypot(player.position.x - SHOP_POS.x, player.position.z - SHOP_POS.z);
  shopPromptEl.style.display = d < SHOP_ENTER_RADIUS ? 'flex' : 'none';
}
