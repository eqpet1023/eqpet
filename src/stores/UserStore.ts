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

  // ログイン処理: 7日連続ボーナス分のみ自動付与して返す（0=既ログイン済み or ボーナスなし）
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

    // 7日連続ボーナスのみ自動付与（ログインボーナス10枚は要受取）
    let streakBonus = 0;
    if (streak % 7 === 0) {
      streakBonus = 30;
      u.ecoins = (u.ecoins ?? 0) + streakBonus;
    }

    u.lastLoginDate = today;
    u.loginStreak   = streak;

    // 日付が変わっていたらミッションをリセット、loggedIn: true をセット
    if (!u.dailyMissions || u.dailyMissions.date !== today) {
      u.dailyMissions = {
        loggedIn: true, loggedInClaimed: false,
        liked3: false, liked3Claimed: false,
        stayed5min: false, stayed5minClaimed: false,
        chatted: false, chattedClaimed: false,
        allCleared: false, allClearedClaimed: false,
        date: today,
      };
    } else {
      u.dailyMissions.loggedIn = true;
    }

    saveUsers(users);
    return streakBonus;
  }

  // ミッション達成フラグのみ更新（Eコイン付与なし）
  static completeMission(userId: string, mission: 'liked3' | 'stayed5min' | 'chatted'): boolean {
    const today = todayJST();
    const users = loadUsers();
    const idx = users.findIndex(u => u.id === userId);
    if (idx === -1) return false;
    const u = users[idx];

    if (!u.dailyMissions || u.dailyMissions.date !== today) {
      u.dailyMissions = {
        loggedIn: false, loggedInClaimed: false,
        liked3: false, liked3Claimed: false,
        stayed5min: false, stayed5minClaimed: false,
        chatted: false, chattedClaimed: false,
        allCleared: false, allClearedClaimed: false,
        date: today,
      };
    }

    // chatted は Premium/Founder 限定
    if (mission === 'chatted' && u.plan !== 'premium' && u.plan !== 'founder') return false;

    if (u.dailyMissions[mission]) return false; // 既達成

    u.dailyMissions[mission] = true;
    saveUsers(users);
    return true;
  }

  // ミッション受取: 達成済み&未受取の場合のみEコイン付与
  static claimMission(userId: string, mission: 'login' | 'liked3' | 'stayed5min' | 'chatted' | 'allCleared'): number {
    const today = todayJST();
    const users = loadUsers();
    const idx = users.findIndex(u => u.id === userId);
    if (idx === -1) return 0;
    const u = users[idx];

    if (!u.dailyMissions || u.dailyMissions.date !== today) return 0;

    const m = u.dailyMissions;
    const isPremium = u.plan === 'premium' || u.plan === 'founder';
    const REWARD: Record<string, number> = { login: 10, liked3: 10, stayed5min: 5, chatted: 10, allCleared: 10 };

    let granted = 0;
    switch (mission) {
      case 'login':
        if (!m.loggedIn || m.loggedInClaimed) return 0;
        m.loggedInClaimed = true; granted = REWARD.login; break;
      case 'liked3':
        if (!m.liked3 || m.liked3Claimed) return 0;
        m.liked3Claimed = true; granted = REWARD.liked3; break;
      case 'stayed5min':
        if (!m.stayed5min || m.stayed5minClaimed) return 0;
        m.stayed5minClaimed = true; granted = REWARD.stayed5min; break;
      case 'chatted':
        if (!isPremium || !m.chatted || m.chattedClaimed) return 0;
        m.chattedClaimed = true; granted = REWARD.chatted; break;
      case 'allCleared':
        if (!m.allCleared || m.allClearedClaimed) return 0;
        m.allClearedClaimed = true; granted = REWARD.allCleared; break;
    }

    if (granted === 0) return 0;

    u.ecoins = (u.ecoins ?? 0) + granted;

    // 個別ミッション全受取済みなら allCleared を解放
    if (mission !== 'allCleared' && !m.allCleared) {
      const allClaimed = m.loggedInClaimed && m.liked3Claimed && m.stayed5minClaimed && (!isPremium || m.chattedClaimed);
      if (allClaimed) m.allCleared = true;
    }

    saveUsers(users);
    return granted;
  }

}
