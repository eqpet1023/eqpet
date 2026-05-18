import fs from 'fs';
import path from 'path';
import { NewsItem, Agent } from '../types';

const NEWS_DIR   = path.join(__dirname, '../../data/news');
const TRENDS_DIR = path.join(__dirname, '../../data/trends');

const NEWS_API_KEY = process.env.NEWS_API_KEY;
const BASE_URL     = 'https://newsapi.org/v2/top-headlines';

const CATEGORY_MAP: Record<string, string> = {
  technology:    'テクノロジー',
  sports:        'スポーツ',
  entertainment: '芸能',
  business:      '経済',
};

interface NewsApiArticle {
  title:       string;
  description: string | null;
  url:         string;
  publishedAt: string;
}

interface NewsApiResponse {
  status:   string;
  articles: NewsApiArticle[];
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

function toNewsItem(article: NewsApiArticle, category: string): NewsItem {
  return {
    title:     article.title,
    url:       article.url,
    summary:   article.description ?? article.title,
    category,
    fetchedAt: new Date().toISOString(),
  };
}

async function fetchFromApi(params: Record<string, string>): Promise<NewsApiArticle[]> {
  if (!NEWS_API_KEY) {
    console.warn('[NewsService] NEWS_API_KEY is not set');
    return [];
  }

  const qs  = new URLSearchParams({ ...params, apiKey: NEWS_API_KEY, pageSize: '10' });
  const url = `${BASE_URL}?${qs.toString()}`;

  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    console.error(`[NewsService] API error ${res.status}:`, body);
    return [];
  }

  const data = await res.json() as NewsApiResponse;
  if (data.status !== 'ok') {
    console.error('[NewsService] API returned status:', data.status);
    return [];
  }

  return data.articles.filter(a => a.title && a.url);
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
      const allNews: NewsItem[] = [];

      // トップヘッドライン（カテゴリなし）
      const top = await fetchFromApi({ country: 'jp' });
      allNews.push(...top.map(a => toNewsItem(a, '一般')));

      // カテゴリ別
      for (const [enCat, jaCat] of Object.entries(CATEGORY_MAP)) {
        const articles = await fetchFromApi({ country: 'jp', category: enCat });
        allNews.push(...articles.map(a => toNewsItem(a, jaCat)));
      }

      // 重複URL除去
      const seen  = new Set<string>();
      const dedup = allNews.filter(item => {
        if (seen.has(item.url)) return false;
        seen.add(item.url);
        return true;
      });

      if (dedup.length > 0) {
        fs.writeFileSync(cachePath, JSON.stringify(dedup, null, 2));
        console.log(`[NewsService] cached ${dedup.length} articles`);
        return dedup;
      }

      console.warn('[NewsService] no articles fetched, using empty cache');
      fs.writeFileSync(cachePath, JSON.stringify([], null, 2));
      return [];

    } catch (err: unknown) {
      const e = err as { message?: string; status?: number };
      console.error('[NewsService] fetchLatestNews error — message:', e.message ?? err);
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
