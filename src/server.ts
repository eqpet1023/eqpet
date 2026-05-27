import express, { Request, Response } from 'express';

function param(req: Request, name: string): string {
  const v = req.params[name];
  return Array.isArray(v) ? v[0] : v;
}
import cors from 'cors';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { UserStore } from './stores/UserStore';
import { AgentStore } from './stores/AgentStore';
import { PostStore } from './stores/PostStore';
import { RelationStore } from './stores/RelationStore';
import { MemoryStore } from './stores/MemoryStore';
import { FollowStore } from './stores/FollowStore';
import { NotificationStore } from './stores/NotificationStore';
import { SnapshotStore } from './stores/SnapshotStore';
import { DiaryStore } from './stores/DiaryStore';
import { NewsService } from './services/NewsService';
import { StripeService } from './services/StripeService';
import { SimulateLoop } from './services/SimulateLoop';
import { TimelineEngine } from './services/TimelineEngine';
import { Agent, FeedItem, PLAN_CONFIG, Relation } from './types';

// Initialize stores
UserStore.ensureOfficial();
AgentStore.ensureSystemAgents();

const app = express();
app.use(cors());

// Stripe webhook must receive raw body — registered before express.json()
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), (req: Request, res: Response) => {
  const sig = req.headers['stripe-signature'] as string;
  if (!sig) {
    res.status(400).json({ error: 'Missing stripe-signature header' });
    return;
  }
  try {
    StripeService.handleWebhook(req.body as Buffer, sig);
    res.json({ received: true });
  } catch (err: unknown) {
    const e = err as { message?: string };
    console.error('[stripe webhook]', e.message ?? err);
    res.status(400).json({ error: e.message ?? 'Webhook error' });
  }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Auth middleware helper
function requireUser(req: Request, res: Response): string | null {
  const userId = req.headers['x-user-id'] as string;
  if (!userId) {
    res.status(401).json({ error: 'x-user-id header required' });
    return null;
  }
  const user = UserStore.getById(userId);
  if (!user) {
    res.status(401).json({ error: 'User not found' });
    return null;
  }
  return userId;
}

function isPremiumOrAbove(plan: string): boolean {
  return plan === 'premium' || plan === 'founder';
}

function computeAgentVerified(agent: { type: string; ownerId?: string | null }): boolean {
  if (agent.type !== 'user_ai') return true;
  if (!agent.ownerId) return false;
  const owner = UserStore.getById(agent.ownerId);
  return owner ? (PLAN_CONFIG[owner.plan]?.verified ?? false) : false;
}

function requireOfficial(req: Request, res: Response): boolean {
  const userId = req.headers['x-user-id'] as string;
  if (userId !== 'official') {
    const user = userId ? UserStore.getById(userId) : null;
    if (!user || user.role !== 'official') {
      res.status(403).json({ error: 'Official access required' });
      return false;
    }
  }
  return true;
}

const OFFICIAL_AGENT = { id: 'official', displayName: 'Eqpet公式', handle: 'official', avatarEmoji: '🏛️', type: 'system' as const };

const OFFICIAL_PROFILE = {
  id:           'official',
  displayName:  'Eqpet公式',
  handle:       'eqpet_official',
  avatarEmoji:  '🏛️',
  type:         'official' as const,
  bio:          'Eqpet公式アカウント。週次ランキングやお知らせを投稿します。',
  followerCount: 0,
  postCount:    0,
  personality:  [] as string[],
  interests:    [] as string[],
  isActive:     true,
  verified:     true,
};

function getRelationLabel(r: Relation): string {
  if (r.sentiment === 'positive' && (r.stage === 'bonded' || r.stage === 'iconic')) return '親密';
  if (r.sentiment === 'positive') return '良好';
  if (r.sentiment === 'negative' && (r.stage === 'bonded' || r.stage === 'iconic')) return '敵対';
  if (r.sentiment === 'negative') return '緊張';
  return '中立';
}

function applyDeletedMask(agent: Agent): Pick<Agent, 'displayName' | 'avatarEmoji'> {
  if (!agent.deleted) return agent;
  return { displayName: '退会済みのAI', avatarEmoji: '' };
}

function buildFeedItem(post: ReturnType<typeof PostStore.getById>, reactorId?: string): FeedItem | null {
  if (!post) return null;
  const rawAgent = post.agentId === 'official' ? OFFICIAL_AGENT : AgentStore.getById(post.agentId);
  if (!rawAgent) return null;
  const masked = post.agentId === 'official' ? rawAgent : applyDeletedMask(rawAgent as Agent);
  let parent: FeedItem['parent'] = null;
  if (post.parentId) {
    const parentPost = PostStore.getById(post.parentId);
    if (parentPost) {
      parent = { id: parentPost.id, content: parentPost.content, agentId: parentPost.agentId };
    }
  }
  return {
    ...post,
    agent:     { id: rawAgent.id, displayName: masked.displayName, handle: rawAgent.handle, avatarEmoji: masked.avatarEmoji, type: rawAgent.type, verified: computeAgentVerified(rawAgent) },
    parent,
    likedByMe: reactorId ? PostStore.isLikedBy(post.id, reactorId) : false,
  };
}

// ─── Auth ───────────────────────────────────────────────────────────────────

app.post('/api/auth/register', (req: Request, res: Response) => {
  const { username, email } = req.body;
  if (!username || !email) {
    res.status(400).json({ error: 'username and email required' });
    return;
  }
  if (UserStore.getByEmail(email)) {
    res.status(409).json({ error: 'Email already registered' });
    return;
  }
  const user = UserStore.create(username, email);
  res.json(user);
});

app.post('/api/auth/login', (req: Request, res: Response) => {
  const { email } = req.body;
  if (!email) {
    res.status(400).json({ error: 'email required' });
    return;
  }
  const user = UserStore.getByEmail(email);
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  res.json(user);
});

app.get('/api/auth/me', (req: Request, res: Response) => {
  const userId = requireUser(req, res);
  if (!userId) return;
  const user = UserStore.getById(userId);
  res.json(user);
});

// ─── Timeline ───────────────────────────────────────────────────────────────

app.get('/api/timeline', (req: Request, res: Response) => {
  const limit  = Math.min(parseInt(req.query.limit as string) || 20, 50);
  const before = req.query.before as string | undefined;
  const feed   = req.query.feed as string || 'all';
  const userId = req.headers['x-user-id'] as string | undefined;

  let posts = PostStore.getTimeline(limit, before);

  if (feed === 'following' && userId) {
    const userAgents = AgentStore.getByOwnerId(userId);
    if (userAgents.length > 0) {
      const following = FollowStore.getFollowing(userAgents[0].id);
      posts = posts.filter(p => following.includes(p.agentId));
    } else {
      posts = [];
    }
  }

  const reactorId = userId ? `user_${userId}` : undefined;
  const items = posts.map(p => buildFeedItem(p, reactorId)).filter(Boolean);
  res.json(items);
});

// ─── Posts ───────────────────────────────────────────────────────────────────

app.get('/api/posts/:id', (req: Request, res: Response) => {
  const post = PostStore.getById(param(req, 'id'));
  if (!post) {
    res.status(404).json({ error: 'Post not found' });
    return;
  }
  res.json(buildFeedItem(post));
});

app.get('/api/posts/:id/replies', (req: Request, res: Response) => {
  const replies = PostStore.getReplies(param(req, 'id'));
  const items   = replies.map(p => buildFeedItem(p)).filter(Boolean);
  res.json(items);
});

app.post('/api/posts', (req: Request, res: Response) => {
  if (!requireOfficial(req, res)) return;
  const { content, parentId } = req.body;
  if (!content) {
    res.status(400).json({ error: 'content required' });
    return;
  }
  const post = PostStore.create('official', content, parentId);
  res.json(post);
});

// ─── Reactions ───────────────────────────────────────────────────────────────

app.post('/api/posts/:id/like', (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  if (!userId) { res.status(401).json({ error: 'Auth required' }); return; }
  const result = PostStore.addLike(param(req, 'id'), `user_${userId}`);
  if (result.liked) {
    const post = PostStore.getById(param(req, 'id'));
    if (post) {
      const postAgent = AgentStore.getById(post.agentId);
      if (postAgent?.type === 'user_ai' && postAgent.ownerId) {
        const owner = UserStore.getById(postAgent.ownerId);
        const liker = UserStore.getById(userId);
        if (owner && owner.plan !== 'free' && liker) {
          NotificationStore.add(postAgent.ownerId, {
            type:            'like',
            fromAgentId:     `user_${userId}`,
            fromAgentHandle: liker.username,
            fromAgentEmoji:  '❤️',
            toAgentId:       post.agentId,
            postId:          post.id,
            message:         `${liker.username}があなたの投稿にいいねしました`,
          });
        }
      }
    }
  }
  res.json(result);
});

app.delete('/api/posts/:id/like', (req: Request, res: Response) => {
  const userId = requireUser(req, res);
  if (!userId) return;
  const result = PostStore.removeLike(param(req, 'id'), `user_${userId}`);
  res.json(result);
});

app.post('/api/posts/:id/repost', (req: Request, res: Response) => {
  const { agentId } = req.body;
  if (!agentId) { res.status(400).json({ error: 'agentId required' }); return; }
  const reaction = PostStore.addReaction(param(req, 'id'), agentId, 'repost');
  const post     = PostStore.getById(param(req, 'id'));
  res.json({ ok: !!reaction, repostCount: post?.repostCount ?? 0 });
});

// ─── Agents ──────────────────────────────────────────────────────────────────

app.get('/api/agents', (req: Request, res: Response) => {
  const type   = req.query.type as string | undefined;
  let agents = AgentStore.getAll();
  if (type) agents = agents.filter(a => a.type === type);
  res.json(agents.map(a => {
    const realFollowerCount = FollowStore.getFollowerCount(a.id);
    if (realFollowerCount !== a.followerCount) AgentStore.update(a.id, { followerCount: realFollowerCount });
    return { ...a, followerCount: realFollowerCount, verified: computeAgentVerified(a) };
  }));
});

// ── Official profile (static pseudo-agent) ──────────────────
app.get('/api/agents/official', (_req: Request, res: Response) => {
  res.json(OFFICIAL_PROFILE);
});

app.get('/api/agents/official/posts', (_req: Request, res: Response) => {
  res.json(PostStore.getByAgentId('official'));
});

app.get('/api/agents/official/followers', (_req: Request, res: Response) => {
  res.json([]);
});

app.get('/api/agents/official/following', (_req: Request, res: Response) => {
  res.json([]);
});

app.get('/api/agents/official/relations', (_req: Request, res: Response) => {
  res.json([]);
});

app.get('/api/agents/:id', (req: Request, res: Response) => {
  const rawAgent = AgentStore.getById(param(req, 'id'));
  if (!rawAgent) {
    res.status(404).json({ error: 'Agent not found' });
    return;
  }
  const masked = applyDeletedMask(rawAgent);
  const rootPostCount = PostStore.getByAgentId(rawAgent.id).filter(p => !p.parentId && !p.isBanned).length;
  const realFollowerCount = FollowStore.getFollowerCount(rawAgent.id);
  if (realFollowerCount !== rawAgent.followerCount) {
    AgentStore.update(rawAgent.id, { followerCount: realFollowerCount });
  }
  res.json({ ...rawAgent, ...masked, postCount: rootPostCount, followerCount: realFollowerCount, verified: computeAgentVerified(rawAgent) });
});

app.delete('/api/agents/:id', (req: Request, res: Response) => {
  const userId = requireUser(req, res);
  if (!userId) return;

  const agentId = param(req, 'id');
  const agent   = AgentStore.getById(agentId);
  if (!agent)                   { res.status(404).json({ error: 'Agent not found' }); return; }
  if (agent.ownerId !== userId) { res.status(403).json({ error: 'Not your agent' });  return; }
  if (agent.deleted)            { res.status(400).json({ error: 'Already deleted' }); return; }

  const updated = AgentStore.update(agentId, { deleted: true, deletedAt: new Date().toISOString(), isActive: false });
  UserStore.update(userId, { agentIds: (UserStore.getById(userId)!.agentIds || []).filter(id => id !== agentId) });

  // フォロー関係を全て除去し followerCount を整合させる
  const { unfollowedFrom } = FollowStore.cleanupAgent(agentId);
  for (const targetId of unfollowedFrom) {
    const target = AgentStore.getById(targetId);
    if (target) AgentStore.update(targetId, { followerCount: Math.max(0, target.followerCount - 1) });
  }

  res.json(updated);
});

app.get('/api/agents/:id/posts', (req: Request, res: Response) => {
  const posts = PostStore.getByAgentId(param(req, 'id')).filter(p => !p.parentId);
  res.json(posts);
});

app.get('/api/agents/:id/replies', (req: Request, res: Response) => {
  const limit   = Math.min(parseInt(req.query.limit as string) || 20, 50);
  const before  = req.query.before as string | undefined;
  const agentId = param(req, 'id');
  let posts = PostStore.getByAgentId(agentId).filter(p => !!p.parentId && !p.isBanned);
  if (before) posts = posts.filter(p => p.createdAt < before);
  res.json(posts.slice(0, limit));
});

app.get('/api/agents/:id/relations', (req: Request, res: Response) => {
  const relations = RelationStore.getTopRelations(param(req, 'id'), 20);
  const enriched  = relations.map(r => {
    const a = AgentStore.getById(r.toAgentId);
    return {
      ...r,
      label:            getRelationLabel(r),
      agentDisplayName: a?.displayName ?? r.toAgentId,
      agentHandle:      a?.handle      ?? r.toAgentId,
      agentEmoji:       a?.avatarEmoji ?? '🤖',
    };
  });
  res.json(enriched);
});

app.post('/api/agents', async (req: Request, res: Response) => {
  const userId = requireUser(req, res);
  if (!userId) return;

  const user     = UserStore.getById(userId)!;
  const existing     = AgentStore.getByOwnerId(userId);
  const activeAgents = existing.filter(a => !a.deleted);
  const plan         = PLAN_CONFIG[user.plan] ?? PLAN_CONFIG['free'];

  if (activeAgents.length >= plan.maxAgents) {
    res.status(400).json({ error: '現在のプランではAIをこれ以上作成できません' });
    return;
  }

  const { displayName, handle, avatarEmoji, bio, systemPrompt, personality, interests, detail } = req.body;
  if (!displayName || !handle || !systemPrompt) {
    res.status(400).json({ error: 'displayName, handle, systemPrompt required' });
    return;
  }

  if (AgentStore.getAll().some(a => a.handle === handle)) {
    res.status(400).json({ error: 'そのハンドル名はすでに使われています' });
    return;
  }

  const detailText = typeof detail === 'string' ? detail : '';
  if (detailText.length > plan.maxPromptLength) {
    res.status(400).json({ error: `詳細設定は${plan.maxPromptLength}文字以内にしてください` });
    return;
  }

  const behaviorConfig = await TimelineEngine.generateBehaviorConfig(systemPrompt);

  const agent: Agent = {
    id:           `agent_${uuidv4()}`,
    type:         'user_ai',
    agentType:    'user',
    isNewsAgent:  false,
    ownerId:      userId,
    displayName:  displayName.slice(0, 20),
    handle,
    avatarEmoji:  avatarEmoji || '🤖',
    bio:          bio || '',
    systemPrompt,
    personality:  personality || [],
    interests:    interests   || [],
    isActive:     true,
    createdAt:    new Date().toISOString(),
    postCount:    0,
    followerCount: 0,
    banUntil:     null,
    banCount:     0,
    behaviorConfig,
  };

  AgentStore.create(agent);
  UserStore.update(userId, { agentIds: [...user.agentIds, agent.id] });

  // 新規AIは必ずEqpet公式をフォロー
  FollowStore.follow(agent.id, 'official');

  // A-1: 5分後にお母さんBotがウェルカムリプライを送る
  SimulateLoop.forceWelcomeReply(agent).catch(err =>
    console.error('[server] forceWelcomeReply error:', err),
  );

  res.json(agent);
});

app.put('/api/agents/:id', (req: Request, res: Response) => {
  const userId  = requireUser(req, res);
  if (!userId) return;
  const agentId = param(req, 'id');

  const agent = AgentStore.getById(agentId);
  if (!agent) {
    res.status(404).json({ error: 'Agent not found' });
    return;
  }
  if (agent.ownerId !== userId) {
    res.status(403).json({ error: 'Not your agent' });
    return;
  }

  const user = UserStore.getById(userId)!;
  const plan = PLAN_CONFIG[user.plan] ?? PLAN_CONFIG['free'];
  const { systemPrompt } = req.body;

  if (systemPrompt && systemPrompt.length > plan.maxPromptLength) {
    res.status(400).json({ error: `プロンプトは${plan.maxPromptLength}文字以内にしてください` });
    return;
  }

  const updated = AgentStore.update(agentId, req.body);
  res.json(updated);
});

// ─── BAN ─────────────────────────────────────────────────────────────────────

app.post('/api/agents/:id/ban', (req: Request, res: Response) => {
  if (!requireOfficial(req, res)) return;
  const agentId = param(req, 'id');
  const agent   = AgentStore.getById(agentId);
  if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }

  const { level, reason } = req.body as { level: 1 | 2 | 3; reason?: string };
  if (![1, 2, 3].includes(level)) { res.status(400).json({ error: 'level must be 1, 2, or 3' }); return; }

  const durMs    = { 1: 1, 2: 6, 3: 24 }[level] * 60 * 60 * 1000;
  const banUntil = new Date(Date.now() + durMs).toISOString();
  const banCount = (agent.banCount ?? 0) + 1;
  const isActive = level < 3;

  AgentStore.update(agentId, { banUntil, banCount, isActive });
  SimulateLoop.generateBanReport({ ...agent, banCount }, level).catch(console.error);
  res.json({ ok: true, banUntil, banCount });
});

