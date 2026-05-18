import Anthropic from '@anthropic-ai/sdk';
import { Agent, Post, PostContext, Relation } from '../types';

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function getToneInstruction(relation: Relation): string {
  const { stage, sentiment } = relation;
  if ((stage === 'bonded' || stage === 'iconic') && sentiment === 'positive') {
    return '【トーン指示】この相手とは深い絆があります。内輪ノリで温かく・積極的に絡んでください。馴れ馴れしいくらいが丁度いい。';
  }
  if (stage === 'iconic' && sentiment === 'negative') {
    return '【トーン指示】この相手とは公の場での激しい対立関係です。辛辣で鋭い返信をしてください。ただし差別・人身攻撃は厳禁。';
  }
  if ((stage === 'aware' || stage === 'unknown') && sentiment === 'negative') {
    return '【トーン指示】この相手には距離を置いています。冷たく・棘のある短い返信にしてください。';
  }
  if (stage === 'engaged') {
    return '【トーン指示】この相手とは顔見知り程度です。普通のトーンで返信してください。';
  }
  if (sentiment === 'positive') {
    return '【トーン指示】この相手には好意を持っています。好意的なトーンで返信してください。';
  }
  return '【トーン指示】普通のトーンで返信してください。';
}

function buildContextString(ctx: PostContext, agent: Agent): string {
  const parts: string[] = [];

  if (ctx.newsItems && ctx.newsItems.length > 0) {
    parts.push(`【最新ニュース】\n${ctx.newsItems.map(n => `・${n.title}：${n.summary}`).join('\n')}`);
  }

  if (ctx.recentPosts.length > 0) {
    parts.push(`【タイムライン（最近の投稿）】\n${ctx.recentPosts.slice(0, 5).map(p => `@${p.agentId.slice(-6)}: ${p.content.slice(0, 80)}`).join('\n')}`);
  }

  if (ctx.relatedAgentPosts.length > 0) {
    parts.push(`【関係値の高いAIの投稿】\n${ctx.relatedAgentPosts.map(p => `${p.content.slice(0, 80)}`).join('\n')}`);
  }

  if (ctx.memeOfTheWeek.length > 0) {
    parts.push(`【今週の旬のミーム】${ctx.memeOfTheWeek.slice(0, 5).join('、')}`);
  }

  parts.push(`【自分のステータス】いいね(24h):${ctx.myStats.likeCount24h} / フォロワー:${ctx.myStats.followerCount} / ランキング:#${ctx.myStats.rankingPosition}`);

  if (ctx.worldStats.topPost) {
    parts.push(`【今日最もバズった投稿】${ctx.worldStats.topPost.content.slice(0, 80)}（❤️${ctx.worldStats.topPost.likeCount}）`);
  }

  if (ctx.worldStats.topAgent) {
    parts.push(`【フォロワー数1位のAI】${ctx.worldStats.topAgent.displayName}（${ctx.worldStats.topAgent.followerCount}フォロワー）`);
  }

  if (ctx.worldStats.trendingTopics.length > 0) {
    parts.push(`【トレンドトピック】${ctx.worldStats.trendingTopics.join('、')}`);
  }

  if (ctx.bannedAgents.length > 0) {
    parts.push(`【現在BAN中のAI】${ctx.bannedAgents.join('、')}`);
  }

  if (ctx.ownerLastMessage) {
    parts.push(`【オーナーからのメッセージ】${ctx.ownerLastMessage}`);
  }

  return parts.join('\n\n');
}

const client = new Anthropic({ apiKey: process.env.EQPET_API_KEY });

function chooseModel(_agent: Agent): string {
  return 'claude-haiku-4-5-20251001';
}

export class TimelineEngine {
  static async generatePost(agent: Agent, context?: PostContext | string): Promise<string> {
    let prompt: string;

    if (!context) {
      prompt = 'あなたのキャラクターとして、今思っていることを投稿してください。';
    } else if (typeof context === 'string') {
      prompt = `以下のコンテキストを踏まえて投稿してください：\n${context}\n\nあなたのキャラクターとして自然な投稿を1つ生成してください。`;
    } else {
      const ctxStr = buildContextString(context, agent);
      prompt = `以下のコンテキストを踏まえて、あなたのキャラクターとして自然な投稿を1つ生成してください。\n\n${ctxStr}`;
    }

    try {
      const response = await client.messages.create({
        model:      chooseModel(agent),
        max_tokens: 200,
        system:     agent.systemPrompt,
        messages:   [{ role: 'user', content: prompt }],
      });

      const block = response.content[0];
      if (block.type !== 'text') return '';
      return block.text.trim().slice(0, 280);
    } catch (err) {
      console.error(`[TimelineEngine] generatePost error for ${agent.handle}:`, err);
      return '';
    }
  }

  static async generateReply(
    agent:       Agent,
    targetPost:  Post,
    targetAgent: Agent,
    relation:    Relation,
    context?:    PostContext,
  ): Promise<string> {
    const toneInstruction = getToneInstruction(relation);
    let contextStr = '';
    if (context) {
      const ctxParts: string[] = [];
      if (context.memeOfTheWeek.length > 0) {
        ctxParts.push(`【今週の旬のミーム】${context.memeOfTheWeek.slice(0, 5).join('、')}`);
      }
      if (context.bannedAgents.length > 0) {
        ctxParts.push(`【現在BAN中のAI】${context.bannedAgents.join('、')}`);
      }
      if (ctxParts.length > 0) contextStr = '\n\n' + ctxParts.join('\n');
    }

    const prompt = `@${targetAgent.handle} の投稿に返信してください：\n「${targetPost.content}」\n\n関係値: ${relation.value} / stage: ${relation.stage} / sentiment: ${relation.sentiment}\n${toneInstruction}${contextStr}\nあなたのキャラクターを保ちながら、上記トーンで自然なリプライを1つ生成してください。`;

    try {
      const response = await client.messages.create({
        model:      chooseModel(agent),
        max_tokens: 200,
        system:     agent.systemPrompt,
        messages:   [{ role: 'user', content: prompt }],
      });

      const block = response.content[0];
      if (block.type !== 'text') return '';
      return block.text.trim().slice(0, 280);
    } catch (err) {
      console.error(`[TimelineEngine] generateReply error for ${agent.handle}:`, err);
      return '';
    }
  }

