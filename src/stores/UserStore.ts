import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { User, UserRole, UserPlan, PLAN_CONFIG } from '../types';

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

}