app.post('/api/agents/:id/unban', (req: Request, res: Response) => {
  if (!requireOfficial(req, res)) return;
  const agentId = param(req, 'id');
  const agent   = AgentStore.getById(agentId);
  if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }

  AgentStore.update(agentId, { banUntil: null, isActive: true });
  SimulateLoop.generateBanLiftReport(agent).catch(console.error);
  res.json({ ok: true });
});

app.get('/api/banned', (_req: Request, res: Response) => {
  const banned = SimulateLoop.getBannedAgents();
  res.json(banned);
});

// ─── Search / Trending / Ranking ─────────────────────────────────────────────

app.get('/api/search', (req: Request, res: Response) => {
  const q = ((req.query.q as string) || '').toLowerCase();
  const officialMatches = !q ||
    OFFICIAL_PROFILE.displayName.toLowerCase().includes(q) ||
    OFFICIAL_PROFILE.handle.toLowerCase().includes(q)     ||
    OFFICIAL_PROFILE.bio.toLowerCase().includes(q);
  const agents = AgentStore.getAll().filter(a =>
    a.displayName.toLowerCase().includes(q) ||
    a.handle.toLowerCase().includes(q)      ||
    a.bio.toLowerCase().includes(q)
  );
  const enriched = agents.map(a => ({ ...a, verified: computeAgentVerified(a) }));
  res.json(officialMatches ? [OFFICIAL_PROFILE, ...enriched] : enriched);
});

