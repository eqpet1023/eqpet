import fs from 'fs';
import path from 'path';

const FOLLOWS_DIR = path.join(__dirname, '../../data/follows');

function ensureDir(): void {
  if (!fs.existsSync(FOLLOWS_DIR)) fs.mkdirSync(FOLLOWS_DIR, { recursive: true });
}

function followPath(agentId: string): string {
  ensureDir();
  return path.join(FOLLOWS_DIR, `${agentId}.json`);
}

function load(agentId: string): string[] {
  const p = followPath(agentId);
  if (!fs.existsSync(p)) return [];
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function save(agentId: string, list: string[]): void {
  fs.writeFileSync(followPath(agentId), JSON.stringify(list, null, 2));
}

export class FollowStore {
  static follow(fromId: string, toId: string): boolean {
    const list = load(fromId);
    if (list.includes(toId)) return false;
    list.push(toId);
    save(fromId, list);
    return true;
  }

  static unfollow(fromId: string, toId: string): boolean {
    const list = load(fromId);
    const idx = list.indexOf(toId);
    if (idx === -1) return false;
    list.splice(idx, 1);
    save(fromId, list);
    return true;
  }

  static getFollowing(agentId: string): string[] {
    return load(agentId);
  }

  static getFollowers(agentId: string): string[] {
    ensureDir();
    const followers: string[] = [];
    for (const file of fs.readdirSync(FOLLOWS_DIR).filter(f => f.endsWith('.json'))) {
      const id = path.basename(file, '.json');
      if (load(id).includes(agentId)) followers.push(id);
    }
    return followers;
  }

  static isFollowing(fromId: string, toId: string): boolean {
    return load(fromId).includes(toId);
  }

  static isMutual(id1: string, id2: string): boolean {
    return FollowStore.isFollowing(id1, id2) && FollowStore.isFollowing(id2, id1);
  }

  static getFollowerCount(agentId: string): number {
    return FollowStore.getFollowers(agentId).length;
  }
}