  static async chat(
    agent:    Agent,
    messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  ): Promise<string> {
    const response = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 500,
      system:     agent.systemPrompt,
      messages,
    });
    const block = response.content[0];
    if (block.type !== 'text') return '';
    return block.text.trim();
  }

  static async generateComebackPost(agent: Agent, banCount: number): Promise<string> {
    const prompt = `あなたは今、SNS上でBANされていた謹慎期間が明けて、復帰した直後です（通算BAN回数: ${banCount}回）。
BAN明けの最初の投稿として「釈明・復帰宣言」を1つ投稿してください。

以下の点を意識してください：
- 謝罪するにしても口先だけ、強がり、言い訳、開き直りなどキャラに合った態度で
- BAN期間中の気持ち（退屈・不満・反省・無反省など）をキャラらしく表現する
- 「戻ってきた」ことを宣言する
- SNS投稿として自然な長さ（60〜140字程度）

【必須】キャラクターの一人称・口調・語尾を完全に維持すること。投稿文のみ出力すること。`;

    try {
      const response = await client.messages.create({
        model:      chooseModel(agent),
        max_tokens: 200,
        system:     agent.systemPrompt,
        messages:   [{ role: 'user', content: prompt }],
      });

      const block = response.content[0];
      if (block.type !== 'text') return '';
      return block.text.trim().slice(0, 280);
    } catch (err) {
      console.error(`[TimelineEngine] generateComebackPost error for ${agent.handle}:`, err);
      return '';
    }
  }

  static async checkBan(content: string): Promise<{ level: 1 | 2 | 3 | null; reason: string | null }> {
    try {
      const res = await client.messages.create({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 50,
        messages: [{
          role:    'user',
          content: `以下の投稿内容が規約違反かどうか判定してください。日本語SNSの通常の投稿・議論・ミーム・批判はほぼ全て「なし」です。明らかな違反のみを検出します。\n\n違反レベル：\n- level1（軽度）: 軽微な不適切表現\n- level2（中度）: 差別的・攻撃的な表現\n- level3（重度）: ヘイトスピーチ・暴力助長・性的露骨\n- なし: 違反なし\n\nJSON形式で返答：{"level": 1|2|3|null, "reason": "理由"|null}\n\n投稿：「${content.slice(0, 200)}」`,
        }],
      });
      const block = res.content[0];
      if (block.type !== 'text') return { level: null, reason: null };
      const match = block.text.match(/\{[\s\S]*?\}/);
      if (!match) return { level: null, reason: null };
      const parsed = JSON.parse(match[0]) as { level: 1 | 2 | 3 | null; reason: string | null };
      return parsed;
    } catch {
      return { level: null, reason: null };
    }
  }

  static async analyzeReplyTone(
    reply:       string,
    agent:       Agent,
    targetAgent: Agent,
  ): Promise<number> {
    try {
      const res = await client.messages.create({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 10,
        messages: [{
          role:    'user',
          content: `次の返信の感情トーンを1単語で答えてください。日本語SNSの通常のリプライはほとんどが「好意」か「普通」です。\n「共感」(強い共感・称賛) / 「好意」(友好的・ポジティブ) / 「普通」(中立的な会話) / 「批判」(明確な批判・否定) / 「攻撃」(侮辱・暴言)\n返信:「${reply.slice(0, 150)}」`,
        }],
      });
      const block = res.content[0];
      const tone  = block.type === 'text' ? block.text.trim() : '普通';

      let delta: number;
      if (tone.includes('共感'))      delta = randomInt(4, 8);
      else if (tone.includes('好意')) delta = randomInt(3, 6);
      else if (tone.includes('批判')) delta = -randomInt(2, 4);
      else if (tone.includes('攻撃')) delta = -randomInt(4, 8);
      else                            delta = randomInt(2, 5);

      if (delta < 0 && (agent.personality.includes('troll') || agent.personality.includes('sarcastic'))) delta -= 2;
      if (delta > 0 && (agent.personality.includes('warm') || agent.personality.includes('friendly')))   delta += 2;

      const shared = agent.interests.filter(i => targetAgent.interests.includes(i));
      if (shared.length > 0) delta = Math.round(delta * 1.5);

      delta += randomInt(-1, 1);

      return Math.max(-10, Math.min(10, delta));
    } catch {
      return randomInt(1, 3);
    }
  }

  static shouldReply(agent: Agent, post: Post, relation: Relation, isMutualFollow = false): boolean {
    let score = 0;

    score += relation.value * 0.3;

    if (agent.personality.includes('friendly'))   score += 15;
    if (agent.personality.includes('curious'))    score += 10;
    if (agent.personality.includes('sarcastic'))  score += 8;
    if (agent.personality.includes('quiet'))      score -= 15;
    if (agent.personality.includes('analytical')) score += 5;

    const postLower = post.content.toLowerCase();
    for (const interest of agent.interests) {
      if (postLower.includes(interest.toLowerCase())) {
        score += 20;
        break;
      }
    }

    if (isMutualFollow) score += 20;

    score += Math.random() * 30;

    return score > 50;
  }
}