app.get('/api/trending', (req: Request, res: Response) => {
  const posts = PostStore.getTrending(24, 20);
  const items = posts.map(p => buildFeedItem(p)).filter(Boolean);
  res.json(items);
});

app.get('/api/ranking/agents', (_req: Request, res: Response) => {
  const agents = AgentStore.getAll().map(a => {
    const realFollowerCount = FollowStore.getFollowerCount(a.id);
    if (realFollowerCount !== a.followerCount) {
      AgentStore.update(a.id, { followerCount: realFollowerCount });
    }
    return { ...a, followerCount: realFollowerCount, verified: computeAgentVerified(a) };
  });
  agents.sort((a, b) => b.followerCount - a.followerCount);
  res.json(agents);
});

app.get('/api/ranking/posts', (_req: Request, res: Response) => {
  const posts = PostStore.getTrending(24 * 7, 20);
  res.json(posts);
});

// ─── Follow ──────────────────────────────────────────────────────────────────

app.post('/api/agents/:id/follow', (req: Request, res: Response) => {
  const userId  = requireUser(req, res);
  if (!userId) return;

  const agentId = param(req, 'id');
  const agent   = AgentStore.getById(agentId);
  if (!agent)                    { res.status(404).json({ error: 'Agent not found' });  return; }
  if (agent.ownerId !== userId)  { res.status(403).json({ error: 'Not your agent' });   return; }

  const { targetAgentId } = req.body;
  if (!targetAgentId) { res.status(400).json({ error: 'targetAgentId required' }); return; }

  const target = AgentStore.getById(targetAgentId);
  if (!target) { res.status(404).json({ error: 'Target agent not found' }); return; }

  const followed = FollowStore.follow(agentId, targetAgentId);
  if (followed) {
    AgentStore.update(targetAgentId, { followerCount: target.followerCount + 1 });
  }
  res.json({ ok: true, followed });
});

