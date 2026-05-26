import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { User, UserRole, UserPlan, PLAN_CONFIG } from '../types';

function todayJST(): string {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

const DATA_FILE = path.join(__dirname, '../../data/users.json');

function loadUsers(): User[] {
  if (!fs.existsSync(DATA_FILE)) return [];
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
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
        email:     'official@eqpet.app',
        role:      'official' as UserRole,
        plan:      'premium' as UserPlan,
        verified:  true,
        createdAt: new Date().toISOString(),
        agentIds:  [],
      };
      users.push(official);
      saveUsers(users);
    }
  }

  static create(username: string, email: string): User {
    const users = loadUsers();
    const user: User = {
      id:        uuidv4(),
      username,
      email,
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

  static getByStripeCustomerId(customerId: string): User | null {
    return loadUsers().find(u => u.stripeCustomerId === customerId) ?? null;
  }

  static canUseSonnet(userId: string): boolean {
    const user = UserStore.getById(userId);
    if (!user) return false;
    const limit = PLAN_CONFIG[user.plan].sonnetDailyLimit;
    if (limit <= 0) return false;
    const today = todayJST();
    const used  = user.sonnetUsedDate === today ? (user.sonnetUsedToday ?? 0) : 0;
    return used < limit;
  }

  static incrementSonnetCount(userId: string): void {
    const user = UserStore.getById(userId);
    if (!user) return;
    const today = todayJST();
    const used  = user.sonnetUsedDate === today ? (user.sonnetUsedToday ?? 0) : 0;
    UserStore.update(userId, { sonnetUsedToday: used + 1, sonnetUsedDate: today });
  }

  static resetAllSonnetCounts(): void {
    const users = loadUsers();
    const today = todayJST();
    for (const u of users) {
      if (u.sonnetUsedToday && u.sonnetUsedDate !== today) {
        u.sonnetUsedToday = 0;
        u.sonnetUsedDate  = today;
      }
    }
    saveUsers(users);
  }

  static sonnetRemaining(userId: string): number {
    const user = UserStore.getById(userId);
    if (!user) return 0;
    const limit = PLAN_CONFIG[user.plan].sonnetDailyLimit;
    if (limit <= 0) return 0;
    const today = todayJST();
    const used  = user.sonnetUsedDate === today ? (user.sonnetUsedToday ?? 0) : 0;
    return Math.max(0, limit - used);
  }
}
