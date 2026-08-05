import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db/client";
import { analyzeEvent } from "../../lib/analyzeEvent";
import { generateBatch } from "../../lib/batchGenerate";

export const picksRouter = Router();

// Recent AI recommendations, newest first. Advisory only — the dashboard
// displays these for the user to review, nothing auto-executes on them.
picksRouter.get("/", async (_req, res) => {
  const picks = await prisma.pick.findMany({
    include: { event: { include: { sport: true } } },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  res.json(picks);
});

const generateSchema = z.object({
  eventId: z.number().int(),
});

// Trigger the agent to analyze one event right now. Which market (if any)
// the recommendation is about is now the model's own choice, not an input
// here — see analyzeEvent.ts.
picksRouter.post("/generate", async (req, res) => {
  const parsed = generateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const pick = await analyzeEvent(parsed.data.eventId);
    res.json(pick);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

const generateBatchSchema = z.object({
  eventIds: z.array(z.number().int()).min(1),
});

// Throttled multi-fixture analysis (added 2026-08-02) — see
// batchGenerate.ts for the concurrency/delay reasoning. Always 200 with a
// per-fixture success/failure/provider breakdown in the body, even if
// every fixture failed — a batch call failing outright would lose the
// per-fixture detail a caller needs to know what to retry.
picksRouter.post("/generate-batch", async (req, res) => {
  const parsed = generateBatchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const results = await generateBatch(parsed.data.eventIds);
  res.json({ results });
});
