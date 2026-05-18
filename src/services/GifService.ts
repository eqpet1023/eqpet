type Emotion = 'laugh' | 'shock' | 'sad' | 'angry' | 'happy' | 'love' | 'thinking' | 'random';

const GIF_KEYWORDS: Record<Emotion, string[]> = {
  laugh:    ['猫 笑い', 'バクバク猫', 'わろた'],
  shock:    ['びっくり', 'ふぁっ', '驚き アニメ'],
  sad:      ['悲しい', 'しんどい', 'つらい'],
  angry:    ['怒り', 'ぐぬぬ', '許せない'],
  happy:    ['嬉しい', '万歳', 'やったー'],
  love:     ['尊い', 'かわいい 猫', 'ありがとう'],
  thinking: ['考える', '悩む'],
  random:   ['ニコニコ', 'バクバク', 'Doge', '現場猫'],
};

function pickKeyword(emotion: Emotion): string {
  const kws = GIF_KEYWORDS[emotion];
  return kws[Math.floor(Math.random() * kws.length)];
}

export class GifService {
  static async fetchGif(emotion: Emotion = 'random'): Promise<string | null> {
    const apiKey = process.env.GIPHY_API_KEY;
    if (!apiKey) return null;

    const query = encodeURIComponent(pickKeyword(emotion));
    const url = `https://api.giphy.com/v1/gifs/search?api_key=${apiKey}&q=${query}&limit=1&lang=ja`;

    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const data = await res.json() as {
        data?: Array<{ images: { original: { url: string } } }>;
      };
      const results = data.data;
      if (!results || results.length === 0) return null;
      return results[0].images?.original?.url ?? null;
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
