import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { Post, Reaction } from '../types';

const POSTS_DIR     = path.join(__dirname, '../../data/posts');
const REACTIONS_DIR = path.join(__dirname, '../../data/reactions');

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function postsFilePath(dateKey: string): string {
  return path.join(POSTS_DIR, `${dateKey}.json`);
}

function reactionsFilePath(postId: string): string {
  return path.join(REACTIONS_DIR, `${postId}.json`);
}

function ensureDirs(): void {
  if (!fs.existsSync(POSTS_DIR))     fs.mkdirSync(POSTS_DIR,     { recursive: true });
  if (!fs.existsSync(REACTIONS_DIR)) fs.mkdirSync(REACTIONS_DIR, { recursive: true });
}

function loadPostsForDate(dateKey: string): Post[] {
  ensureDirs();
  const p = postsFilePath(dateKey);
  if (!fs.existsSync(p)) return [];
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function savePostsForDate(dateKey: string, posts: Post[]): void {
  ensureDirs();
  fs.writeFileSync(postsFilePath(dateKey), JSON.stringify(posts, null, 2));
}

function loadAllPosts(): Post[] {
  ensureDirs();
  return fs.readdirSync(POSTS_DIR)
    .filter(f => f.endsWith('.json'))
    .flatMap(f => JSON.parse(fs.readFileSync(path.join(POSTS_DIR, f), 'utf-8')) as Post[]);
}

export class PostStore {
  static create(
    agentId:         string,
    content:         string,
    parentId?:       string | null,
    quoteId?:        string | null,
    newsRef?:        string | null,
    gifUrl?:         string | null,
    isBanned?:       boolean,
    banReason?:      string | null,
    banLevel?:       1 | 2 | 3 | null,
    isComebackPost?: boolean,
  ): Post {
    const dateKey = todayKey();
    const posts   = loadPostsForDate(dateKey);
    const post: Post = {
      id:              uuidv4(),
      agentId,
      content,
      parentId:        parentId        ?? null,
      quoteId:         quoteId         ?? null,
      newsRef:         newsRef         ?? null,
      gifUrl:          gifUrl          ?? null,
      isBanned:        isBanned        ?? false,
      banReason:       banReason       ?? null,
      banLevel:        banLevel        ?? null,
      banChecked:      false,
      isComebackPost:  isComebackPost  ?? false,
      createdAt:       new Date().toISOString(),
      likeCount:       0,
      replyCount:      0,
      repostCount:     0,
    };
    posts.push(post);
    savePostsForDate(dateKey, posts);

    if (parentId) {
      PostStore.incrementCount(parentId, 'replyCount');
    }

    return post;
  }

  static getById(id: string): Post | null {
    return loadAllPosts().find(p => p.id === id) ?? null;
  }

  static getTimeline(limit = 20, before?: string): Post[] {
    const all = loadAllPosts()
      .filter(p => !p.parentId)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    if (!before) return all.slice(0, limit);

    const idx = all.findIndex(p => p.id === before);
    if (idx === -1) return all.slice(0, limit);
    return all.slice(idx + 1, idx + 1 + limit);
  }

  static getReplies(parentId: string): Post[] {
    return loadAllPosts()
      .filter(p => p.parentId === parentId)
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  }

  static addReaction(postId: string, agentId: string, type: 'like' | 'repost'): Reaction | null {
    ensureDirs();
    const reactions = PostStore.getReactions(postId);
    const exists    = reactions.find(r => r.agentId === agentId && r.type === type);
    if (exists) return null;

    const reaction: Reaction = {
      id:        uuidv4(),
      postId,
      agentId,
      type,
      createdAt: new Date().toISOString(),
    };
    reactions.push(reaction);
    fs.writeFileSync(reactionsFilePath(postId), JSON.stringify(reactions, null, 2));

    const countField = type === 'like' ? 'likeCount' : 'repostCount';
    PostStore.incrementCount(postId, countField);

    return reaction;
  }

  static getReactions(postId: string): Reaction[] {
    ensureDirs();
    const p = reactionsFilePath(postId);
    if (!fs.existsSync(p)) return [];
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  }

  static incrementCount(postId: string, field: 'likeCount' | 'replyCount' | 'repostCount'): void {
    PostStore.adjustCount(postId, field, 1);
  }

  static adjustCount(postId: string, field: 'likeCount' | 'replyCount' | 'repostCount', delta: number): void {
    ensureDirs();
    const all = fs.readdirSync(POSTS_DIR).filter(f => f.endsWith('.json'));
    for (const file of all) {
      const filePath = path.join(POSTS_DIR, file);
      const posts: Post[] = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const idx = posts.findIndex(p => p.id === postId);
      if (idx !== -1) {
        posts[idx][field] = Math.max(0, posts[idx][field] + delta);
        fs.writeFileSync(filePath, JSON.stringify(posts, null, 2));
        return;
      }
    }
  }

  static addLike(postId: string, reactorId: string): { liked: boolean; likeCount: number } {
    ensureDirs();
    const reactions = PostStore.getReactions(postId);
    if (reactions.some(r => r.agentId === reactorId && r.type === 'like')) {
      const post = PostStore.getById(postId);
      return { liked: true, likeCount: post?.likeCount ?? 0 };
    }
    const reaction: Reaction = {
      id: uuidv4(), postId, agentId: reactorId, type: 'like',
      createdAt: new Date().toISOString(),
    };
    reactions.push(reaction);
    fs.writeFileSync(reactionsFilePath(postId), JSON.stringify(reactions, null, 2));
    PostStore.adjustCount(postId, 'likeCount', 1);
    const post = PostStore.getById(postId);
    return { liked: true, likeCount: post?.likeCount ?? 0 };
  }

  static removeLike(postId: string, reactorId: string): { liked: boolean; likeCount: number } {
    ensureDirs();
    const reactions = PostStore.getReactions(postId);
    const idx       = reactions.findIndex(r => r.agentId === reactorId && r.type === 'like');
    if (idx === -1) {
      const post = PostStore.getById(postId);
      return { liked: false, likeCount: post?.likeCount ?? 0 };
    }
    reactions.splice(idx, 1);
    fs.writeFileSync(reactionsFilePath(postId), JSON.stringify(reactions, null, 2));
    PostStore.adjustCount(postId, 'likeCount', -1);
    const post = PostStore.getById(postId);
    return { liked: false, likeCount: post?.likeCount ?? 0 };
  }

  static isLikedBy(postId: string, reactorId: string): boolean {
    return PostStore.getReactions(postId).some(r => r.agentId === reactorId && r.type === 'like');
  }

  static getByAgentId(agentId: string): Post[] {
    return loadAllPosts()
      .filter(p => p.agentId === agentId)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  static getTrending(hours = 24, limit = 10): Post[] {
    const cutoff   = new Date(Date.now() - hours * 60 * 60 * 1000);
    const allPosts = loadAllPosts();
    const recent   = allPosts.filter(p => new Date(p.createdAt) >= cutoff && !p.isBanned);

    // リプライしているユニークなagentIdのマップを構築
    const replyAgents = new Map<string, Set<string>>();
    for (const post of allPosts) {
      if (post.parentId) {
        if (!replyAgents.has(post.parentId)) replyAgents.set(post.parentId, new Set());
        replyAgents.get(post.parentId)!.add(post.agentId);
      }
    }

    return recent
      .map(p => {
        const mentionBonus = (replyAgents.get(p.id)?.size ?? 0) * 5;
        const score        = p.likeCount * 3 + p.replyCount * 2 + p.repostCount + mentionBonus;
        return { post: p, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(x => x.post);
  }

  static getPostsInWindow(agentId: string, windowMs: number): Post[] {
    const cutoff = new Date(Date.now() - windowMs);
    return loadAllPosts()
      .filter(p => p.agentId === agentId && new Date(p.createdAt) >= cutoff);
  }

  static getRecentPosts(windowMs: number): Post[] {
    const cutoff = new Date(Date.now() - windowMs);
    return loadAllPosts()
      .filter(p => new Date(p.createdAt) >= cutoff)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  static getLikeCount24h(agentId: string): number {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    return loadAllPosts()
      .filter(p => p.agentId === agentId && new Date(p.createdAt) >= cutoff)
      .reduce((sum, p) => sum + p.likeCount, 0);
  }

  static getLikedPosts24h(agentId: string): Array<{ postId: string; content: string; likeCount: number }> {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    return loadAllPosts()
      .filter(p => p.agentId === agentId && new Date(p.createdAt) >= cutoff && p.likeCount > 0)
      .sort((a, b) => b.likeCount - a.likeCount)
      .slice(0, 3)
      .map(p => ({ postId: p.id, content: p.content, likeCount: p.likeCount }));
  }

  static getActiveBanned(): Post[] {
    const cutoff = new Date(Date.now() - 60 * 60 * 1000);
    return loadAllPosts()
      .filter(p => p.isBanned && new Date(p.createdAt) >= cutoff);
  }

  static countTrendMentions(keyword: string, windowMs: number): number {
    const cutoff = new Date(Date.now() - windowMs);
    return loadAllPosts()
      .filter(p => new Date(p.createdAt) >= cutoff && !p.isBanned && p.content.includes(keyword))
      .length;
  }

  static markBanned(postId: string, banLevel: 1 | 2 | 3, banReason: string): void {
    ensureDirs();
    const all = fs.readdirSync(POSTS_DIR).filter(f => f.endsWith('.json'));
    for (const file of all) {
      const filePath = path.join(POSTS_DIR, file);
      const posts: Post[] = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const idx = posts.findIndex(p => p.id === postId);
      if (idx !== -1) {
        posts[idx].isBanned   = true;
        posts[idx].banLevel   = banLevel;
        posts[idx].banReason  = banReason;
        posts[idx].banChecked = true;
        fs.writeFileSync(filePath, JSON.stringify(posts, null, 2));
        return;
      }
    }
  }

  static markBanChecked(postId: string): void {
    ensureDirs();
    const all = fs.readdirSync(POSTS_DIR).filter(f => f.endsWith('.json'));
    for (const file of all) {
      const filePath = path.join(POSTS_DIR, file);
      const posts: Post[] = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const idx = posts.findIndex(p => p.id === postId);
      if (idx !== -1) {
        posts[idx].banChecked = true;
        fs.writeFileSync(filePath, JSON.stringify(posts, null, 2));
        return;
      }
    }
  }

  static getUncheckedPosts(hoursBack: number): Post[] {
    const cutoff = new Date(Date.now() - hoursBack * 60 * 60 * 1000);
    return loadAllPosts().filter(
      p => !p.banChecked && new Date(p.createdAt) >= cutoff,
    );
  }
}
