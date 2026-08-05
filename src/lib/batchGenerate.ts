import { analyzeEvent } from "./analyzeEvent";

/**
 * Throttled multi-fixture analysis (added 2026-08-02 — subscription-usage
 * discipline pass). Generating picks for many fixtures back-to-back (e.g.
 * 2026-08-01's 26-pick day) can burst through a rolling subscription usage
 * window a lot faster than the same volume spread out — this runs a list
 * of eventIds through analyzeEvent() with a configurable concurrency cap
 * and a pause between batches, instead of firing every call at once.
 *
 * No special-cased "usage-limit" handling lives here: ClaudeCodeAgent
 * already remembers a usage-limit hit for itself (module-level cooldown —
 * see ClaudeCodeAgent.ts) and fails fast on the rest of this batch (and
 * beyond, until its cooldown expires) rather than re-attempting a call
 * already known to fail. batchGenerate just reports which provider
 * actually served each pick, from the saved Pick row itself — currently
 * always "claude-code" (see src/agents/index.ts), but reads from the row
 * rather than assuming that, so this doesn't need updating if a second
 * provider is ever reintroduced.
 */

const DEFAULT_CONCURRENCY = 2;
const DEFAULT_DELAY_MS = 3000;

export interface BatchGenerateItemResult {
  eventId: number;
  success: boolean;
  pickId?: number;
  modelProvider?: string;
  degradedAnalysis?: boolean;
  error?: string;
}

export async function generateBatch(eventIds: number[]): Promise<BatchGenerateItemResult[]> {
  const concurrency = Math.max(1, Number(process.env.PICK_BATCH_CONCURRENCY || DEFAULT_CONCURRENCY));
  const delayMs = Math.max(0, Number(process.env.PICK_BATCH_DELAY_MS || DEFAULT_DELAY_MS));

  console.log(`[batchGenerate] starting batch of ${eventIds.length} fixture(s), concurrency=${concurrency}, delay=${delayMs}ms between chunks`);

  const results: BatchGenerateItemResult[] = [];
  const chunks = chunk(eventIds, concurrency);

  for (let c = 0; c < chunks.length; c++) {
    const settled = await Promise.allSettled(chunks[c].map((eventId) => runOne(eventId)));
    for (const s of settled) {
      results.push(s.status === "fulfilled" ? s.value : { eventId: -1, success: false, error: (s.reason as Error).message });
    }

    if (c < chunks.length - 1 && delayMs > 0) {
      await sleep(delayMs);
    }
  }

  const byProvider = new Map<string, number>();
  for (const r of results) {
    if (r.success && r.modelProvider) byProvider.set(r.modelProvider, (byProvider.get(r.modelProvider) ?? 0) + 1);
  }
  const providerSummary = [...byProvider.entries()].map(([p, n]) => `${p}: ${n}`).join(", ") || "none succeeded";
  console.log(`[batchGenerate] batch complete — ${results.filter((r) => r.success).length}/${results.length} succeeded. By provider: ${providerSummary}.`);

  return results;
}

async function runOne(eventId: number): Promise<BatchGenerateItemResult> {
  try {
    const pick = await analyzeEvent(eventId);
    console.log(`[batchGenerate] event ${eventId} -> pick ${pick.id} via ${pick.modelProvider}${pick.degradedAnalysis ? " (degraded — no search)" : ""}`);
    return { eventId, success: true, pickId: pick.id, modelProvider: pick.modelProvider, degradedAnalysis: pick.degradedAnalysis };
  } catch (err) {
    const message = (err as Error).message;
    console.error(`[batchGenerate] event ${eventId} failed:`, message);
    return { eventId, success: false, error: message };
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
