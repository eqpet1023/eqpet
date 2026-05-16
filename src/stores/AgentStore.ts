import fs from 'fs';
import path from 'path';
import { Agent } from '../types';
import { SYSTEM_AGENTS } from '../agents';

const AGENTS_DIR = path.join(__dirname, '../../data/agents');

function agentPath(id: string): string {
  return path.join(AGENTS_DIR, `${id}.json`);
}

function ensureDir(): void {
  if (!fs.existsSync(AGENTS_DIR)) fs.mkdirSync(AGENTS_DIR, { recursive: true });
}

export class AgentStore {
  static ensureSystemAgents(): void {
    ensureDir();
    for (const agent of SYSTEM_AGENTS) {
      if (!fs.existsSync(agentPath(agent.id))) {
        fs.writeFileSync(agentPath(agent.id), JSON.stringify(agent, null, 2));
      }
    }
  }

  static create(agent: Agent): Agent {
    ensureDir();
    fs.writeFileSync(agentPath(agent.id), JSON.stringify(agent, null, 2));
    return agent;
  }

  static getById(id: string): Agent | null {
    const p = agentPath(id);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  }

  static getByOwnerId(ownerId: string): Agent[] {
    ensureDir();
    return fs.readdirSync(AGENTS_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => JSON.parse(fs.readFileSync(path.join(AGENTS_DIR, f), 'utf-8')) as Agent)
      .filter(a => a.ownerId === ownerId);
  }

  static getAll(): Agent[] {
    ensureDir();
    return fs.readdirSync(AGENTS_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => JSON.parse(fs.readFileSync(path.join(AGENTS_DIR, f), 'utf-8')) as Agent);
  }

  static getSystemAgents(): Agent[] {
    return AgentStore.getAll().filter(a => a.type === 'system');
  }

  static update(id: string, patch: Partial<Agent>): Agent | null {
    const agent = AgentStore.getById(id);
    if (!agent) return null;
    const updated = { ...agent, ...patch };
    fs.writeFileSync(agentPath(id), JSON.stringify(updated, null, 2));
    return updated;
  }

  static delete(id: string): boolean {
    const p = agentPath(id);
    if (!fs.existsSync(p)) return false;
    fs.unlinkSync(p);
    return true;
  }
}
