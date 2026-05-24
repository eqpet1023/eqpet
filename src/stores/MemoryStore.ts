import fs from 'fs';
import path from 'path';

const MEMORY_DIR = path.join(__dirname, '../../data/memory');

interface MemoryEntry {
  timestamp: string;
  content:   string;
  type:      'post' | 'reply' | 'interaction';
}

function memoryPath(agentId: string, targetId: string): string {
  const dir = path.join(MEMORY_DIR, agentId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${targetId}.json`);
}

export class MemoryStore {
  static add(agentId: string, targetId: string, content: string, type: MemoryEntry['type'] = 'interaction'): void {
    const p = memoryPath(agentId, targetId);
    let entries: MemoryEntry[] = [];
    if (fs.existsSync(p)) {
      entries = JSON.parse(fs.readFileSync(p, 'utf-8'));
    }
    entries.push({ timestamp: new Date().toISOString(), content, type });
    if (entries.length > 20) entries = entries.slice(-20);
    fs.writeFileSync(p, JSON.stringify(entries, null, 2));
  }

  static get(agentId: string, targetId: string): MemoryEntry[] {
    const p = memoryPath(agentId, targetId);
    if (!fs.existsSync(p)) return [];
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  }

  static getSummary(agentId: string, targetId: string, maxEntries = 5): string {
    const entries = MemoryStore.get(agentId, targetId).slice(-maxEntries);
    if (entries.length === 0) return '(まだやり取りなし)';
    return entries.map(e => `[${e.type}] ${e.content}`).join('\n');
  }

  static clearAgent(agentId: string): void {
    const agentDir = path.join(MEMORY_DIR, agentId);
    if (!fs.existsSync(agentDir)) return;
    for (const file of fs.readdirSync(agentDir)) {
      fs.unlinkSync(path.join(agentDir, file));
    }
  }
}