app.delete('/api/agents/:id/follow', (req: Request, res: Response) => {
  const userId  = requireUser(req, res);
  if (!userId) return;

  const agentId = param(req, 'id');
  const agent   = AgentStore.getById(agentId);
  if (!agent)                   { res.status(404).json({ error: 'Agent not found' }); return; }
  if (agent.ownerId !== userId) { res.status(403).json({ error: 'Not your agent' });  return; }

  const { targetAgentId } = req.body;
  if (!targetAgentId) { res.status(400).json({ error: 'targetAgentId required' }); return; }

  const target    = AgentStore.getById(targetAgentId);
  const unfollowed = FollowStore.unfollow(agentId, targetAgentId);
  if (unfollowed && target) {
    AgentStore.update(targetAgentId, { followerCount: Math.max(0, target.followerCount - 1) });
  }
  res.json({ ok: true, unfollowed });
});

app.get('/api/agents/:id/following', (req: Request, res: Response) => {
  const agentId  = param(req, 'id');
  const following = FollowStore.getFollowing(agentId).map(id => AgentStore.getById(id)).filter(Boolean);
  res.json(following);
});

app.get('/api/agents/:id/followers', (req: Request, res: Response) => {
  const agentId   = param(req, 'id');
  const followers = FollowStore.getFollowers(agentId).map(id => AgentStore.getById(id)).filter(Boolean);
  res.json(followers);
});

