import { Router } from "express";
import { prisma } from "../../db/client";

export const oddsRouter = Router();

// Read-only as of 2026-08-03 — OddsSnapshot is inert (see schema.prisma's
// comment): nothing writes new rows anymore, this just serves the
// 25,952 rows of history already accumulated for whoever wants to look
// back at them. Most-recent-snapshot-per-bookmaker+market for a given
// event, same query shape as before.
oddsRouter.get("/:eventId", async (req, res) => {
  const eventId = Number(req.params.eventId);

  const snapshots = await prisma.oddsSnapshot.findMany({
    where: { eventId },
    orderBy: { fetchedAt: "desc" },
    take: 200,
  });

  const latestByKey = new Map<string, (typeof snapshots)[number]>();
  for (const s of snapshots) {
    const key = `${s.bookmaker}::${s.marketType}`;
    if (!latestByKey.has(key)) latestByKey.set(key, s);
  }

  const result = [...latestByKey.values()].map((s) => ({
    ...s,
    outcomes: JSON.parse(s.outcomes),
  }));

  res.json(result);
});
