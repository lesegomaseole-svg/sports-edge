import { Router } from "express";
import { prisma } from "../../db/client";
import { runDailySlipFunnel } from "../../lib/dailySlip";

export const dailySlipRouter = Router();

// Triggers a real run of the daily-slip funnel right now — synchronous,
// same pattern as POST /api/picks/generate-batch, not backgrounded with
// polling. Can genuinely take several minutes (up to SHORTLIST_SIZE real
// Stage 3 LLM calls, each a real web-search round-trip) — the dashboard
// needs to show that plainly, same as the existing Analyse button's
// elapsed-time ticker.
dailySlipRouter.post("/run", async (_req, res) => {
  try {
    const result = await runDailySlipFunnel();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Reads back whatever the most recent run already produced — no
// re-triggering, just the persisted legs for the latest runDate that has
// any rows at all. Separate from /run so refreshing the dashboard doesn't
// accidentally re-spend real LLM calls.
dailySlipRouter.get("/latest", async (_req, res) => {
  const latest = await prisma.dailySlipLeg.findFirst({ orderBy: { runDate: "desc" } });
  if (!latest) {
    return res.json({ runDate: null, legs: [] });
  }

  const legs = await prisma.dailySlipLeg.findMany({
    where: { runDate: latest.runDate },
    include: { event: { include: { sport: true } } },
    orderBy: { createdAt: "asc" },
  });

  res.json({
    runDate: latest.runDate,
    legs: legs.map((l) => ({
      id: l.id,
      eventId: l.eventId,
      sport: l.event.sport.title,
      homeTeam: l.event.homeTeam,
      awayTeam: l.event.awayTeam,
      commenceTime: l.event.commenceTime,
      marketType: l.marketType,
      recommendation: l.recommendation,
      baselineProbability: l.baselineProbability,
      adjustedProbability: l.adjustedProbability,
      devigedMarketProbability: l.devigedMarketProbability,
      price: l.price,
      edge: l.edge,
      veto: l.veto,
      vetoReason: l.vetoReason,
      passedEvGate: l.passedEvGate,
      includedInCombo: l.includedInCombo,
      reasoning: l.reasoning,
      dataGaps: JSON.parse(l.dataGaps || "[]"),
      outcome: l.outcome,
    })),
  });
});
