import { AgentProvider } from "./AgentProvider";
import { ClaudeCodeAgent } from "./ClaudeCodeAgent";

/**
 * Single-provider as of 2026-08-02: GeminiAgent, ClaudeAgent (direct
 * Anthropic API), OpenAIAgent, and the FallbackAgent wrapper that chained
 * them together were all removed — all three metered/API-key paths had
 * been sitting genuinely unusable for a full day (Gemini blocked on a
 * Google Cloud billing-link requirement, Claude out of API credits,
 * OpenAI over quota), while ClaudeCodeAgent (subscription-billed, via the
 * `claude` CLI) was verified live and working well (3 real picks, real
 * search, real critique catches — see that day's verification). Given
 * that, keeping the multi-provider fallback machinery around added
 * indirection with no real fallback target behind it. If a second
 * provider is ever worth reintroducing, FallbackAgent's pattern (try each
 * in order, catch-and-continue on failure, degradedAnalysis keyed off
 * provider.supportsSearch) is straightforward to rebuild — nothing here
 * depends on it being gone.
 *
 * No mock fallback: if the CLI isn't installed/authenticated, analyze()
 * throws a clear error rather than returning fake output — surfaces as a
 * clear 500 from POST /api/picks/generate, doesn't crash the server.
 */
export function getAgentProvider(): AgentProvider {
  return new ClaudeCodeAgent();
}

export * from "./AgentProvider";
