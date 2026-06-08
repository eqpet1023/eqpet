// scripts/init_gacha_pools.js
// data/gacha_pools.json が存在しない場合に初期ガチャプールデータを生成する
// Usage: node scripts/init_gacha_pools.js

const fs   = require('fs');
const path = require('path');

const SHOP_ITEMS_PATH  = path.join(__dirname, '../data/shop_items.json');
const GACHA_POOLS_PATH = path.join(__dirname, '../data/gacha_pools.json');

const RARITY_WEIGHT = { SSR: 1, SR: 9, R: 30, N: 60 };

// ── 既存チェック ───────────────────────────────────────────────
if (fs.existsSync(GACHA_POOLS_PATH)) {
  console.log('[skip] data/gacha_pools.json は既に存在します。スキップします。');
  process.exit(0);
}

// ── shop_items.json 読み込み ───────────────────────────────────
if (!fs.existsSync(SHOP_ITEMS_PATH)) {
  console.error('[error] data/shop_items.json が見つかりません。先に shop_items を用意してください。');
  process.exit(1);
}

const shopItems = JSON.parse(fs.readFileSync(SHOP_ITEMS_PATH, 'utf-8'));
console.log(`[info] shop_items.json を読み込みました（${shopItems.length} アイテム）`);

// ── weight 付き items 配列と itemIds を生成 ────────────────────
const items   = shopItems.map(item => ({
  id:     item.id,
  weight: RARITY_WEIGHT[item.rarity] ?? 60,
}));
const itemIds = shopItems.map(item => item.id);

// レアリティ別内訳をログ表示
const byRarity = {};
for (const item of shopItems) {
  byRarity[item.rarity] = (byRarity[item.rarity] ?? 0) + 1;
}
for (const [rarity, count] of Object.entries(byRarity).sort()) {
  console.log(`  ${rarity}: ${count} アイテム (weight=${RARITY_WEIGHT[rarity] ?? '?'})`);
}

// ── プールデータ生成 ───────────────────────────────────────────
const pools = [
  {
    id:            'pool_standard',
    name:          'スタンダードガチャ',
    description:   '様々なアイテムが手に入る！',
    isActive:      true,
    isLimited:     false,
    availableFrom: null,
    availableTo:   null,
    items,    // weight 付きアイテム一覧（将来の重み付き抽選用）
    itemIds,  // GachaService 互換用 ID 配列
  },
];

// ── 書き出し ───────────────────────────────────────────────────
fs.writeFileSync(GACHA_POOLS_PATH, JSON.stringify(pools, null, 2), 'utf-8');
console.log(`[done] data/gacha_pools.json を生成しました（${pools.length} プール）`);
