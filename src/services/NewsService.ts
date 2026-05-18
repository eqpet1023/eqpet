import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { NewsItem, Agent } from '../types';

const client = new Anthropic({ apiKey: process.env.EQPET_API_KEY });

const NEWS_DIR   = path.join(__dirname, '../../data/news');
const TRENDS_DIR = path.join(__dirname, '../../data/trends');

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function newsFilePath(dateKey: string): string {
  return path.join(NEWS_DIR, `${dateKey}.json`);
}

function ensureNewsDir(): void {
  if (!fs.existsSync(NEWS_DIR)) fs.mkdirSync(NEWS_DIR, { recursive: true });
}

function ensureTrendsDir(): void {
  if (!fs.existsSync(TRENDS_DIR)) fs.mkdirSync(TRENDS_DIR, { recursive: true });
}

export class NewsService {
  static async fetchAndCache(): Promise<NewsItem[]> {
    return NewsService.fetchLatestNews();
  }

  static async fetchLatestNews(): Promise<NewsItem[]> {
    ensureNewsDir();
    const dateKey  = todayKey();
    const cachePath = newsFilePath(dateKey);

    if (fs.existsSync(cachePath)) {
      const cached = JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as NewsItem[];
      if (cached.length > 0) return cached;
    }

    try {
      const response = await client.messages.create({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 1000,
        tools: [
          {
            name:         'web_search',
            description:  'Search the web for recent news',
            input_schema: {
              type:       'object' as const,
              properties: { query: { type: 'string', description: 'Search query' } },
              required:   ['query'],
            },
          },
        ],
        messages: [
          {
            role:    'user',
            content: '今日の日本の主要ニュースを3件、JSON配列形式で教えてください。各ニュースには title, url, summary, category フィールドを含めてください。JSONのみ返してください。',
          },
        ],
      });

      for (const block of response.content) {
        if (block.type === 'text') {
          const match = block.text.match(/\[[\s\S]*\]/);
          if (match) {
            try {
              const items = JSON.parse(match[0]) as Omit<NewsItem, 'fetchedAt'>[];
              const news: NewsItem[] = items.map(item => ({
                ...item,
                fetchedAt: new Date().toISOString(),
              }));
              fs.writeFileSync(cachePath, JSON.stringify(news, null, 2));
              return news;
            } catch {
              // fall through to fallback
            }
          }
        }
      }

      const fallback: NewsItem[] = [
        {
          title:     '本日のニュース',
          url:       'https://example.com',
          summary:   'ニュースの取得に失敗しました。',
          category:  '一般',
          fetchedAt: new Date().toISOString(),
        },
      ];
      fs.writeFileSync(cachePath, JSON.stringify(fallback, null, 2));
      return fallback;

    } catch (err) {
      console.error('[NewsService] fetchLatestNews error:', err);
      return [];
    }
  }

  static async fetchTrendingMemes(): Promise<string[]> {
    ensureTrendsDir();
    const memesPath = path.join(TRENDS_DIR, 'memes.json');

    if (fs.existsSync(memesPath)) {
      const data = JSON.parse(fs.readFileSync(memesPath, 'utf-8')) as { memes: string[]; fetchedAt: string };
      const ageMs = Date.now() - new Date(data.fetchedAt).getTime();
      if (ageMs < 24 * 60 * 60 * 1000) return data.memes;
    }

    try {
      const response = await client.messages.create({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 500,
        messages: [
          {
            role:    'user',
            content: `今週日本のTwitter・ネットで流行っているスラング・ミーム・流行語を10件、JSON配列（文字列のリスト）で返してください。JSONのみ返してください。例：["草","神回","それな","エモい","優勝"]`,
          },
        ],
      });

      for (const block of response.content) {
        if (block.type === 'text') {
          const match = block.text.match(/\[[\s\S]*?\]/);
          if (match) {
            try {
              const memes = JSON.parse(match[0]) as string[];
              fs.writeFileSync(memesPath, JSON.stringify({ memes, fetchedAt: new Date().toISOString() }, null, 2));
              return memes;
            } catch {
              // fall through to fallback
            }
          }
        }
      }
    } catch (err) {
      console.error('[NewsService] fetchTrendingMemes error:', err);
    }

    const fallback = ['草', '神回', 'それな', 'エモい', '優勝', '尊い', '闇が深い', 'わかりみ', 'ガチ', '888'];
    if (!fs.existsSync(memesPath)) {
      fs.writeFileSync(memesPath, JSON.stringify({ memes: fallback, fetchedAt: new Date().toISOString() }, null, 2));
    }
    return fallback;
  }

  static getCachedMemes(): string[] {
    ensureTrendsDir();
    const memesPath = path.join(TRENDS_DIR, 'memes.json');
    if (!fs.existsSync(memesPath)) return [];
    try {
      const data = JSON.parse(fs.readFileSync(memesPath, 'utf-8')) as { memes: string[] };
      return data.memes;
    } catch {
      return [];
    }
  }

  static distributeToAgents(news: NewsItem[], agents: Agent[]): Map<string, NewsItem[]> {
    const result = new Map<string, NewsItem[]>();
    for (const agent of agents) {
      const matched = news.filter(item => {
        const text = `${item.title} ${item.summary} ${item.category}`.toLowerCase();
        return agent.interests.some(interest => text.includes(interest.toLowerCase()));
      });
      if (matched.length > 0) {
        result.set(agent.id, matched);
      }
    }
    return result;
  }

  static getLatestCached(): NewsItem[] {
    ensureNewsDir();
    const dateKey  = todayKey();
    const cachePath = newsFilePath(dateKey);
    if (!fs.existsSync(cachePath)) return [];
    return JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
  }
}
