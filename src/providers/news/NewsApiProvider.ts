/**
 * Real news provider backed by https://newsapi.org. Swap for any other
 * source (dedicated sports news API, RSS aggregator, Google News, etc.) by
 * implementing NewsProvider again — nothing downstream changes.
 */
import axios from "axios";
import { NewsProvider, NormalizedNewsItem } from "./NewsProvider";

interface RawArticle {
  title: string;
  description: string | null;
  url: string;
  source: { name: string };
  publishedAt: string;
}

export class NewsApiProvider implements NewsProvider {
  readonly name = "newsapi";

  constructor(private readonly apiKey: string) {
    if (!apiKey) {
      throw new Error("NewsApiProvider requires NEWSAPI_KEY to be set");
    }
  }

  async fetchNews(query: string): Promise<NormalizedNewsItem[]> {
    try {
      const { data } = await axios.get<{ articles: RawArticle[] }>("https://newsapi.org/v2/everything", {
        params: {
          q: query,
          sortBy: "publishedAt",
          language: "en",
          pageSize: 10,
          apiKey: this.apiKey,
        },
        timeout: 10_000,
      });

      return data.articles.map((a) => ({
        title: a.title,
        summary: a.description ?? undefined,
        url: a.url,
        source: a.source.name,
        publishedAt: a.publishedAt,
      }));
    } catch (err) {
      console.error(`[NewsApiProvider] fetchNews failed for "${query}":`, (err as Error).message);
      return [];
    }
  }
}
