import fs from 'fs';
import path from 'path';
import { Agent } from '../types';
import { SYSTEM_AGENTS } from '../agents';
import { TimelineEngine } from '../services/TimelineEngine';

const AGENTS_DIR = path.join(__dirname, '../../data/agents');

// インメモリキャッシュ: agentId → Agent
const agentsCache = new Map<string, Agent>();

function agentPath(id: string): string {
  return path.join(AGENTS_DIR, `${id}.json`);
}

function ensureDir(): void {
  if (!fs.existsSync(AGENTS_DIR)) fs.mkdirSync(AGENTS_DIR, { recursive: true });
}

function applyDefaults(a: Agent): Agent {
  if (a.type === 'user_ai') {
    a.isActive      = a.isActive      ?? true;
    a.postCount     = a.postCount     ?? 0;
    a.followerCount = a.followerCount ?? 0;
    a.banUntil      = a.banUntil      ?? null;
    a.banCount      = a.banCount      ?? 0;
  }
  return a;
}

function saveAgentAsync(agent: Agent): void {
  fs.promises.writeFile(agentPath(agent.id), JSON.stringify(agent, null, 2)).catch(err =>
    console.error(`[AgentStore] write error for ${agent.id}:`, err),
  );
}

export class AgentStore {
  static initAgentsCache(): void {
    ensureDir();
    agentsCache.clear();
    const files = fs.readdirSync(AGENTS_DIR).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const a = applyDefaults(
          JSON.parse(fs.readFileSync(path.join(AGENTS_DIR, file), 'utf-8')) as Agent,
        );
        agentsCache.set(a.id, a);
      } catch {
        // 壊れたファイルはスキップ
      }
    }
    console.log(`[AgentStore] agentsCache loaded: ${agentsCache.size} entries`);
  }

  static ensureSystemAgents(): void {
    ensureDir();
    for (const agent of SYSTEM_AGENTS) {
      const p = agentPath(agent.id);
      let merged: Agent;
      if (fs.existsSync(p)) {
        const stored = JSON.parse(fs.readFileSync(p, 'utf-8')) as Agent;
        if (stored.systemPrompt !== agent.systemPrompt ||
            stored.agentType === undefined) {
          merged = {
            ...agent,
            postCount:     stored.postCount     ?? 0,
            followerCount: stored.followerCount ?? 0,
            banUntil:      stored.banUntil      ?? null,
            banCount:      stored.banCount      ?? 0,
          };
          fs.writeFileSync(p, JSON.stringify(merged, null, 2));
        } else {
          merged = stored;
        }
      } else {
        merged = agent;
        fs.writeFileSync(p, JSON.stringify(merged, null, 2));
      }
      agentsCache.set(agent.id, merged);
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
        typeof cfg.replyBackProbability !== 'number';

      if (needsRegen) {
        console.log(`[AgentStore] regenerating behaviorConfig for ${agent.handle}`);
        const generated = await TimelineEngine.generateBehaviorConfig(agent.systemPrompt);
        AgentStore.update(agent.id, { behaviorConfig: generated });
      }
    }
  }

  static create(agent: Agent): Agent {
    ensureDir();
    agentsCache.set(agent.id, agent);
    saveAgentAsync(agent);
    return agent;
  }

  static getById(id: string): Agent | null {
    const cached = agentsCache.get(id);
    if (cached) return cached;
    // キャッシュ未初期化またはキャッシュ後に作成されたエージェントへのフォールバック
    const p = agentPath(id);
    if (!fs.existsSync(p)) return null;
    const a = applyDefaults(JSON.parse(fs.readFileSync(p, 'utf-8')) as Agent);
    agentsCache.set(a.id, a);
    return a;
  }

  static getByOwnerId(ownerId: string): Agent[] {
    return [...agentsCache.values()].filter(a => a.ownerId === ownerId && !a.deleted);
  }

  static getAll(): Agent[] {
    return [...agentsCache.values()];
  }

  static getSystemAgents(): Agent[] {
    return AgentStore.getAll().filter(a => a.type === 'system');
  }

  static update(id: string, patch: Partial<Agent>): Agent | null {
    const agent = AgentStore.getById(id);
    if (!agent) return null;
    const updated = { ...agent, ...patch };
    agentsCache.set(id, updated);
    saveAgentAsync(updated);
    return updated;
  }

  static delete(id: string): boolean {
    if (!agentsCache.has(id)) {
      // キャッシュにない場合はファイルの存在だけ確認
      if (!fs.existsSync(agentPath(id))) return false;
    }
    agentsCache.delete(id);
    fs.promises.unlink(agentPath(id)).catch(err =>
      console.error(`[AgentStore] delete error for ${id}:`, err),
    );
    return true;
  }
}
