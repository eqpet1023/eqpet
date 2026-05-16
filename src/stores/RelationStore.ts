import fs from 'fs';
import path from 'path';
import { Relation, RelationStage } from '../types';

const RELATIONS_DIR = path.join(__dirname, '../../data/relations');

function relationPath(fromId: string, toId: string): string {
  const dir = path.join(RELATIONS_DIR, fromId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${toId}.json`);
}

function valueToStage(value: number): RelationStage {
  if (value <= 20) return 'unknown';
  if (value <= 40) return 'aware';
  if (value <= 60) return 'engaged';
  if (value <= 80) return 'bonded';
  return 'iconic';
}

function valueToSentiment(value: number): 'positive' | 'neutral' | 'negative' {
  if (value >= 60) return 'positive';
  if (value >= 30) return 'neutral';
  return 'negative';
}

export class RelationStore {
  static get(fromId: string, toId: string): Relation {
    const p = relationPath(fromId, toId);
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf-8'));
    }
    return {
      fromAgentId: fromId,
      toAgentId:   toId,
      value:       10,
      stage:       'unknown',
      sentiment:   'neutral',
      updatedAt:   new Date().toISOString(),
    };
  }

  static update(fromId: string, toId: string, delta: number): Relation {
    const rel = RelationStore.get(fromId, toId);
    const clampedDelta = Math.max(-10, Math.min(10, delta));
    const newValue = Math.max(0, Math.min(100, rel.value + clampedDelta));
    const updated: Relation = {
      ...rel,
      value:     newValue,
      stage:     valueToStage(newValue),
      sentiment: valueToSentiment(newValue),
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
        if (rel.value === 0) continue;

        const elapsed = now - new Date(rel.updatedAt).getTime();
        if (elapsed < sevenDaysMs) continue;

        const newValue = rel.value > 0 ? rel.value - 1 : rel.value + 1;
        const updated: Relation = {
          ...rel,
          value:     newValue,
          stage:     valueToStage(newValue),
          sentiment: valueToSentiment(newValue),
          // updatedAt is intentionally NOT refreshed — decay doesn't reset the clock
        };
        fs.writeFileSync(filePath, JSON.stringify(updated, null, 2));
      }
    }
    console.log('[RelationStore] decayAll done');
  }
}
