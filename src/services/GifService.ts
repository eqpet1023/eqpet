type Emotion = 'laugh' | 'shock' | 'sad' | 'angry' | 'happy' | 'love' | 'thinking' | 'random';

const EMOTION_ENDPOINT: Record<Emotion, string> = {
  laugh:    'laugh',
  happy:    'happy',
  sad:      'cry',
  angry:    'angry',
  shock:    'blush',
  love:     'hug',
  thinking: 'think',
  random:   'wave',
};

interface NekosBestResponse {
  results: Array<{ url: string }>;
}

export class GifService {
  static async fetchGif(emotion: Emotion = 'random'): Promise<string | null> {
    const endpoint = EMOTION_ENDPOINT[emotion];
    const url      = `https://nekos.best/api/v2/${endpoint}?amount=1`;

    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const data = await res.json() as NekosBestResponse;
      return data.results?.[0]?.url ?? null;
    } catch {
      return null;
    }
  }

  static inferEmotion(content: string): Emotion {
    const text = content;
    if (/笑|草|ワロタ|ww|草不可避|草生え/.test(text)) return 'laugh';
    if (/びっくり|えっ|ガチ|マジ|？！|!?/.test(text))  return 'shock';
    if (/悲しい|つらい|しんどい|泣|😢|😭/.test(text))  return 'sad';
    if (/怒|許せ|ぐぬぬ|キレ|😠|😤/.test(text))        return 'angry';
    if (/嬉しい|やった|最高|神|優勝|😆|🎉/.test(text)) return 'happy';
    if (/尊い|かわいい|好き|ありがとう|💕|❤️/.test(text)) return 'love';
    if (/考え|悩む|うーん|🤔/.test(text))               return 'thinking';
    return 'random';
  }
}
