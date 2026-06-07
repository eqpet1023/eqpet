import fs from 'fs';
import path from 'path';

const FAVORITES_DIR = path.join(__dirname, '../../data/favorites');

function favoritePath(userId: string): string {
  if (!fs.existsSync(FAVORITES_DIR)) fs.mkdirSync(FAVORITES_DIR, { recursive: true });
  return path.join(FAVORITES_DIR, `${userId}.json`);
}

export class FavoriteStore {
  static get(userId: string): string[] {
    const p = favoritePath(userId);
    if (!fs.existsSync(p)) return [];
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as string[];
  }

  static add(userId: string, agentId: string): void {
    const favorites = FavoriteStore.get(userId);
    if (!favorites.includes(agentId)) {
      favorites.push(agentId);
      fs.writeFileSync(favoritePath(userId), JSON.stringify(favorites, null, 2));
    }
  }

  static remove(userId: string, agentId: string): void {
    const favorites = FavoriteStore.get(userId).filter(id => id !== agentId);
    fs.writeFileSync(favoritePath(userId), JSON.stringify(favorites, null, 2));
  }

  static isFavorite(userId: string, agentId: string): boolean {
    return FavoriteStore.get(userId).includes(agentId);
  }
}
