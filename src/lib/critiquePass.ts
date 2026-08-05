/**
 * Selective second pass: for a pick whose ORIGINAL confidence cleared
 * CRITIQUE_CONFIDENCE_THRESHOLD, send the model its own analysis back and
 * ask it to challenge the conclusion — the single highest-value place to
 * catch overconfidence, since a high-confidence pick is exactly the one
 * that does the most damage if it's wrong for a reason the first pass
 * missed.
 *
 * Gated by ENABLE_CRITIQUE_PASS (default true — literal string "false" is
 * the explicit opt-out, anything else including unset stays enabled).
 * Roughly doubles per-pick cost for the picks it runs on (a second full
 * model call, sometimes with its own web searches — see 2026-08-02's live
 * verification, where 1 of 2 real critique passes searched again and the
 * other reasoned entirely from evidence the original pass had already
 * gathered) — that's an accepted, deliberate tradeoff for the picks a
 * user is most likely to actually act on.
 */
import { AgentProvider, AgentRecommendation } from "../agents/AgentProvider";

export const CRITIQUE_CONFIDENCE_THRESHOLD = 0.65;

export const CRITIQUE_ENABLED = (process.env.ENABLE_CRITIQUE_PASS ?? "true").trim().toLowerCase() !== "false";

export interface CritiqueResult {
  final: AgentRecommendation;
  original: AgentRecommendation;
  critiqueNotes: string;
}

export function shouldRunCritique(originalConfidence: number): boolean {
  return CRITIQUE_ENABLED && originalConfidence >= CRITIQUE_CONFIDENCE_THRESHOLD;
}

export async function runCritiquePass(agent: AgentProvider, originalPrompt: string, original: AgentRecommendation): Promise<CritiqueResult> {
  const critiquePrompt = buildCritiquePrompt(originalPrompt, original);
  const final = await agent.analyze(critiquePrompt);
  return { final, original, critiqueNotes: summarizeChange(original, final) };
}

function buildCritiquePrompt(originalPrompt: string, original: AgentRecommendation): string {
  return `You previously analyzed this fixture and produced the following recommendation:

${JSON.stringify({ market: original.market, recommendation: original.recommendation, confidence: original.confidence, reasoning: original.reasoning })}

For reference, here is the exact data and instructions you were given for that analysis:

${originalPrompt}

---

Now critique your own analysis above, honestly and specifically:

1. What is the STRONGEST counter-argument against this pick — the single piece of evidence or line of reasoning that most threatens it?
2. Is any one piece of evidence being weighted more heavily than its actual reliability justifies (e.g. a single search result treated as decisive, a market price given outsized weight, or a PRINCIPLE-labeled claim doing more work than a general football-analysis observation should)?
3. Given the evidence standard you were given (0.7+ confidence requires multiple independent sources agreeing, with no material contradicting signal) — is the stated confidence actually earned, or is it higher than the evidence supports?

If this critique reveals a material weakness, lower the confidence to reflect it, or change the market to "none" if the pick no longer holds up under scrutiny. If it does not reveal a material weakness, keep the original recommendation and confidence — do not manufacture a change just to appear rigorous.

Respond with ONLY this JSON, in the exact same shape as before:
{
  "market": "...",
  "recommendation": "...",
  "confidence": 0.0,
  "reasoning": "...",
  "keyFactors": ["..."],
  "dataGaps": ["..."],
  "searchesPerformed": ["query — what it resolved"],
  "runnerUp": {"market": "...", "whyWeaker": "..."}
}`;
}

function summarizeChange(before: AgentRecommendation, after: AgentRecommendation): string {
  const parts: string[] = [];
  parts.push(before.market === after.market ? `market unchanged ("${after.market}")` : `market changed from "${before.market}" to "${after.market}"`);

  const confDelta = after.confidence - before.confidence;
  if (Math.abs(confDelta) >= 0.01) {
    parts.push(`confidence ${confDelta > 0 ? "raised" : "lowered"} ${before.confidence.toFixed(2)} -> ${after.confidence.toFixed(2)}`);
  } else {
    parts.push(`confidence unchanged (${after.confidence.toFixed(2)})`);
  }

  return parts.join("; ");
}
