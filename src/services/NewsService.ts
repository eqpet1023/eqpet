import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { NewsItem, Agent } from '../types';

const client = new Anthropic({ apiKey: process.env.EQPET_API_KEY });

const NEWS_DIR = path.join(__dirname, '../../data/news');

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function newsFilePath(dateKey: string): string {
  return path.join(NEWS_DIR, `${dateKey}.json`);
}

function ensureDir(): void {
  if (!fs.existsSync(NEWS_DIR)) fs.mkdirSync(NEWS_DIR, { recursive: true });
}

export class NewsService {
  static async fetchLatestNews(): Promise<NewsItem[]> {
    ensureDir();
    const dateKey = todayKey();
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
            name:        'web_search',
            description: 'Search the web for recent news',
            input_schema: {
              type: 'object' as const,
              properties: {
                query: { type: 'string', description: 'Search query' },
              },
              required: ['query'],
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

      // Parse text response for JSON
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

      // Fallback news if parsing fails
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
    ensureDir();
    const dateKey = todayKey();
    const cachePath = newsFilePath(dateKey);
    if (!fs.existsSync(cachePath)) return [];
    return JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
  }
}
