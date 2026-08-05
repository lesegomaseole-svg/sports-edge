/**
 * The "manage the markets to look into" API. This is the source of truth
 * the odds/news schedulers read from — toggling a market here directly
 * changes what gets polled on the next cycle.
 */
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db/client";

export const marketsRouter = Router();

const DEFAULT_MARKET_TYPES = ["h2h", "spreads", "totals"];

marketsRouter.get("/", async (_req, res) => {
  const tracked = await prisma.trackedMarket.findMany({
    include: { sport: true },
    orderBy: [{ sport: { title: "asc" } }, { marketType: "asc" }],
  });
  res.json(tracked);
});

const toggleSchema = z.object({
  sportId: z.number().int(),
  marketType: z.enum(["h2h", "spreads", "totals"]),
  enabled: z.boolean(),
});

// Enable or disable one (sport, marketType) combination. Upserts so the
// first time a market is enabled for a sport it's created automatically.
marketsRouter.put("/", async (req, res) => {
  const parsed = toggleSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const { sportId, marketType, enabled } = parsed.data;

  const tracked = await prisma.trackedMarket.upsert({
    where: { sportId_marketType: { sportId, marketType } },
    update: { enabled },
    create: { sportId, marketType, enabled },
    include: { sport: true },
  });

  res.json(tracked);
});

// Convenience: enable all default market types for a sport in one call.
marketsRouter.post("/enable-sport/:sportId", async (req, res) => {
  const sportId = Number(req.params.sportId);
  const sport = await prisma.sport.findUnique({ where: { id: sportId } });
  if (!sport) return res.status(404).json({ error: "Sport not found" });

  const results = [];
  for (const marketType of DEFAULT_MARKET_TYPES) {
    results.push(
      await prisma.trackedMarket.upsert({
        where: { sportId_marketType: { sportId, marketType } },
        update: { enabled: true },
        create: { sportId, marketType, enabled: true },
      })
    );
  }
  res.json(results);
});

marketsRouter.post("/disable-sport/:sportId", async (req, res) => {
  const sportId = Number(req.params.sportId);
  await prisma.trackedMarket.updateMany({ where: { sportId }, data: { enabled: false } });
  res.json({ ok: true });
});
