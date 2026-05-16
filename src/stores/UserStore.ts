import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { User, UserRole, UserPlan } from '../types';

const DATA_FILE = path.join(__dirname, '../../data/users.json');

function loadUsers(): User[] {
  if (!fs.existsSync(DATA_FILE)) return [];
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
}

function saveUsers(users: User[]): void {
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
}
