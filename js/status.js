/* ---------------------------------------------------------------------
   勇者ステータス管理(js/status.js)

   「勇者ステータスの分離・アイテム屋・教会連携」プロンプトへの対応。
   game.htmlの「04. ゲーム基本状態」「20. ステータス画面」にあった
   勇者ステータス関連の処理を、計算式・初期値・変数名を一切変更せずに
   このファイルへ切り出したもの。

   ここで宣言する heroStats / playerLevel / playerExp / unspentPoints /
   hpMax / mpMax / WEAPONS / ARMORS / equippedWeapon / equippedArmor /
   playerATK() / playerDEF() / attackComboDurationSec() / STAT_LABELS /
   allocatePoint() は、これまでどおりgame.html本編・js/shop.js・
   js/church.js から同名のグローバルとして参照できる(変数名・挙動は無変更)。

   安全方針:
   ・このファイルは game.html 本編の <script> より前(three.js 等の
     読み込みよりも前)に読み込む。中身はすべて数値・配列・関数の定義
     だけで、CONFIG/THREE/buildings等 game.html本編の値には一切依存
     しないため、読み込み順を早めても問題ない。
   ・現在の勇者の"実行中のHP/MP"(hp/mp、スタミナと合わせて game.html
     側で管理)や、rareWeapons(Phase6のレア武器コレクション)は
     このファイルの担当範囲外とし、これまでどおりgame.html側に残した
     (プロンプトの「絶対に変更・削除してはいけないもの」を優先)。
     playerATK()がレア武器を優先する分岐だけは既存のまま維持している
     (equippedRareWeapon()はgame.html側で定義される関数を実行時に
     参照する。読み込み順が逆でも、実際に呼ばれるのはゲーム開始後の
     戦闘時なので問題ない)。
--------------------------------------------------------------------- */

/* レベルアップ時に付与される振り分けポイント。仕様④: 将来変更しやすいよう定数にまとめてある。
   バランス調整で+3から+2へ変更した。 */
const LEVEL_UP_BONUS_POINTS = 2; // バランス調整: 3→2(すぐ強くなりすぎないように)

/* ステータス画面・教会のレベルアップボーナス画面の両方で使う表示ラベル */
const STAT_LABELS = { vit: '体力', atk: '攻撃力', def: '防御力', int: '知力', agi: '素早さ' };

/* 勇者の基本ステータス(初期値1。ショップ/レベルアップ実装まではこの値のまま) */
const heroStats = { vit: 1, atk: 1, def: 1, int: 1, agi: 1 };
function calcHpMax() { return 90 + 10 * heroStats.vit; }
function calcMpMax() { return 40 + 10 * heroStats.int; }
let hpMax = calcHpMax();
let mpMax = calcMpMax();
let playerLevel = 1, playerExp = 0;
let unspentPoints = 0;

/* --- 装備(武器・防具の2枠のみ) --- */
const WEAPONS = [
  { name: 'ナイフ', price: 50, atk: 10 },
  { name: 'ショートソード', price: 100, atk: 20 },
  { name: 'ロングソード', price: 200, atk: 40 },
  { name: 'ミスリルソード', price: 400, atk: 80 },
];
const ARMORS = [
  { name: '服', price: 10, def: 10 },
  { name: 'レザーメイル', price: 100, def: 20 },
  { name: 'チェインメイル', price: 200, def: 40 },
  { name: 'プレートメイル', price: 400, def: 80 },
];
let equippedWeapon = WEAPONS[0]; // 初期装備: ナイフ
let equippedArmor = ARMORS[0];   // 初期装備: 服

/* 最終ステータス = 基本ステータス(heroStats) + 装備補正、という考え方を
   一元化した関数。武器についてはレア武器(Phase6・game.html側で管理)が
   装備されている場合はそちらを優先する既存仕様を維持している。 */
function playerATK() {
  const rw = (typeof equippedRareWeapon === 'function') ? equippedRareWeapon() : null;
  return heroStats.atk * 5 + (rw ? rw.atk : (equippedWeapon ? equippedWeapon.atk : 0));
}
function playerDEF() { return heroStats.def * 5 + (equippedArmor ? equippedArmor.def : 0); }
/* AGIが高いほど攻撃コンボが速くなる(30フレーム-素早さ、最短10フレーム / 60fps換算) */
function attackComboDurationSec() { return Math.max(10, 30 - heroStats.agi) / 60; }

