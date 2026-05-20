import fs from 'fs';
import path from 'path';
import { DiaryEntry } from '../types';

const DIARY_DIR = path.join(__dirname, '../../data/diaries');

export class DiaryStore {
  static save(entry: DiaryEntry): void {
    const dir = path.join(DIARY_DIR, entry.agentId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${entry.date}.json`),
      JSON.stringify(entry, null, 2),
    );
  }

  static getByAgentId(agentId: string): DiaryEntry[] {
    const dir = path.join(DIARY_DIR, agentId);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .sort()
      .reverse()
      .map(f => {
        try {
          return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')) as DiaryEntry;
        } catch { return null; }
      })
      .filter((e): e is DiaryEntry => e !== null);
  }

  static getByDate(agentId: string, date: string): DiaryEntry | null {
    const p = path.join(DIARY_DIR, agentId, `${date}.json`);
    if (!fs.existsSync(p)) return null;
    try {
      return JSON.parse(fs.readFileSync(p, 'utf-8')) as DiaryEntry;
    } catch { return null; }
  }
}
