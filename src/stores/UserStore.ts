import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { User, UserRole, UserPlan, PLAN_CONFIG, DailyMissions } from '../types';

function todayJST(): string {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

const DATA_FILE = path.join(__dirname, '../../data/users.json');

const VALID_PLANS: UserPlan[] = ['free', 'basic', 'premium', 'founder'];

function loadUsers(): User[] {
  if (!fs.existsSync(DATA_FILE)) return [];
  const users = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8')) as User[];
  for (const u of users) {
    if (!VALID_PLANS.includes(u.plan)) u.plan = 'free';
  }
  return users;
}

function saveUsers(users: User[]): void {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(users, null, 2));
}

export class UserStore {
  static ensureOfficial(): void {
    const users = loadUsers();
    const exists = users.some(u => u.role === 'official');
    if (!exists) {
      const official: User = {
        id:        'official',
        username:  'Eqpet',
        role:      'official' as UserRole,
        plan:      'premium' as UserPlan,
        verified:  true,
        createdAt: new Date().toISOString(),
        agentIds:  [],
      };
      users.push(official);
      saveUsers(users);
      console.log('[UserStore] official account created');
    } else {
      console.log('[UserStore] official account confirmed');
    }
  }

  static create(username: string): User {
    const users = loadUsers();
    const user: User = {
      id:        uuidv4(),
      username,
      role:      'user',
      plan:      'free',
      verified:  false,
      createdAt: new Date().toISOString(),
      agentIds:  [],
    };
    users.push(user);
    saveUsers(users);
    return user;
  }

  static getById(id: string): User | null {
    return loadUsers().find(u => u.id === id) ?? null;
  }

  static getByUsername(username: string): User | null {
    return loadUsers().find(u => u.username === username) ?? null;
  }

  static getByEmail(email: string): User | null {
    return loadUsers().find(u => u.email === email) ?? null;
  }

  static update(id: string, patch: Partial<User>): User | null {
    const users = loadUsers();
    const idx = users.findIndex(u => u.id === id);
    if (idx === -1) return null;
    users[idx] = { ...users[idx], ...patch };
    saveUsers(users);
    return users[idx];
  }

  static getAll(): User[] {
    return loadUsers();
  }

  static delete(id: string): boolean {
    const users = loadUsers();
    const idx = users.findIndex(u => u.id === id);
    if (idx === -1) return false;
    users.splice(idx, 1);
    saveUsers(users);
    return true;
  }

  static getByStripeCustomerId(customerId: string): User | null {
    return loadUsers().find(u => u.stripeCustomerId === customerId) ?? null;
  }

  static grantEcoins(userId: string, amount: number): User | null {
    const users = loadUsers();
    const idx = users.findIndex(u => u.id === userId);
    if (idx === -1) return null;
    users[idx].ecoins = (users[idx].ecoins ?? 0) + amount;
    saveUsers(users);
    return users[idx];
  }

  static consumeEcoins(userId: string, amount: number): boolean {
    const users = loadUsers();
    const idx = users.findIndex(u => u.id === userId);
    if (idx === -1) return false;
    const balance = users[idx].ecoins ?? 0;
    if (balance < amount) return false;
    users[idx].ecoins = balance - amount;
    saveUsers(users);
    return true;
  }

  // ログイン処理: 付与したEコイン数を返す（0=既にログイン済み）
  static processLogin(userId: string): number {
    const today = todayJST();
    const users = loadUsers();
    const idx = users.findIndex(u => u.id === userId);
    if (idx === -1) return 0;
    const u = users[idx];

    if (u.lastLoginDate === today) return 0;

    // 連続ログイン判定
    const yesterday = new Date(Date.now() + 9 * 60 * 60 * 1000 - 86400000).toISOString().slice(0, 10);
    const streak = u.lastLoginDate === yesterday ? (u.loginStreak ?? 0) + 1 : 1;

    let granted = 10;
    if (streak % 7 === 0) granted += 30;

    u.ecoins        = (u.ecoins ?? 0) + granted;
    u.lastLoginDate = today;
    u.loginStreak   = streak;

    // 日付が変わっていたらミッションをリセット
    if (!u.dailyMissions || u.dailyMissions.date !== today) {
      u.dailyMissions = { liked3: false, stayed5min: false, chatted: false, allCleared: false, date: today };
    }

    saveUsers(users);
    return granted;
  }

  // ミッション完了: 付与したEコイン数を返す（0=対象外or既達成）
  static completeMission(userId: string, mission: 'liked3' | 'stayed5min' | 'chatted'): number {
    const today = todayJST();
    const users = loadUsers();
    const idx = users.findIndex(u => u.id === userId);
    if (idx === -1) return 0;
    const u = users[idx];

    if (!u.dailyMissions || u.dailyMissions.date !== today) {
      u.dailyMissions = { liked3: false, stayed5min: false, chatted: false, allCleared: false, date: today };
    }

    // chatted は Premium/Founder 限定
    if (mission === 'chatted' && u.plan !== 'premium' && u.plan !== 'founder') return 0;

    if (u.dailyMissions[mission]) return 0; // 既達成

    u.dailyMissions[mission] = true;

    const reward: Record<string, number> = { liked3: 10, stayed5min: 5, chatted: 10 };
    let granted = reward[mission] ?? 0;
    u.ecoins = (u.ecoins ?? 0) + granted;

    // 全クリボーナス
    const needChatted = u.plan === 'premium' || u.plan === 'founder';
    const allDone = u.dailyMissions.liked3 && u.dailyMissions.stayed5min && (!needChatted || u.dailyMissions.chatted);
    if (allDone && !u.dailyMissions.allCleared) {
      u.dailyMissions.allCleared = true;
      u.ecoins += 10;
      granted += 10;
    }

    saveUsers(users);
    return granted;
  }

}
