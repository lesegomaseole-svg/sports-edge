/**
 * Computes calibration/track-record stats from settled Picks. "Settled"
 * here means outcome IN ('won','lost','push') — 'push' is excluded from
 * hit-rate and Brier-score math (there's no well-defined "correct
 * probability" target for a void bet) but still counted and shown
 * separately for transparency. 'unsettleable' picks are reported as a
 * count but excluded from every rate calculation.
 */
import { prisma } from "../db/client";

const MIN_RELIABLE_SAMPLE = 30;

const CONFIDENCE_BANDS: { label: string; min: number; max: number }[] = [
  { label: "0.4-0.5", min: 0.4, max: 0.5 },
  { label: "0.5-0.6", min: 0.5, max: 0.6 },
  { label: "0.6-0.7", min: 0.6, max: 0.7 },
  { label: "0.7-0.8", min: 0.7, max: 0.8 },
  { label: "0.8+", min: 0.8, max: Infinity },
];

interface GradedPick {
  confidence: number;
  outcome: string; // "won" | "lost"
  marketType: string;
  leagueTitle: string;
}

interface BandStats {
  band: string;
  count: number;
  hitRate: number | null;
  avgStatedConfidence: number | null;
  calibrationGap: number | null; // hitRate - avgStatedConfidence; negative = overconfident
  reliable: boolean;
}

interface GroupStats {
  key: string;
  count: number;
  hitRate: number | null;
  reliable: boolean;
}

export interface CalibrationReport {
  overall: {
    totalPicks: number;
    wins: number;
    losses: number;
    pushes: number;
    unsettleable: number;
    unsettled: number; // outcome still null — not yet graded
    hitRate: number | null; // wins / (wins + losses), excludes pushes
    brierScore: number | null; // mean squared error of confidence vs outcome, graded picks only
    reliable: boolean;
  };
  byConfidenceBand: BandStats[];
  byMarket: GroupStats[];
  byLeague: GroupStats[];
  minReliableSample: number;
}

export async function computeCalibrationReport(): Promise<CalibrationReport> {
  const picks = await prisma.pick.findMany({
    where: { outcome: { not: null } },
    select: {
      confidence: true,
      outcome: true,
      marketType: true,
      event: { select: { sport: { select: { title: true } } } },
    },
  });

  const wins = picks.filter((p) => p.outcome === "won").length;
  const losses = picks.filter((p) => p.outcome === "lost").length;
  const pushes = picks.filter((p) => p.outcome === "push").length;
  const unsettleable = picks.filter((p) => p.outcome === "unsettleable").length;
  const totalPicksAll = await prisma.pick.count();
  const unsettled = totalPicksAll - picks.length;

  const graded: GradedPick[] = picks
    .filter((p) => p.outcome === "won" || p.outcome === "lost")
    .map((p) => ({
      confidence: p.confidence,
      outcome: p.outcome as string,
      marketType: p.marketType,
      leagueTitle: p.event.sport.title,
    }));

  const gradedCount = graded.length;
  const hitRate = gradedCount > 0 ? wins / gradedCount : null;
  const brierScore =
    gradedCount > 0
      ? graded.reduce((sum, p) => {
          const actual = p.outcome === "won" ? 1 : 0;
          return sum + (p.confidence - actual) ** 2;
        }, 0) / gradedCount
      : null;

  const byConfidenceBand: BandStats[] = CONFIDENCE_BANDS.map((band) => {
    const inBand = graded.filter((p) => p.confidence >= band.min && p.confidence < band.max);
    return summarizeBand(band.label, inBand);
  });

  const byMarket = summarizeGroups(graded, (p) => p.marketType);
  const byLeague = summarizeGroups(graded, (p) => p.leagueTitle);

  return {
    overall: {
      totalPicks: totalPicksAll,
      wins,
      losses,
      pushes,
      unsettleable,
      unsettled,
      hitRate,
      brierScore,
      reliable: gradedCount >= MIN_RELIABLE_SAMPLE,
    },
    byConfidenceBand,
    byMarket,
    byLeague,
    minReliableSample: MIN_RELIABLE_SAMPLE,
  };
}

function summarizeBand(label: string, inBand: GradedPick[]): BandStats {
  const count = inBand.length;
  if (count === 0) {
    return { band: label, count: 0, hitRate: null, avgStatedConfidence: null, calibrationGap: null, reliable: false };
  }
  const wins = inBand.filter((p) => p.outcome === "won").length;
  const hitRate = wins / count;
  const avgStatedConfidence = inBand.reduce((sum, p) => sum + p.confidence, 0) / count;
  return {
    band: label,
    count,
    hitRate,
    avgStatedConfidence,
    calibrationGap: hitRate - avgStatedConfidence,
    reliable: count >= MIN_RELIABLE_SAMPLE,
  };
}

function summarizeGroups(graded: GradedPick[], keyFn: (p: GradedPick) => string): GroupStats[] {
  const byKey = new Map<string, GradedPick[]>();
  for (const p of graded) {
    const key = keyFn(p);
    const list = byKey.get(key) ?? [];
    list.push(p);
    byKey.set(key, list);
  }

  return [...byKey.entries()]
    .map(([key, list]) => {
      const wins = list.filter((p) => p.outcome === "won").length;
      return { key, count: list.length, hitRate: wins / list.length, reliable: list.length >= MIN_RELIABLE_SAMPLE };
    })
    .sort((a, b) => b.count - a.count);
}
