/**
 * Contract for the LLM reasoning layer. As of 2026-08-02 there's a single
 * implementation (ClaudeCodeAgent — see src/agents/index.ts's header for
 * why the others were removed), but analyzeEvent.ts still only depends on
 * this interface, not the concrete class, so the shape stays intact if a
 * second provider is ever reintroduced.
 *
 * Important framing: the LLM is used here as a synthesis/reasoning layer
 * over structured context we already computed (team stats, news) — not as
 * a source of numbers it invents from nothing. There is no odds/market
 * line anywhere in this flow, so the model also chooses *which* market (if
 * any) it has a genuine view on, rather than being told upfront — see
 * buildEventAnalysisPrompt in analyzeEvent.ts for the context we hand it
 * and the exact market-choice instructions.
 */

export interface RunnerUp {
  market: string;
  whyWeaker: string;
}

export interface Discrepancy {
  fact: string; // what the fact was about, e.g. "Arsenal's last-5 form"
  searchValue: string; // what web search found
  apiValue: string; // what the structured/verification data (odds, stats, weather) had
  resolution: string; // which value was preferred and why (recency, source reliability), or how the conflict was handled
}

export type DataAvailability = "available" | "unavailable" | "partial";

// Added 2026-08-04 — a fixed 9-category checklist, replacing free-text
// dataGaps as the way to know whether a given kind of data existed for
// this analysis. The problem it fixes: with free text alone, silence is
// ambiguous — did the model have xG and just not mention it, or genuinely
// not have it? Auditing the first 25 picks found dataGaps mention-rates
// (e.g. "xG unavailable" in 18/25) that were PLAUSIBLY real given what's
// known about provider coverage, but couldn't be verified against what
// the model actually saw for any specific pick, since nothing recorded
// that. This makes it explicit and mandatory instead of inferred from
// whether the model happened to bring something up.
export interface DataAvailabilityChecklist {
  xg: DataAvailability;
  corners: DataAvailability;
  cards: DataAvailability;
  lineups: DataAvailability;
  injuries: DataAvailability;
  weather: DataAvailability;
  referee: DataAvailability;
  h2h: DataAvailability;
  oddsFeed: DataAvailability;
}

export interface AgentRecommendation {
  // Which market the model chose to have a view on, if any. Deliberately a
  // plain string, not a fixed union: the valid options are sport-specific
  // (see MARKET_MENU_BY_SPORT_KEY in analyzeEvent.ts — soccer's menu looks
  // nothing like NBA's), so there's no single global enum to constrain
  // this to at the type level. analyzeEvent.ts validates the value against
  // the current event's sport-specific menu after the fact, coercing to
  // "none" if the model returns something off-menu.
  market: string;
  recommendation: string; // e.g. "Arsenal to win", "Expect a high-scoring game", or "No clear market"
  confidence: number; // 0-1, the model's self-reported confidence
  reasoning: string; // cites the stats/news it used, and why it chose this market

  // Added 2026-08-01 alongside the web-search-enabled analysis prompt (see
  // analyzeEvent.ts). All parsed defensively in parseAgentJson.ts —
  // default to an empty/null value rather than throwing if the model
  // omits one, since a malformed optional field shouldn't fail an
  // otherwise-usable pick.
  keyFactors: string[]; // bullet-point factors that drove the decision
  // dataGaps (free text) is now for gaps OUTSIDE the 9 fixed
  // dataAvailability categories below — a specific unresolved ambiguity,
  // not "this whole category was missing" (that belongs in
  // dataAvailability, not restated here).
  dataGaps: string[];
  dataAvailability: DataAvailabilityChecklist;
  searchesPerformed: string[]; // model's own "query — what it resolved" account
  runnerUp: RunnerUp | null; // the strongest alternative market considered and why it lost out

  // Added 2026-08-01 alongside the search-primary/structured-data-verification
  // restructure (see analyzeEvent.ts) — anything where web search and the
  // structured verification data materially disagreed on a fact. Empty
  // array when everything agreed or only one source had a given fact
  // (that's not a discrepancy, just single-sourcing — noted in "reasoning"
  // instead, per the EVIDENCE/SEARCH labeling).
  discrepancies: Discrepancy[];

  // Set by the AGENT layer, not parsed from the model's JSON — see
  // ClaudeCodeAgent for how/when these get set.
  searchesUsed?: number; // from the model's own self-reported searchesPerformed length — the CLI's JSON envelope exposes no more authoritative count
  degradedAnalysis?: boolean; // always false with a single provider — kept on the type for when a multi-provider fallback exists again (see src/agents/index.ts)
}

export interface AgentProvider {
  readonly name: string;
  readonly modelName: string;
  // Whether this provider has real web-search capability — used to set
  // AgentRecommendation.degradedAnalysis when there's a fallback chain to
  // reason about (currently there isn't — see src/agents/index.ts).
  readonly supportsSearch: boolean;

  /** Send a fully-built prompt, get back a structured recommendation. */
  analyze(prompt: string): Promise<AgentRecommendation>;
}
