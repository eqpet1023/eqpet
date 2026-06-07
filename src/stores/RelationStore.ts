import fs from 'fs';
import path from 'path';
import { Agent, Relation, RelationStage } from '../types';
import { DEFAULT_BEHAVIOR_CONFIG } from '../types';

const RELATIONS_DIR = path.join(__dirname, '../../data/relations');

function relationPath(fromId: string, toId: string): string {
  const dir = path.join(RELATIONS_DIR, fromId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${toId}.json`);
}

function valueToStage(value: number): RelationStage {
  if (value <= 15)  return 'hostile';
  if (value <= 30)  return 'dislike';
  if (value <= 45)  return 'unknown';
  if (value <= 55)  return 'aware';
  if (value <= 70)  return 'engaged';
  if (value <= 85)  return 'bonded';
  return 'iconic';
}

function stageToSentiment(stage: RelationStage): 'positive' | 'neutral' | 'negative' {
  if (stage === 'hostile' || stage === 'dislike') return 'negative';
  if (stage === 'bonded'  || stage === 'iconic')  return 'positive';
  return 'neutral';
}

function initRelation(agentA: Agent, agentB: Agent): Relation {
  const cfgA = agentA.behaviorConfig ?? DEFAULT_BEHAVIOR_CONFIG;
  const cfgB = agentB.behaviorConfig ?? DEFAULT_BEHAVIOR_CONFIG;

  let base = 50;

  if (cfgA.controversySeek >= 0.7 && cfgB.controversySeek >= 0.7) base -= 10;

  if (
    (cfgA.controversySeek >= 0.7 && cfgB.agreementRate >= 0.7) ||
    (cfgB.controversySeek >= 0.7 && cfgA.agreementRate >= 0.7)
  ) base -= 15;

  if (Math.abs(cfgA.toneSeriousness - cfgB.toneSeriousness) >= 0.5) base -= 8;

  if (cfgA.agreementRate >= 0.7 && cfgB.agreementRate >= 0.7) base += 8;

  const value = Math.max(30, Math.min(60, base));
  const stage = valueToStage(value);

  return {
    fromAgentId: agentA.id,
    toAgentId:   agentB.id,
    value,
    stage,
    sentiment:   stageToSentiment(stage),
    updatedAt:   new Date().toISOString(),
  };
}

export class RelationStore {
  static get(fromId: string, toId: string): Relation {
    const p = relationPath(fromId, toId);
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf-8'));
    }

    // 相性初期化
    try {
      const { AgentStore } = require('./AgentStore');
      const agentA = AgentStore.getById(fromId);
      const agentB = AgentStore.getById(toId);
      if (agentA && agentB) {
        const rel = initRelation(agentA, agentB);
        fs.writeFileSync(p, JSON.stringify(rel, null, 2));
        return rel;
      }
    } catch { /* AgentStore未初期化時のフォールバック */ }

    const stage = valueToStage(50);
    return {
      fromAgentId: fromId,
      toAgentId:   toId,
      value:       50,
      stage,
      sentiment:   stageToSentiment(stage),
      updatedAt:   new Date().toISOString(),
    };
  }

  static update(fromId: string, toId: string, delta: number): Relation {
    const rel = RelationStore.get(fromId, toId);
    const clampedDelta = Math.max(-10, Math.min(10, delta));
    const newValue = Math.max(0, Math.min(100, rel.value + clampedDelta));
    const newStage = valueToStage(newValue);
    const updated: Relation = {
      ...rel,
      value:     newValue,
      stage:     newStage,
      sentiment: stageToSentiment(newStage),
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(relationPath(fromId, toId), JSON.stringify(updated, null, 2));
    return updated;
  }

  static getTopRelations(agentId: string, limit = 10): Relation[] {
    const fromDir = path.join(RELATIONS_DIR, agentId);
    if (!fs.existsSync(fromDir)) return [];
    return fs.readdirSync(fromDir)
      .filter(f => f.endsWith('.json'))
      .map(f => JSON.parse(fs.readFileSync(path.join(fromDir, f), 'utf-8')) as Relation)
      .sort((a, b) => b.value - a.value)
      .slice(0, limit);
  }

  static getConflicts(agentId: string): Relation[] {
    const fromDir = path.join(RELATIONS_DIR, agentId);
    if (!fs.existsSync(fromDir)) return [];
    return fs.readdirSync(fromDir)
      .filter(f => f.endsWith('.json'))
      .map(f => JSON.parse(fs.readFileSync(path.join(fromDir, f), 'utf-8')) as Relation)
      .filter(r => r.sentiment === 'negative');
  }

  static decayAll(): void {
    if (!fs.existsSync(RELATIONS_DIR)) return;
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const now = Date.now();

    for (const fromDir of fs.readdirSync(RELATIONS_DIR)) {
      const fromPath = path.join(RELATIONS_DIR, fromDir);
      if (!fs.statSync(fromPath).isDirectory()) continue;

      for (const file of fs.readdirSync(fromPath).filter(f => f.endsWith('.json'))) {
        const filePath = path.join(fromPath, file);
        const rel: Relation = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

        const elapsed = now - new Date(rel.updatedAt).getTime();
        if (elapsed < sevenDaysMs) continue;

        const midpoint = 50;
        if (rel.value === midpoint) continue;
        const newValue = rel.value > midpoint ? rel.value - 1 : rel.value + 1;
        const newStage = valueToStage(newValue);
        const updated: Relation = {
          ...rel,
          value:     newValue,
          stage:     newStage,
          sentiment: stageToSentiment(newStage),
          // updatedAt は意図的に更新しない（decayは時計をリセットしない）
        };
        fs.writeFileSync(filePath, JSON.stringify(updated, null, 2));
      }
    }
    console.log('[RelationStore] decayAll done');
  }
}
