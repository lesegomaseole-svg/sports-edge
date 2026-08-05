/**
 * Reliability tracking for ingestion-time data sources — one DataSourceHealth
 * row per sourceId (currently: "the-odds-api", "bbc-sport-rss",
 * "espn-match-stats"). Two things call into this per ingestion cycle:
 *   - shouldAttempt(sourceId): checked BEFORE calling a source. Always
 *     true unless the source is currently disabled AND its last attempt
 *     was under 24h ago — i.e. a disabled source still gets exactly one
 *     retry per day, not "attempt forever" or "never again".
 *   - recordAttempt(sourceId, succeeded, reason?): checked AFTER calling a
 *     source. "Succeeded" means the source returned usable (non-empty)
 *     data, not just "didn't throw" — 3 consecutive failures/empty
 *     results in a row auto-disables the source with a clear log message.
 *     Any success resets the streak to 0, clears any prior reason, and
 *     immediately re-enables it if it was disabled.
 *
 * reason (added 2026-08-04): an optional label for WHY a failure happened
 * (currently only "quota_exhausted", set by analyzeEvent.ts when a stats
 * provider's own error indicates its request quota hit zero, not a real
 * outage) — stored on disabledReason so callers surfacing disabled
 * sources (see src/index.ts's startup warning, GET /api/data-sources/health)
 * can show something more useful than an undifferentiated failure count.
 */
import { prisma } from "../db/client";

const MAX_CONSECUTIVE_FAILURES = 3;
const RETRY_INTERVAL_MS = 24 * 60 * 60 * 1000;

export async function shouldAttempt(sourceId: string): Promise<boolean> {
  const health = await prisma.dataSourceHealth.findUnique({ where: { sourceId } });
  if (!health || !health.disabled) return true;

  const sinceLastAttempt = health.lastAttemptAt ? Date.now() - health.lastAttemptAt.getTime() : Infinity;
  if (sinceLastAttempt >= RETRY_INTERVAL_MS) {
    console.log(`[dataSourceHealth] "${sourceId}" is disabled but due for its once-per-24h retry — attempting.`);
    return true;
  }
  return false;
}

export async function recordAttempt(sourceId: string, succeeded: boolean, reason?: string): Promise<void> {
  const existing = await prisma.dataSourceHealth.findUnique({ where: { sourceId } });
  const now = new Date();

  if (succeeded) {
    await prisma.dataSourceHealth.upsert({
      where: { sourceId },
      update: { consecutiveFailures: 0, lastAttemptAt: now, lastSuccessAt: now, disabled: false, disabledReason: null },
      create: { sourceId, consecutiveFailures: 0, lastAttemptAt: now, lastSuccessAt: now, disabled: false },
    });
    if (existing?.disabled) {
      console.log(`[dataSourceHealth] "${sourceId}" recovered — re-enabled.`);
    }
    return;
  }

  const consecutiveFailures = (existing?.consecutiveFailures ?? 0) + 1;
  const disabled = consecutiveFailures >= MAX_CONSECUTIVE_FAILURES;

  await prisma.dataSourceHealth.upsert({
    where: { sourceId },
    update: { consecutiveFailures, lastAttemptAt: now, disabled, disabledReason: disabled ? (reason ?? null) : null },
    create: { sourceId, consecutiveFailures, lastAttemptAt: now, disabled, disabledReason: disabled ? (reason ?? null) : null },
  });

  if (disabled && !existing?.disabled) {
    const reasonSuffix = reason === "quota_exhausted" ? " (quota exhausted, not a real outage — will resume once the provider's quota resets)" : "";
    console.warn(
      `[dataSourceHealth] "${sourceId}" auto-disabled after ${consecutiveFailures} consecutive failures/empty results${reasonSuffix} — will retry once every 24h.`
    );
  }
}
