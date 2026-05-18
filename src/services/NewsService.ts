import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { NewsItem, Agent } from '../types';

const client = new Anthropic({ apiKey: process.env.EQPET_API_KEY });

const NEWS_DIR   = path.join(__dirname, '../../data/news');
const TRENDS_DIR = path.join(__dirname, '../../data/trends');

const SEARCH_QUERIES = [
  'Twitter トレンド 日本 今日 2026',
  'SNS 話題 日本 今日 2026',
];

interface NewsApiResponse {
  status:   string;
  articles: Array<{ title: string; description: string | null; url: string }>;
}

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

function parseWords(text: string): string[] {
  return text
    .split(/[\n,、・\d+\.\s]+/)
    .map(w => w.replace(/^[#「」『』【】\s]+|[#「」』】\s]+$/g, '').trim())
    .filter(w => w.length >= 2 && w.length <= 30);
}

async function fetchTrendWords(query: string): Promise<string[]> {
  try {
    const response = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 500,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }] as Parameters<typeof client.messages.create>[0]['tools'],
      messages: [{
        role:    'user',
        content: `「${query}」を検索して、今日の日本のSNSトレンドワードを最大10個、改行区切りで列挙してください。ワードのみ返してください。`,
      }],
    });

    const words: string[] = [];
    for (const block of response.content) {
      if (block.type === 'text') {
        words.push(...parseWords(block.text));
      }
    }
    console.log(`[NewsService] "${query}" → ${words.length} words`);
    return words;
  } catch (err: unknown) {
    const e = err as { message?: string; status?: number };
    console.error(`[NewsService] fetchTrendWords error — status: ${e.status}, message: ${e.message}`);
    return [];
  }
}

export class NewsService {
  static async fetchAndCache(): Promise<NewsItem[]> {
    return NewsService.fetchLatestNews();
  }

  static async fetchLatestNews(): Promise<NewsItem[]> {
    ensureNewsDir();
    const dateKey   = todayKey();
    const cachePath = newsFilePath(dateKey);

    if (fs.existsSync(cachePath)) {
      const cached = JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as NewsItem[];
      if (cached.length > 0) return cached;
    }

    try {
      const allWords: string[] = [];
      for (const query of SEARCH_QUERIES) {
        const words = await fetchTrendWords(query);
        allWords.push(...words);
      }

      // 重複除去
      const seen   = new Set<string>();
      const unique = allWords.filter(w => {
        if (seen.has(w)) return false;
        seen.add(w);
        return true;
      });

      const fetchedAt = new Date().toISOString();
      const news: NewsItem[] = unique.map(word => ({
        title:     word,
        url:       '',
        summary:   `SNSで話題：${word}`,
        category:  'trend',
        fetchedAt,
      }));

      if (news.length > 0) {
        fs.writeFileSync(cachePath, JSON.stringify(news, null, 2));
        console.log(`[NewsService] cached ${news.length} trend items`);
        return news;
      }

      console.warn('[NewsService] no trend words found');
      fs.writeFileSync(cachePath, JSON.stringify([], null, 2));
      return [];

    } catch (err: unknown) {
      const e = err as { message?: string };
      console.error('[NewsService] fetchLatestNews error —', e.message ?? err);
      return [];
    }
  }

  static async fetchTrendingMemes(): Promise<string[]> {
    return NewsService.getCachedMemes();
  }

  static getCachedMemes(): string[] {
    ensureTrendsDir();
    const memesPath = path.join(TRENDS_DIR, 'memes.json');
    if (!fs.existsSync(memesPath)) return FALLBACK_MEMES;
    try {
      const data = JSON.parse(fs.readFileSync(memesPath, 'utf-8')) as { memes: string[] };
      return data.memes;
    } catch {
      return FALLBACK_MEMES;
    }
  }

  static distributeToAgents(news: NewsItem[], agents: Agent[]): Map<string, NewsItem[]> {
    const result = new Map<string, NewsItem[]>();
    for (const agent of agents) {
      const matched = news.filter(item => {
        const text = `${item.title} ${item.summary}`.toLowerCase();
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
    const dateKey   = todayKey();
    const cachePath = newsFilePath(dateKey);
    if (!fs.existsSync(cachePath)) return [];
    try {
      return JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as NewsItem[];
    } catch {
      return [];
    }
  }
}

const FALLBACK_MEMES = ['草', '神回', 'それな', 'エモい', '優勝', '尊い', '闇が深い', 'わかりみ', 'ガチ', '888'];