/* レベルアップボーナスポイントを1点振り分ける。
   仕様④: 振り分け先はVIT/ATK/DEF/INT/AGIのいずれか。HP上限/MP上限の増加
   (calcHpMax/calcMpMaxと連動)まではここで反映するが、"現在のHP/MP"
   (hp/mp)の回復量ぶんの加算は、実行中の状態を持つgame.html側の
   呼び出し元で行う(このファイルではhp/mpという実行中の値そのものは
   扱わない設計のため)。戻り値: 実際に振り分けられたらtrue。 */
function allocatePoint(stat) {
  if (unspentPoints <= 0) return false;
  if (!Object.prototype.hasOwnProperty.call(heroStats, stat)) return false;
  unspentPoints--;
  heroStats[stat]++;
  if (stat === 'vit') hpMax += 10;
  if (stat === 'int') mpMax += 10;
  return true;
}

/* 仕様②: アイテム屋で購入した装備は、「現在装備しているものより補正値が
   高い場合」だけ自動的に装備を更新する(購入しただけでは装備を変更しない)。
   currentBonusOverride: 呼び出し元(js/shop.js)がレア武器装備中などの
   実際の"今の装備補正値"を渡せるようにするための引数(省略時はショップ
   武器/防具どうしの比較のみを行う)。戻り値: 装備を更新したらtrue。 */
function tryEquipWeaponIfBetter(item, currentBonusOverride) {
  const currentBonus = (typeof currentBonusOverride === 'number')
    ? currentBonusOverride
    : (equippedWeapon ? equippedWeapon.atk : 0);
  if (item.atk > currentBonus) { equippedWeapon = item; return true; }
  return false;
}
function tryEquipArmorIfBetter(item, currentBonusOverride) {
  const currentBonus = (typeof currentBonusOverride === 'number')
    ? currentBonusOverride
    : (equippedArmor ? equippedArmor.def : 0);
  if (item.def > currentBonus) { equippedArmor = item; return true; }
  return false;
}

/* --- セーブ/ロード用データとの変換 ---
   仕様⑦: 現在のセーブデータのキー名・構造(playerLevel/playerExp/
   unspentPoints/heroStats/weaponIndex/armorIndex)は一切変更していない
   ため、このファイルに切り出した後も、これまでのセーブデータをそのまま
   読み込める。 */
function statusGetSaveData() {
  return {
    playerLevel, playerExp, unspentPoints,
    heroStats: { ...heroStats },
    weaponIndex: equippedWeapon ? WEAPONS.indexOf(equippedWeapon) : -1,
    armorIndex: equippedArmor ? ARMORS.indexOf(equippedArmor) : -1,
  };
}
function statusApplySaveData(data) {
  if (!data) return;
  if (typeof data.playerLevel === 'number') playerLevel = data.playerLevel;
  if (typeof data.playerExp === 'number') playerExp = data.playerExp;
  if (typeof data.unspentPoints === 'number') unspentPoints = data.unspentPoints;
  // 現状のセーブデータは必ずheroStatsを持つ(旧仕様の頃から存在する)ため
  // 基本的にはこの分岐に入るが、万一無い場合でも初期値のまま起動できるよう
  // 安全側に倒す(既存セーブデータを壊して初期化する、ということはしない)。
  if (data.heroStats && typeof data.heroStats === 'object') {
    Object.assign(heroStats, data.heroStats);
  }
  hpMax = calcHpMax(); mpMax = calcMpMax();
  equippedWeapon = (typeof data.weaponIndex === 'number' && data.weaponIndex >= 0)
    ? WEAPONS[data.weaponIndex] : null;
  equippedArmor = (typeof data.armorIndex === 'number' && data.armorIndex >= 0)
    ? ARMORS[data.armorIndex] : null;
}

/* 仕様③: アイテム屋・教会・戦闘・表示側から共通で使える一元化した窓口。
   既存コード(game.html/js/shop.js/js/church.js)は引き続き上の
   グローバル変数・関数(heroStats/playerATK()等)を直接使ってよいが、
   新しく書く連携コードはこのStatusオブジェクト経由に統一する。 */
const Status = {
  LEVEL_UP_BONUS_POINTS,
  getLevel: () => playerLevel,
  getExp: () => playerExp,
  getUnspentPoints: () => unspentPoints,
  getStats: () => ({ ...heroStats }),
  getStat: (key) => heroStats[key],
  getHpMax: () => hpMax,
  getMpMax: () => mpMax,
  getAttack: () => playerATK(),
  getDefense: () => playerDEF(),
  getEquippedWeapon: () => equippedWeapon,
  getEquippedArmor: () => equippedArmor,
  allocatePoint,
  tryEquipWeaponIfBetter,
  tryEquipArmorIfBetter,
  getSaveData: statusGetSaveData,
  applySaveData: statusApplySaveData,
};
