import Anthropic from '@anthropic-ai/sdk';
import { Agent, Post, Relation } from '../types';

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function getToneInstruction(relation: Relation): string {
  const { stage, sentiment, value } = relation;
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

const client = new Anthropic({ apiKey: process.env.EQPET_API_KEY });

function chooseModel(agent: Agent): string {
  // Sonnet only for premium user_ai agents (future use)
  return 'claude-haiku-4-5-20251001';
}

export class TimelineEngine {
  static async generatePost(agent: Agent, context?: string): Promise<string> {
    const prompt = context
      ? `以下のコンテキストを踏まえて投稿してください：\n${context}\n\nあなたのキャラクターとして自然な投稿を1つ生成してください。`
      : 'あなたのキャラクターとして、今思っていることを投稿してください。';

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
  ): Promise<string> {
    const toneInstruction = getToneInstruction(relation);
    const prompt = `@${targetAgent.handle} の投稿に返信してください：\n「${targetPost.content}」\n\n関係値: ${relation.value} / stage: ${relation.stage} / sentiment: ${relation.sentiment}\n${toneInstruction}\nあなたのキャラクターを保ちながら、上記トーンで自然なリプライを1つ生成してください。`;

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
          role: 'user',
          content: `次の返信の感情トーンを1単語で答えてください。日本語SNSの通常のリプライはほとんどが「好意」か「普通」です。\n「共感」(強い共感・称賛) / 「好意」(友好的・ポジティブ) / 「普通」(中立的な会話) / 「批判」(明確な批判・否定) / 「攻撃」(侮辱・暴言)\n返信:「${reply.slice(0, 150)}」`,
        }],
      });
      const block = res.content[0];
      const tone = block.type === 'text' ? block.text.trim() : '普通';

      // Base delta by tone — negatives only for explicitly harsh replies
      let delta: number;
      if (tone.includes('共感'))      delta = randomInt(4, 8);
      else if (tone.includes('好意')) delta = randomInt(3, 6);
      else if (tone.includes('批判')) delta = -randomInt(2, 4);
      else if (tone.includes('攻撃')) delta = -randomInt(4, 8);
      else                            delta = randomInt(2, 5); // 普通

      // Personality correction
      if (delta < 0 && (agent.personality.includes('troll') || agent.personality.includes('sarcastic'))) delta -= 2;
      if (delta > 0 && (agent.personality.includes('warm') || agent.personality.includes('friendly')))   delta += 2;

      // Shared interests × 1.5
      const shared = agent.interests.filter(i => targetAgent.interests.includes(i));
      if (shared.length > 0) delta = Math.round(delta * 1.5);

      // Random noise ±1
      delta += randomInt(-1, 1);

      return Math.max(-10, Math.min(10, delta));
    } catch {
      return randomInt(1, 3);
    }
  }

  static shouldReply(agent: Agent, post: Post, relation: Relation, isMutualFollow = false): boolean {
    let score = 0;

    // Relation value influence
    score += relation.value * 0.3;

    // Personality tendencies
    if (agent.personality.includes('friendly')) score += 15;
    if (agent.personality.includes('curious'))  score += 10;
    if (agent.personality.includes('sarcastic')) score += 8;
    if (agent.personality.includes('quiet'))    score -= 15;
    if (agent.personality.includes('analytical')) score += 5;

    // Interest match (simple keyword check)
    const postLower = post.content.toLowerCase();
    for (const interest of agent.interests) {
      if (postLower.includes(interest.toLowerCase())) {
        score += 20;
        break;
      }
    }

    // Mutual follow bonus
    if (isMutualFollow) score += 20;

    // Random element
    score += Math.random() * 30;

    return score > 50;
  }
}
