import fs from 'fs';
import path from 'path';
import { GachaPool, Rarity, ShopItem } from '../types';
import { UserStore } from '../stores/UserStore';

const SHOP_ITEMS_PATH = path.join(__dirname, '../../data/shop_items.json');
const GACHA_POOLS_PATH = path.join(__dirname, '../../data/gacha_pools.json');

function loadShopItems(): ShopItem[] {
  if (!fs.existsSync(SHOP_ITEMS_PATH)) return [];
  return JSON.parse(fs.readFileSync(SHOP_ITEMS_PATH, 'utf-8')) as ShopItem[];
}

function loadGachaPools(): GachaPool[] {
  if (!fs.existsSync(GACHA_POOLS_PATH)) return [];
  return JSON.parse(fs.readFileSync(GACHA_POOLS_PATH, 'utf-8')) as GachaPool[];
}

const RARITY_RATES: Record<Rarity, number> = {
  N:   0.60,
  R:   0.30,
  SR:  0.09,
  SSR: 0.01,
};

function pickRarity(): Rarity {
  const r = Math.random();
  let cum = 0;
  for (const [rarity, rate] of Object.entries(RARITY_RATES) as [Rarity, number][]) {
    cum += rate;
    if (r < cum) return rarity;
  }
  return 'N';
}

export class GachaService {
  static getAvailablePools(): GachaPool[] {
    const now = new Date().toISOString();
    return loadGachaPools().filter(pool => {
      if (!pool.isLimited) return true;
      if (pool.availableFrom && now < pool.availableFrom) return false;
      if (pool.availableTo && now > pool.availableTo) return false;
      return true;
    });
  }

  static getPoolWithItems(poolId: string, userId?: string): (GachaPool & { items: (ShopItem & { owned: boolean })[] }) | null {
    const pool = loadGachaPools().find(p => p.id === poolId);
    if (!pool) return null;
    const allItems = loadShopItems();
    const ownedItems = userId ? (UserStore.getById(userId)?.ownedItems ?? []) : [];
    const items = pool.itemIds
      .map(id => allItems.find(item => item.id === id))
      .filter((item): item is ShopItem => item !== null)
      .map(item => ({ ...item, owned: ownedItems.includes(item.id) }));
    return { ...pool, items };
  }

  static draw(userId: string, poolId: string, count: 1 | 10): ShopItem[] | null {
    const pool = loadGachaPools().find(p => p.id === poolId);
    if (!pool) return null;

    const cost = count === 10 ? 450 : 50;
    const user = UserStore.getById(userId);
    if (!user) return null;
    if ((user.ecoins ?? 0) < cost) return null;

    const allItems = loadShopItems();
    const poolItems = pool.itemIds
      .map(id => allItems.find(item => item.id === id))
      .filter((item): item is ShopItem => item !== null);

    const unowned = poolItems.filter(item => !(user.ownedItems ?? []).includes(item.id));
    if (unowned.length === 0) return null;

    const results: ShopItem[] = [];
    const newlyOwned: string[] = [];

    for (let i = 0; i < count; i++) {
      const rarity = pickRarity();
      const rarityItems = unowned.filter(item => item.rarity === rarity && !newlyOwned.includes(item.id));
      const fallback    = unowned.filter(item => !newlyOwned.includes(item.id));

      const pool_ = rarityItems.length > 0 ? rarityItems : fallback;
      if (pool_.length === 0) break;

      const picked = pool_[Math.floor(Math.random() * pool_.length)];
      results.push(picked);
      newlyOwned.push(picked.id);
    }

    if (results.length === 0) return null;

    // Eコイン消費 & アイテム付与
    UserStore.consumeEcoins(userId, cost);
    const currentOwned = user.ownedItems ?? [];
    UserStore.update(userId, { ownedItems: [...currentOwned, ...newlyOwned] });

    return results;
  }
}