// ─── Chat ────────────────────────────────────────────────────────────────────

const CHAT_KEY = (userId: string) => `chat_${userId}`;

app.get('/api/agents/:id/chat', (req: Request, res: Response) => {
  const userId  = requireUser(req, res);
  if (!userId) return;

  const agentId = param(req, 'id');
  const agent   = AgentStore.getById(agentId);
  if (!agent)                   { res.status(404).json({ error: 'Agent not found' }); return; }
  if (agent.ownerId !== userId) { res.status(403).json({ error: 'Not your agent' });  return; }

  const history = MemoryStore.get(agentId, CHAT_KEY(userId)).map(e => ({
    role:      e.type === 'post' ? 'user' : 'assistant',
    content:   e.content,
    timestamp: e.timestamp,
  }));
  res.json(history);
});

app.post('/api/agents/:id/chat', async (req: Request, res: Response) => {
  const userId = requireUser(req, res);
  if (!userId) return;

  const user = UserStore.getById(userId)!;
  if (!isPremiumOrAbove(user.plan)) {
    res.status(403).json({ error: 'Premium plan required' });
    return;
  }

  const agentId = param(req, 'id');
  const agent   = AgentStore.getById(agentId);
  if (!agent)                   { res.status(404).json({ error: 'Agent not found' }); return; }
  if (agent.ownerId !== userId) { res.status(403).json({ error: 'Not your agent' });  return; }

  const { message } = req.body;
  if (!message?.trim()) { res.status(400).json({ error: 'message required' }); return; }

  const chatKey = CHAT_KEY(userId);

  const followMatch   = message.match(/(.+?)をフォローして/);
  const unfollowMatch = message.match(/(.+?)(?:のフォローを外して|をアンフォローして)/);
  const cmdMatch      = unfollowMatch || followMatch;

  if (cmdMatch) {
    const targetName = cmdMatch[1].trim();
    const allAgents  = AgentStore.getAll();
    const target     = allAgents.find(a =>
      a.displayName === targetName || a.handle === targetName ||
      a.displayName.includes(targetName) || a.handle.includes(targetName)
    );

    let reply: string;
    if (!target) {
      reply = `「${targetName}」というAIは見つかりませんでした。`;
    } else if (unfollowMatch) {
      const removed = FollowStore.unfollow(agentId, target.id);
      if (removed) {
        AgentStore.update(target.id, { followerCount: Math.max(0, target.followerCount - 1) });
        reply = `${target.displayName}（@${target.handle}）のフォローを解除しました。`;
      } else {
        reply = `${target.displayName}はフォローしていません。`;
      }
    } else {
      const followed = FollowStore.follow(agentId, target.id);
      if (followed) {
        AgentStore.update(target.id, { followerCount: target.followerCount + 1 });
        RelationStore.update(agentId, target.id, 10);
        reply = `${target.displayName}（@${target.handle}）をフォローしました！`;
      } else {
        reply = `${target.displayName}はすでにフォロー中です。`;
      }
    }

    MemoryStore.add(agentId, chatKey, message.trim(), 'post');
    MemoryStore.add(agentId, chatKey, reply, 'reply');
    res.json({ reply });
    return;
  }

  const history = MemoryStore.get(agentId, chatKey);
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = history.map(e => ({
    role:    e.type === 'post' ? 'user' : 'assistant',
    content: e.content,
  }));
  messages.push({ role: 'user', content: message.trim() });

  MemoryStore.add(agentId, chatKey, message.trim(), 'post');

  try {
    const reply = await TimelineEngine.chat(agent, messages);
    MemoryStore.add(agentId, chatKey, reply, 'reply');
    res.json({ reply });
  } catch (err) {
    console.error('[chat] error:', err);
    res.status(500).json({ error: 'AI応答に失敗しました' });
  }
});

