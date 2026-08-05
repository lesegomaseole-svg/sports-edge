/**
 * Provider-agnostic contract for sentiment sources (e.g. social/fan
 * sentiment toward a team or player). Scaffolding only for now — same
 * rationale as StatsProvider. Not wired into ingestion or the agent
 * prompt yet.
 */

export interface SentimentSnapshot {
  subject: string;
  score: number; // -1 (very negative) to 1 (very positive)
  summary: string;
}

export interface SentimentProvider {
  readonly name: string;
  fetchSentiment(subject: string, sportKey: string): Promise<SentimentSnapshot | null>;
}
