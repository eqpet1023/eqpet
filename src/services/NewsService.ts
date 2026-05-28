import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { NewsItem, Agent } from '../types';

const client = new Anthropic({ apiKey: process.env.EQPET_API_KEY });

const NEWS_DIR   = path.join(__dirname, '../../data/news');
const TRENDS_DIR = path.join(__dirname, '../../data/trends');

// 現実世界のニュース・時事ネタを取得するクエリ（日本語限定）
// エンタメ・趣味系を多めにしてAIたちが乗りやすい話題を供給する
const NEWS_QUERIES = [
  '日本 話題 ニュース 今日',
  '新作アニメ 話題 今季',
  '音楽 新曲 リリース 今週 日本',
  'ゲーム 新作 話題 今週',
  'スポーツ 試合結果 話題 今日 日本',
  '芸能 エンタメ 話題 今週 日本',
];

// ASCII・ひらがな・カタカナ・CJK統合漢字・半角全角のみ許可。それ以外の文字（ハングル等）を含む場合は除外
function isJapanese(text: string): boolean {
  return !/[^\u0000-\u007F\u3000-\u30FF\u4E00-\u9FFF\u3400-\u4DBF\uFF00-\uFFEF]/.test(text);
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

const FETCHED_QUERIES_FILE = path.join(NEWS_DIR, 'fetched_queries.json');

interface FetchedQueriesStore { date: string; queries: string[] }

function loadFetchedQueries(): Set<string> {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const raw = JSON.parse(fs.readFileSync(FETCHED_QUERIES_FILE, 'utf-8')) as FetchedQueriesStore;
    if (raw.date === today) return new Set(raw.queries);
  } catch { /* file missing or corrupt — treat as empty */ }
  return new Set();
}

function saveFetchedQuery(query: string): void {
  const today = new Date().toISOString().slice(0, 10);
  let store: FetchedQueriesStore;
  try {
    const raw = JSON.parse(fs.readFileSync(FETCHED_QUERIES_FILE, 'utf-8')) as FetchedQueriesStore;
    store = raw.date === today ? raw : { date: today, queries: [] };
  } catch {
    store = { date: today, queries: [] };
  }
  if (!store.queries.includes(query)) {
    store.queries.push(query);
    ensureNewsDir();
    fs.writeFileSync(FETCHED_QUERIES_FILE, JSON.stringify(store), 'utf-8');
  }
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
- 必ず日本語のみで出力すること。英語・中国語・韓国語などの外国語を含めないこと
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
      console.warn(`[NewsService] fetchNewsItems: no JSON found for "${query}" — received: ${text.slice(0, 300)}`);
      return [];
    }

    let items: Array<{ title?: string; summary?: string; category?: string }>;
    try {
      items = JSON.parse(match[0]);
    } catch (parseErr) {
      console.warn(`[NewsService] fetchNewsItems: JSON parse failed — ${(parseErr as Error).message} — raw: ${match[0].slice(0, 300)}`);
      return [];
    }
    const fetchedAt = new Date().toISOString();
    const result = items
      .filter(i => i.title && i.summary)
      .map(i => ({
        title:     (i.title    ?? '').slice(0, 60).trim(),
        url:       '',
        summary:   (i.summary  ?? '').slice(0, 150).trim(),
        category:  (i.category ?? 'その他').trim(),
        fetchedAt,
      }))
      .filter(i => isJapanese(i.title) && isJapanese(i.summary));

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
      const clean  = cached.filter(i => isJapanese(i.title) && isJapanese(i.summary));
      if (clean.length > 0) return clean;
      // 全件が非日本語だった場合は再取得
      if (cached.length > 0) console.warn('[NewsService] cache had non-Japanese items — re-fetching');
    }

    try {
      const fetchedQueries = loadFetchedQueries();
      const allItems: NewsItem[] = [];
      for (const query of NEWS_QUERIES) {
        if (fetchedQueries.has(query)) {
          console.log(`[NewsService] "${query}" already fetched today — skipped`);
          continue;
        }
        const items = await fetchNewsItems(query);
        saveFetchedQuery(query);
        allItems.push(...items);

        // キャッシュに追記（途中再起動でも取得済み分が消えない）
        const existingCached = fs.existsSync(cachePath)
          ? (JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as NewsItem[])
          : [];
        const mergedSeen = new Set<string>(existingCached.map(i => i.title));
        const newItems   = items.filter(i => !mergedSeen.has(i.title));
        if (newItems.length > 0) {
          const merged = [...existingCached, ...newItems];
          fs.writeFileSync(cachePath, JSON.stringify(merged, null, 2));
        }

        await new Promise(resolve => setTimeout(resolve, 15000));
      }

      if (fs.existsSync(cachePath)) {
        const finalCached = JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as NewsItem[];
        const clean = finalCached.filter(i => isJapanese(i.title) && isJapanese(i.summary));
        if (clean.length > 0) {
          console.log(`[NewsService] total cached ${clean.length} news items`);
          return clean;
        }
      }

      // 新規取得分のみで重複除去
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
      if (!fs.existsSync(cachePath)) fs.writeFileSync(cachePath, JSON.stringify([], null, 2));
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
    if (!fs.existsSync(cachePath)) {
      console.warn(`[NewsService] cache file not found for ${dateKey} — news not fetched yet today`);
      return [];
    }
    try {
      const items = JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as NewsItem[];
      if (items.length === 0) console.warn(`[NewsService] cache is empty for ${dateKey}`);
      return items;
    } catch (e) {
      console.warn(`[NewsService] cache read error for ${dateKey}:`, (e as Error).message);
      return [];
    }
  }

  // eqpet_news がトレンドデータを直接受け取るためのエントリポイント
  static getTrendCache(): NewsItem[] {
    const items = NewsService.getLatestCached();
    if (items.length === 0) console.warn('[NewsService] getTrendCache: returning empty — eqpet_news will have no trend data');
    return items;
  }
}

const FALLBACK_MEMES = ['草', '神回', 'それな', 'エモい', '優勝', '尊い', '闇が深い', 'わかりみ', 'ガチ', '888'];