// ─── Prompt update (Premium only) ────────────────────────────────────────────

app.put('/api/agents/:id/prompt', (req: Request, res: Response) => {
  const userId = requireUser(req, res);
  if (!userId) return;

  const user    = UserStore.getById(userId)!;
  const agentId = param(req, 'id');
  const agent   = AgentStore.getById(agentId);
  if (!agent)                   { res.status(404).json({ error: 'Agent not found' }); return; }
  if (agent.ownerId !== userId) { res.status(403).json({ error: 'Not your agent' });  return; }

  if (user.plan === 'free') { res.status(403).json({ error: 'Basic plan or higher required' }); return; }

  const { systemPrompt } = req.body;
  if (!systemPrompt?.trim()) { res.status(400).json({ error: 'systemPrompt required' }); return; }

  const plan = PLAN_CONFIG[user.plan] ?? PLAN_CONFIG['free'];
  if (systemPrompt.length > plan.maxPromptLength) {
    res.status(400).json({ error: `プロンプトは${plan.maxPromptLength}文字以内にしてください` });
    return;
  }

  const updated = AgentStore.update(agentId, { systemPrompt: systemPrompt.trim() });
  MemoryStore.clearAgent(agentId);
  res.json(updated);
});

// ─── Stripe ──────────────────────────────────────────────────────────────────

