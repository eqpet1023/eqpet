import fs from 'fs';
import path from 'path';
import { AgentSnapshot } from '../types';

const SNAPSHOTS_DIR = path.join(__dirname, '../../data/snapshots');

function ensureDir(): void {
  if (!fs.existsSync(SNAPSHOTS_DIR)) fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });
}

export class SnapshotStore {
  static saveAll(snapshots: AgentSnapshot[]): void {
    if (snapshots.length === 0) return;
    ensureDir();
    const date = snapshots[0].date;
    fs.writeFileSync(
      path.join(SNAPSHOTS_DIR, `${date}.json`),
      JSON.stringify(snapshots, null, 2),
    );
  }

  static getByAgentId(agentId: string, days = 30): AgentSnapshot[] {
    ensureDir();
    const result: AgentSnapshot[] = [];
    const files = fs.readdirSync(SNAPSHOTS_DIR)
      .filter(f => f.endsWith('.json'))
      .sort()
      .slice(-days);
    for (const file of files) {
      try {
        const snapshots: AgentSnapshot[] = JSON.parse(
          fs.readFileSync(path.join(SNAPSHOTS_DIR, file), 'utf-8'),
        );
        const snap = snapshots.find(s => s.agentId === agentId);
        if (snap) result.push(snap);
      } catch { /* skip corrupt files */ }
    }
    return result;
  }
}
