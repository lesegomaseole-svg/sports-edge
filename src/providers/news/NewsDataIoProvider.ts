/**
 * Real news provider backed by https://newsdata.io. Preferred over
 * NewsApiProvider (kept for reference, disabled by default) because
 * NewsData.io's free tier permits commercial use — NewsAPI's does not
 * (its production tier is $449/mo). Endpoint/response shape per
 * https://newsdata.io/documentation, verified 2026-07-30: the docs page
 * itself is a JS SPA with no server-rendered content, so this was
 * cross-checked against NewsData.io's own blog posts describing the
 * /latest endpoint and response object — reverify if this starts
 * erroring, vendor docs/shapes can change.
 */
import axios from "axios";
import { NewsProvider, NormalizedNewsItem } from "./NewsProvider";

const LATEST_ENDPOINT = "https://newsdata.io/api/1/latest";

interface RawArticle {
  article_id: string;
  title: string;
  link: string;
  description: string | null;
  pubDate: string; // "YYYY-MM-DD HH:MM:SS", UTC (not ISO 8601)
  source_id: string;
}

interface NewsDataResponse {
  status: string;
  totalResults: number;
  results: RawArticle[];
}

export class NewsDataIoProvider implements NewsProvider {
  readonly name = "newsdata-io";

  constructor(private readonly apiKey: string) {
    if (!apiKey) {
      throw new Error("NewsDataIoProvider requires NEWSDATA_API_KEY to be set");
    }
  }

  async fetchNews(query: string): Promise<NormalizedNewsItem[]> {
    try {
      const { data } = await axios.get<NewsDataResponse>(LATEST_ENDPOINT, {
        params: {
          apikey: this.apiKey,
          q: query,
          category: "sports",
          language: "en",
        },
        timeout: 10_000,
      });

      return (data.results ?? []).map((a) => ({
        title: a.title,
        summary: a.description ?? undefined,
        url: a.link,
        source: a.source_id,
        publishedAt: toIso(a.pubDate),
      }));
    } catch (err) {
      console.error(`[NewsDataIoProvider] fetchNews failed for "${query}":`, (err as Error).message);
      return [];
    }
  }
}

function toIso(pubDate: string): string {
  const parsed = new Date(`${pubDate.replace(" ", "T")}Z`);
  return isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}