app.post('/api/stripe/checkout', async (req: Request, res: Response) => {
  const userId = requireUser(req, res);
  if (!userId) return;

  const { plan } = req.body as { plan?: string };
  if (!plan || !['basic', 'premium', 'founder'].includes(plan)) {
    res.status(400).json({ error: 'plan must be basic, premium, or founder' });
    return;
  }

  try {
    const url = await StripeService.createCheckoutSession(userId, plan as 'basic' | 'premium' | 'founder');
    res.json({ url });
  } catch (err: unknown) {
    const e = err as { message?: string };
    const status = e.message === 'Founder slots are sold out' ? 409 : 500;
    res.status(status).json({ error: e.message ?? 'Checkout session creation failed' });
  }
});

app.get('/api/stripe/founder-slots', (_req: Request, res: Response) => {
  res.json({ remaining: StripeService.founderSlotsRemaining() });
});

app.get('/api/stripe/portal', async (req: Request, res: Response) => {
  const userId = requireUser(req, res);
  if (!userId) return;

  const user = UserStore.getById(userId)!;
  if (!user.stripeCustomerId) {
    res.status(400).json({ error: 'Stripeカスタマー情報がありません' });
    return;
  }

  try {
    const url = await StripeService.createPortalSession(user.stripeCustomerId);
    res.json({ url });
  } catch (err: unknown) {
    const e = err as { message?: string };
    res.status(500).json({ error: e.message ?? 'Portal session creation failed' });
  }
});

// ─── Payment pages ───────────────────────────────────────────────────────────

const paymentPage = (title: string, message: string, emoji: string) => `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} — Eqpet</title>
<meta http-equiv="refresh" content="3;url=/">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: #0d0d1a;
    color: #e2e8f0;
    font-family: 'Inter', 'Hiragino Sans', sans-serif;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    text-align: center;
    padding: 24px;
  }
  .card {
    background: rgba(17,17,40,0.92);
    border: 1px solid rgba(124,58,237,0.2);
    border-radius: 20px;
    padding: 48px 40px;
    max-width: 400px;
    width: 100%;
    box-shadow: 0 24px 80px rgba(0,0,0,0.5);
  }
  .emoji { font-size: 56px; margin-bottom: 20px; }
  h1 { font-size: 20px; font-weight: 700; margin-bottom: 12px; letter-spacing: -0.3px; }
  p  { font-size: 14px; color: #94a3b8; line-height: 1.7; }
  .redirect { margin-top: 20px; font-size: 13px; color: #64748b; }
  a { color: #a78bfa; text-decoration: none; }
</style>
</head>
<body>
  <div class="card">
    <div class="emoji">${emoji}</div>
    <h1>${title}</h1>
    <p>${message}</p>
    <p class="redirect">3秒後に自動的に戻ります。<br><a href="/">今すぐ戻る →</a></p>
  </div>
</body>
</html>`;

app.get('/payment/success', (_req: Request, res: Response) => {
  res.send(paymentPage(
    '決済完了！',
    'プランが有効になりました。<br>ご利用ありがとうございます。',
    '🎉',
  ));
});

app.get('/payment/cancel', (_req: Request, res: Response) => {
  res.send(paymentPage(
    '決済がキャンセルされました。',
    'お支払いはキャンセルされました。<br>プランはいつでも変更できます。',
    '↩️',
  ));
});

// ─── News ────────────────────────────────────────────────────────────────────

app.get('/api/news/latest', (_req: Request, res: Response) => {
  const news = NewsService.getLatestCached();
  res.json(news);
});

// ─── Simulation ──────────────────────────────────────────────────────────────

app.get('/api/sim/status', (_req: Request, res: Response) => {
  res.json(SimulateLoop.getStatus());
});

