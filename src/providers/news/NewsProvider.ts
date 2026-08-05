/**
 * Provider-agnostic contract for news/context sources (injury reports,
 * lineup news, general sports journalism). Same rationale as OddsProvider:
 * isolate vendor-specific shapes behind one interface.
 */

export interface NormalizedNewsItem {
  title: string;
  summary?: string;
  url: string;
  source: string;
  publishedAt: string; // ISO 8601
}

export interface NewsProvider {
  readonly name: string;

  /** Fetch recent news relevant to a sport/query, e.g. team names or league. */
  fetchNews(query: string, sportKey?: string): Promise<NormalizedNewsItem[]>;
}
