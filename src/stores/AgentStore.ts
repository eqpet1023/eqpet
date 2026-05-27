import fs from 'fs';
import path from 'path';
import { Agent } from '../types';
import { SYSTEM_AGENTS } from '../agents';
import { TimelineEngine } from '../services/TimelineEngine';

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
      const p = agentPath(agent.id);
      if (fs.existsSync(p)) {
        const stored = JSON.parse(fs.readFileSync(p, 'utf-8')) as Agent;
        if (stored.systemPrompt !== agent.systemPrompt ||
            stored.agentType === undefined ||
            stored.isNewsAgent === undefined) {
          fs.writeFileSync(p, JSON.stringify({
            ...agent,
            postCount:     stored.postCount     ?? 0,
            followerCount: stored.followerCount ?? 0,
            banUntil:      stored.banUntil      ?? null,
            banCount:      stored.banCount      ?? 0,
          }, null, 2));
        }
      } else {
        fs.writeFileSync(p, JSON.stringify(agent, null, 2));
      }
    }
  }

  // 起動時にbehaviorConfigの新フィールドが不足しているエージェントを補完する
  static async initialize(): Promise<void> {
    ensureDir();
    const agents = AgentStore.getAll();
    for (const agent of agents) {
      const cfg = agent.behaviorConfig;
      const needsRegen = !cfg ||
        typeof cfg.trendSensitivity     !== 'number' ||
        typeof cfg.replyAggression      !== 'number' ||
        typeof cfg.postLengthRatio      !== 'number' ||
        typeof cfg.replyBackProbability !== 'number';  // 新フィールド追加検出

      if (needsRegen) {
        console.log(`[AgentStore] regenerating behaviorConfig for ${agent.handle}`);
        const generated = await TimelineEngine.generateBehaviorConfig(agent.systemPrompt);
        AgentStore.update(agent.id, { behaviorConfig: generated });
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
    const a = JSON.parse(fs.readFileSync(p, 'utf-8')) as Agent;
    if (a.type === 'user_ai') {
      a.isActive      = a.isActive      ?? true;
      a.postCount     = a.postCount     ?? 0;
      a.followerCount = a.followerCount ?? 0;
      a.banUntil      = a.banUntil      ?? null;
      a.banCount      = a.banCount      ?? 0;
    }
    return a;
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
      .map(f => {
        const a = JSON.parse(fs.readFileSync(path.join(AGENTS_DIR, f), 'utf-8')) as Agent;
        if (a.type === 'user_ai') {
          a.isActive     = a.isActive     ?? true;
          a.postCount    = a.postCount    ?? 0;
          a.followerCount = a.followerCount ?? 0;
          a.banUntil     = a.banUntil     ?? null;
          a.banCount     = a.banCount     ?? 0;
        }
        return a;
      });
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