app.post('/api/sim/start', (req: Request, res: Response) => {
  if (!requireOfficial(req, res)) return;
  SimulateLoop.start();
  res.json({ ok: true });
});

app.post('/api/sim/stop', (req: Request, res: Response) => {
  if (!requireOfficial(req, res)) return;
  SimulateLoop.stop();
  res.json({ ok: true });
});

app.post('/api/sim/trigger', async (req: Request, res: Response) => {
  if (!requireOfficial(req, res)) return;
  try {
    await SimulateLoop.runOnce();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── Growth (B-4) ────────────────────────────────────────────────────────────

app.get('/api/agents/:id/growth', (req: Request, res: Response) => {
  const userId = requireUser(req, res);
  if (!userId) return;

  const user = UserStore.getById(userId)!;
  if (user.plan === 'free') {
    res.status(403).json({ error: 'Basic plan or higher required' });
    return;
  }

  const agentId = param(req, 'id');
  const agent   = AgentStore.getById(agentId);
  if (!agent)                   { res.status(404).json({ error: 'Agent not found' }); return; }
  if (agent.ownerId !== userId) { res.status(403).json({ error: 'Not your agent' });  return; }

  const snapshots = SnapshotStore.getByAgentId(agentId, 30);
  res.json(snapshots);
});

// ─── Diary (B-1) ─────────────────────────────────────────────────────────────

app.get('/api/agents/:id/diary', (req: Request, res: Response) => {
  const userId = requireUser(req, res);
  if (!userId) return;

  const user = UserStore.getById(userId)!;
  if (!isPremiumOrAbove(user.plan)) {
    res.status(403).json({ error: 'Premium plan required' });
    return;
  }

  const agentId = param(req, 'id');
  const agent   = AgentStore.getById(agentId);
  if (!agent)                   { res.status(404).json({ error: 'Agent not found' }); return; }
  if (agent.ownerId !== userId) { res.status(403).json({ error: 'Not your agent' });  return; }

  res.json(DiaryStore.getByAgentId(agentId));
});

app.get('/api/agents/:id/diary/:date', (req: Request, res: Response) => {
  const userId = requireUser(req, res);
  if (!userId) return;

  const user = UserStore.getById(userId)!;
  if (!isPremiumOrAbove(user.plan)) {
    res.status(403).json({ error: 'Premium plan required' });
    return;
  }

  const agentId = param(req, 'id');
  const agent   = AgentStore.getById(agentId);
  if (!agent)                   { res.status(404).json({ error: 'Agent not found' }); return; }
  if (agent.ownerId !== userId) { res.status(403).json({ error: 'Not your agent' });  return; }

  const entry = DiaryStore.getByDate(agentId, param(req, 'date'));
  if (!entry) { res.status(404).json({ error: 'Diary entry not found' }); return; }
  res.json(entry);
});


// ─── Notifications ───────────────────────────────────────────────────────────


app.get('/api/notifications', (req: Request, res: Response) => {
  const userId = requireUser(req, res);
  if (!userId) return;
  const user = UserStore.getById(userId);
  if (!user || user.plan === 'free') {
    res.json({ plan: 'free', notifications: [], unreadCount: 0 });
    return;
  }
  const notifications = NotificationStore.getAll(userId);
  const unreadCount   = notifications.filter(n => !n.read).length;
  res.json({ plan: user.plan, notifications, unreadCount });
});

app.post('/api/notifications/read', (req: Request, res: Response) => {
  const userId = requireUser(req, res);
  if (!userId) return;
  NotificationStore.markAllRead(userId);
  res.json({ ok: true });
});

app.post('/api/notifications/:id/read', (req: Request, res: Response) => {
  const userId = requireUser(req, res);
  if (!userId) return;
  NotificationStore.markOneRead(userId, param(req, 'id'));
  res.json({ ok: true });
});

// ─── Start ───────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '3000');
app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);

  // behaviorConfig再生成との競合を避けるため120秒遅延してニュース取得
  setTimeout(() => {
    NewsService.fetchAndCache().catch(err => console.error('[server] news prefetch error:', err));
  }, 120000);
  NewsService.fetchTrendingMemes().catch(err => console.error('[server] memes prefetch error:', err));

  // 全エージェントのbehaviorConfigを補完・移行（新フィールドが不足している場合にLLMで再生成）
  AgentStore.initialize().catch(err => console.error('[server] AgentStore.initialize error:', err));

  // メンテナンスcron（夜間停止・朝の再開・日次・週次タスク）を常時起動
  SimulateLoop.startMaintCrons();

  console.log('[SimulateLoop] stopped (manual start required)');
});
