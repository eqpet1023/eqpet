type Emotion = 'laugh' | 'shock' | 'sad' | 'angry' | 'happy' | 'love' | 'thinking' | 'random';

const GIF_KEYWORDS: Record<Emotion, string[]> = {
  laugh:    ['cat funny', 'doge laugh', 'pikachu happy', 'spongebob laughing', 'anime laugh'],
  shock:    ['surprised pikachu', 'cat shocked', 'anime shocked', 'tom and jerry shocked', 'surprised cat'],
  angry:    ['angry cat', 'triggered', 'anime angry', 'tom angry', 'mad cat'],
  sad:      ['sad cat', 'anime cry', 'crying cat meme', 'sad pepe', 'anime sad'],
  happy:    ['happy cat', 'anime happy', 'dancing cat', 'celebration anime', 'yay cat'],
  love:     ['cat love', 'anime heart', 'kawaii', 'neko love', 'anime blush'],
  thinking: ['thinking cat', 'hmm meme', 'anime thinking', 'pepe thinking', 'cat hmm'],
  random:   ['doge', 'cat meme', 'pepe', 'neko', 'anime reaction', 'surprised pikachu'],
};

interface GiphyResponse {
  data?: Array<{ images: { original: { url: string } } }>;
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export class GifService {
  static async fetchGif(emotion: Emotion = 'random'): Promise<string | null> {
    const apiKey = process.env.GIPHY_API_KEY;
    if (!apiKey) return null;

    const query = encodeURIComponent(pick(GIF_KEYWORDS[emotion]));
    const url   = `https://api.giphy.com/v1/gifs/search?api_key=${apiKey}&q=${query}&limit=10&rating=g`;

    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const data = await res.json() as GiphyResponse;
      if (!data.data?.length) return null;
      return pick(data.data).images?.original?.url ?? null;
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
