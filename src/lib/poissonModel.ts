/**
 * Baseline goals-market probability model — added 2026-08-24, part of the
 * daily-slip funnel rework. Pure math, no I/O, no LLM — deliberately
 * simple (Maher 1982-style independent-Poisson, the standard textbook
 * starting point). Its job is TRIAGE for Stage 1/2 of the funnel (is this
 * fixture even worth an expensive LLM look), not final judgement — the
 * LLM stage (existing agent orchestration) refines or vetoes whatever
 * this suggests. See src/lib/football-data-co-uk team-rate aggregation
 * (separate module) for where the attack/defense inputs actually come
 * from, and its own coverage caveat (only leagues football-data.co.uk
 * tracks — see FootballDataCoUkProvider.ts's own coverage comment).
 *
 * Model:
 *   lambda_home = leagueAvgHomeGoals * homeAttack(H) * awayDefense(A)
 *   lambda_away = leagueAvgAwayGoals * awayAttack(A) * homeDefense(H)
 * where homeAttack(H) = H's avg goals scored at home / league avg home
 * goals, homeDefense(H) = H's avg goals conceded at home / league avg
 * away goals (since when H is home, the opponent is the "away scorer"),
 * and symmetrically for away. Home/away goals are then modeled as
 * independent Poisson variables at those rates — the standard
 * simplification (real matches have slight negative correlation, e.g.
 * Dixon-Coles' low-score adjustment, deliberately not implemented here:
 * "keep it deliberately simple" per the build brief, revisit only if the
 * baseline proves itself first).
 */

const MAX_GOALS = 10; // Poisson tail beyond this is negligible for real football scoring rates (~0.5-3 goals/team/game)

export interface TeamGoalProfile {
  /** Team's own average goals scored in this venue context (home or away), divided by the league average for that context. >1 = stronger attack than average. */
  attackStrength: number;
  /** Team's own average goals conceded in this venue context, divided by the league average for the OPPOSING context. >1 = weaker defense than average. */
  defenseWeakness: number;
}

export interface LeagueAverages {
  avgHomeGoals: number;
  avgAwayGoals: number;
}

export interface ScoreGrid {
  lambdaHome: number;
  lambdaAway: number;
  /** grid[homeGoals][awayGoals] = joint probability of that exact scoreline */
  grid: number[][];
}

function factorial(n: number): number {
  let result = 1;
  for (let i = 2; i <= n; i++) result *= i;
  return result;
}

export function poissonPmf(k: number, lambda: number): number {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  return (Math.pow(lambda, k) * Math.exp(-lambda)) / factorial(k);
}

export function expectedGoals(
  home: TeamGoalProfile,
  away: TeamGoalProfile,
  league: LeagueAverages
): { lambdaHome: number; lambdaAway: number } {
  return {
    lambdaHome: league.avgHomeGoals * home.attackStrength * away.defenseWeakness,
    lambdaAway: league.avgAwayGoals * away.attackStrength * home.defenseWeakness,
  };
}

export function buildScoreGrid(lambdaHome: number, lambdaAway: number): ScoreGrid {
  const grid: number[][] = [];
  for (let h = 0; h <= MAX_GOALS; h++) {
    const row: number[] = [];
    const pHome = poissonPmf(h, lambdaHome);
    for (let a = 0; a <= MAX_GOALS; a++) {
      row.push(pHome * poissonPmf(a, lambdaAway));
    }
    grid.push(row);
  }
  return { lambdaHome, lambdaAway, grid };
}

export interface MatchWinnerProbabilities {
  homeWin: number;
  draw: number;
  awayWin: number;
}

export function matchWinnerProbabilities({ grid }: ScoreGrid): MatchWinnerProbabilities {
  let homeWin = 0,
    draw = 0,
    awayWin = 0;
  for (let h = 0; h <= MAX_GOALS; h++) {
    for (let a = 0; a <= MAX_GOALS; a++) {
      const p = grid[h][a];
      if (h > a) homeWin += p;
      else if (h < a) awayWin += p;
      else draw += p;
    }
  }
  return { homeWin, draw, awayWin };
}

/** threshold e.g. 2.5 — returns P(total goals > threshold), i.e. "over". */
export function totalGoalsOverProbability({ grid }: ScoreGrid, threshold: number): number {
  let over = 0;
  for (let h = 0; h <= MAX_GOALS; h++) {
    for (let a = 0; a <= MAX_GOALS; a++) {
      if (h + a > threshold) over += grid[h][a];
    }
  }
  return over;
}

export function bothTeamsToScoreProbability({ grid }: ScoreGrid): number {
  let p = 0;
  for (let h = 1; h <= MAX_GOALS; h++) {
    for (let a = 1; a <= MAX_GOALS; a++) {
      p += grid[h][a];
    }
  }
  return p;
}
