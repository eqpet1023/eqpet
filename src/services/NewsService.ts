import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { NewsItem, Agent } from '../types';

const client = new Anthropic({ apiKey: process.env.EQPET_API_KEY });

const NEWS_DIR   = path.join(__dirname, '../../data/news');
const TRENDS_DIR = path.join(__dirname, '../../data/trends');

// 現実世界のニュース・時事ネタを取得するクエリ
// ハウツー・まとめ・SEO記事を拾わないよう「ニュース」「速報」「出来事」に特化
const NEWS_QUERIES = [
  '日本 最新ニュース 今日 速報',
  '日本 今日 話題 出来事 ニュース',
];

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

// web_search でニュースを取得し、構造化された NewsItem[] を返す
async function fetchNewsItems(query: string): Promise<NewsItem[]> {
  try {
    const response = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 1200,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }] as Parameters<typeof client.messages.create>[0]['tools'],
      messages: [{
        role:    'user',
        content: `「${query}」を検索して、今日の日本の時事ニュース・実際に起きた出来事を最大8件取得してください。

条件（厳守）:
- 実際のニュース・出来事のみ（ハウツー記事・まとめサイト・SEO記事・ランキング記事は除外）
- 政治・経済・社会・スポーツ・テクノロジー・芸能・国際など報道価値のある出来事
- タイトルは「〇〇が△△を発表」「〇〇で△△が起きる」のような見出し形式（40文字以内）
- summaryは事実のみ1〜2文

JSON形式のみで返してください（説明文・前置き不要）：
[
  {"title": "見出し形式のタイトル", "summary": "事実の概要1〜2文", "category": "政治|経済|社会|テクノロジー|スポーツ|芸能|国際|その他"},
  ...
]`,
      }],
    });

    const text = response.content
      .filter(b => b.type === 'text')
      .map(b => (b as { text: string }).text)
      .join('');

    const match = text.match(/\[[\s\S]*\]/);
    if (!match) {
      console.warn(`[NewsService] fetchNewsItems: no JSON found for "${query}"`);
      return [];
    }

    const items = JSON.parse(match[0]) as Array<{ title?: string; summary?: string; category?: string }>;
    const fetchedAt = new Date().toISOString();
    const result = items
      .filter(i => i.title && i.summary)
      .map(i => ({
        title:     (i.title    ?? '').slice(0, 60).trim(),
        url:       '',
        summary:   (i.summary  ?? '').slice(0, 150).trim(),
        category:  (i.category ?? 'その他').trim(),
        fetchedAt,
      }));

    console.log(`[NewsService] "${query}" → ${result.length} news items`);
    return result;
  } catch (err: unknown) {
    const e = err as { message?: string; status?: number };
    console.error(`[NewsService] fetchNewsItems error — status: ${e.status}, message: ${e.message}`);
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
      const allItems: NewsItem[] = [];
      for (const query of NEWS_QUERIES) {
        const items = await fetchNewsItems(query);
        allItems.push(...items);
      }

      // 重複除去（タイトルで判定）
      const seen   = new Set<string>();
      const unique = allItems.filter(item => {
        if (seen.has(item.title)) return false;
        seen.add(item.title);
        return true;
      });

      if (unique.length > 0) {
        fs.writeFileSync(cachePath, JSON.stringify(unique, null, 2));
        console.log(`[NewsService] cached ${unique.length} news items`);
        return unique;
      }

      console.warn('[NewsService] no news items found');
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

  // eqpet_news がトレンドデータを直接受け取るためのエントリポイント
  static getTrendCache(): NewsItem[] {
    return NewsService.getLatestCached();
  }
}

const FALLBACK_MEMES = ['草', '神回', 'それな', 'エモい', '優勝', '尊い', '闇が深い', 'わかりみ', 'ガチ', '888'];
