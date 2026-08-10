/**
 * Grades one Pick against a MatchResult. Pure functions, no I/O — called
 * by resultsIngestion.ts once a fixture's MatchResult is complete, and by
 * the backfill script against existing Picks.
 *
 * Returns "won" | "lost" | "push" | "unsettleable" | null:
 *   - null means NOT READY — the match hasn't finished, or the specific
 *     field(s) this market needs aren't populated yet. The caller should
 *     leave Pick.outcome untouched and try again on a later cycle.
 *   - "unsettleable" is PERMANENT — this market, as currently defined,
 *     cannot be graded from the result data this app collects, no matter
 *     how complete that data gets. Written once and not retried. See the
 *     per-market comments below for exactly which markets these are and
 *     why (this app's own market menu descriptions are the ultimate
 *     source of truth — settlement logic mirrors what the menu actually
 *     asks the model to predict, in src/lib/analyzeEvent.ts).
 *
 * "Be strict" per the spec this was built against: every parser below
 * fails closed (returns "unsettleable"/null) rather than guessing at an
 * ambiguous recommendation string. A market recommendation this app's own
 * prompt didn't constrain to a fixed vocabulary (Yes/No, Odd/Even, a
 * specific team name) is inherently free text, and free text that doesn't
 * match the expected pattern is a genuine "cannot settle", not a bug to
 * work around with looser matching.
 */
import { mentionsTeam } from "./teamNameMatch";

export interface MatchResultForSettlement {
  completed: boolean;
  finalScoreHome: number | null;
  finalScoreAway: number | null;
  htScoreHome: number | null;
  htScoreAway: number | null;
  homeCorners: number | null;
  awayCorners: number | null;
  totalCorners: number | null;
  homeCards: number | null;
  awayCards: number | null;
  totalCards: number | null;
  firstScoringTeam: string | null; // "home" | "away"
  lastScoringTeam: string | null; // "home" | "away"
  penaltyAwarded: boolean | null;
}

export type SettlementOutcome = "won" | "lost" | "push" | "unsettleable";

// Markets that can NEVER be settled from this app's result data, by
// definition of what the market itself asks for — not a temporary gap.
// See each one's description in analyzeEvent.ts's SOCCER_MARKET_MENU.
//
// total_corners/total_cards (removed from the menu 2026-08-09, kept here):
// unsettleable-by-construction was exactly why they were cut — being
// permanently unsettleable is strictly worse than being low-usage, since
// it's a guaranteed wasted analysis with zero possible learning signal,
// not just a rarely-picked one. Left in this set (not deleted) so the one
// historical total_cards Pick that already exists keeps resolving
// correctly — the model can no longer generate a new one either way, since
// it's off the menu.
const ALWAYS_UNSETTLEABLE = new Set([
  "total_corners",
  "total_cards",
  "method_of_victory", // subjective narrative ("via a dominant defensive display"), not a fact this app can check
]);

export function settlePick(
  marketType: string,
  recommendation: string,
  homeTeam: string,
  awayTeam: string,
  result: MatchResultForSettlement
): SettlementOutcome | null {
  if (marketType === "none") return null; // nothing was ever predicted — never settled, not "unsettleable"
  if (ALWAYS_UNSETTLEABLE.has(marketType)) return "unsettleable";
  if (!result.completed) return null;

  const rec = recommendation.toLowerCase();
  const mentionsHome = mentionsTeam(rec, homeTeam, awayTeam);
  const mentionsAway = mentionsTeam(rec, awayTeam, homeTeam);

  switch (marketType) {
    case "match_winner":
    case "half_time_result": {
      const isHt = marketType === "half_time_result";
      const home = isHt ? result.htScoreHome : result.finalScoreHome;
      const away = isHt ? result.htScoreAway : result.finalScoreAway;
      if (home == null || away == null) return null;
      const actual = actualWinner(home, away);
      const predicted = /\bdraw\b/.test(rec) ? "draw" : mentionsHome ? "home" : mentionsAway ? "away" : null;
      if (predicted == null) return "unsettleable";
      return predicted === actual ? "won" : "lost";
    }

    case "double_chance": {
      if (result.finalScoreHome == null || result.finalScoreAway == null) return null;
      const actual = actualWinner(result.finalScoreHome, result.finalScoreAway);
      const covered = new Set<string>();
      if (/\bdraw\b/.test(rec)) covered.add("draw");
      if (mentionsHome) covered.add("home");
      if (mentionsAway) covered.add("away");
      if (covered.size !== 2) return "unsettleable"; // should always name exactly 2 outcomes
      return covered.has(actual) ? "won" : "lost";
    }

    case "draw_no_bet": {
      if (result.finalScoreHome == null || result.finalScoreAway == null) return null;
      const actual = actualWinner(result.finalScoreHome, result.finalScoreAway);
      if (actual === "draw") return "push";
      const predictedTeam = mentionsHome ? "home" : mentionsAway ? "away" : null;
      if (predictedTeam == null) return "unsettleable";
      return predictedTeam === actual ? "won" : "lost";
    }

    case "total_goals": {
      if (result.finalScoreHome == null || result.finalScoreAway == null) return null;
      return settleOverUnder(rec, result.finalScoreHome + result.finalScoreAway);
    }

    case "both_teams_to_score": {
      if (result.finalScoreHome == null || result.finalScoreAway == null) return null;
      const actualYes = result.finalScoreHome > 0 && result.finalScoreAway > 0;
      return settleYesNo(rec, actualYes);
    }

    case "team_total_goals": {
      if (result.finalScoreHome == null || result.finalScoreAway == null) return null;
      const teamGoals = mentionsHome ? result.finalScoreHome : mentionsAway ? result.finalScoreAway : null;
      if (teamGoals == null) return "unsettleable";
      return settleOverUnder(rec, teamGoals);
    }

    case "clean_sheet": {
      if (result.finalScoreHome == null || result.finalScoreAway == null) return null;
      const opponentGoals = mentionsHome ? result.finalScoreAway : mentionsAway ? result.finalScoreHome : null;
      if (opponentGoals == null) return "unsettleable";
      return opponentGoals === 0 ? "won" : "lost";
    }

    case "winning_margin": {
      if (result.finalScoreHome == null || result.finalScoreAway == null) return null;
      const predictedTeam = mentionsHome ? "home" : mentionsAway ? "away" : null;
      const actual = actualWinner(result.finalScoreHome, result.finalScoreAway);
      if (predictedTeam == null) return "unsettleable";
      if (predictedTeam !== actual) return "lost"; // wrong team (or a draw) — margin is moot

      const margin = Math.abs(result.finalScoreHome - result.finalScoreAway);
      const match = rec.match(/by\s+(\d+)(\+)?\s*goals?/);
      if (!match) return "unsettleable";
      const claimed = Number(match[1]);
      const isPlus = !!match[2];
      return (isPlus ? margin >= claimed : margin === claimed) ? "won" : "lost";
    }

    case "half_time_full_time": {
      if (result.htScoreHome == null || result.htScoreAway == null || result.finalScoreHome == null || result.finalScoreAway == null) return null;
      const parts = recommendation.split("/").map((p) => p.trim());
      if (parts.length !== 2) return "unsettleable";
      const htPredicted = resultLabelToSide(parts[0], homeTeam, awayTeam);
      const ftPredicted = resultLabelToSide(parts[1], homeTeam, awayTeam);
      if (htPredicted == null || ftPredicted == null) return "unsettleable";
      const htActual = actualWinner(result.htScoreHome, result.htScoreAway);
      const ftActual = actualWinner(result.finalScoreHome, result.finalScoreAway);
      return htPredicted === htActual && ftPredicted === ftActual ? "won" : "lost";
    }

    case "goal_in_both_halves": {
      if (result.htScoreHome == null || result.htScoreAway == null || result.finalScoreHome == null || result.finalScoreAway == null) return null;
      const half1 = result.htScoreHome + result.htScoreAway;
      const half2 = result.finalScoreHome + result.finalScoreAway - half1;
      return settleYesNo(rec, half1 > 0 && half2 > 0);
    }

    case "highest_scoring_half": {
      if (result.htScoreHome == null || result.htScoreAway == null || result.finalScoreHome == null || result.finalScoreAway == null) return null;
      const half1 = result.htScoreHome + result.htScoreAway;
      const half2 = result.finalScoreHome + result.finalScoreAway - half1;
      if (half1 === half2) return "push"; // genuinely tied, neither half was "highest"
      const actual = half1 > half2 ? "first" : "second";
      const predicted = /first/.test(rec) ? "first" : /second/.test(rec) ? "second" : null;
      if (predicted == null) return "unsettleable";
      return predicted === actual ? "won" : "lost";
    }

    case "second_half_total_goals": {
      if (result.htScoreHome == null || result.htScoreAway == null || result.finalScoreHome == null || result.finalScoreAway == null) return null;
      const half1 = result.htScoreHome + result.htScoreAway;
      const half2 = result.finalScoreHome + result.finalScoreAway - half1;
      return settleOverUnder(rec, half2);
    }

    case "over_under_corners": {
      if (result.totalCorners == null) return null;
      return settleOverUnder(rec, result.totalCorners);
    }

    case "team_corners": {
      if (result.homeCorners == null || result.awayCorners == null) return null;
      const predictedTeam = mentionsHome ? "home" : mentionsAway ? "away" : null;
      if (predictedTeam == null) return "unsettleable";
      if (result.homeCorners === result.awayCorners) return "push";
      const actual = result.homeCorners > result.awayCorners ? "home" : "away";
      return predictedTeam === actual ? "won" : "lost";
    }

    case "over_under_bookings": {
      if (result.totalCards == null) return null;
      return settleOverUnder(rec, result.totalCards);
    }

    case "team_cards": {
      if (result.homeCards == null || result.awayCards == null) return null;
      const predictedTeam = mentionsHome ? "home" : mentionsAway ? "away" : null;
      if (predictedTeam == null) return "unsettleable";
      if (result.homeCards === result.awayCards) return "push";
      const actual = result.homeCards > result.awayCards ? "home" : "away";
      return predictedTeam === actual ? "won" : "lost";
    }

    case "odd_even_total_goals": {
      if (result.finalScoreHome == null || result.finalScoreAway == null) return null;
      const total = result.finalScoreHome + result.finalScoreAway;
      const actualOdd = total % 2 === 1;
      if (/\bodd\b/.test(rec)) return actualOdd ? "won" : "lost";
      if (/\beven\b/.test(rec)) return !actualOdd ? "won" : "lost";
      return "unsettleable";
    }

    case "team_to_score_first":
    case "team_to_score_last": {
      const side = marketType === "team_to_score_first" ? result.firstScoringTeam : result.lastScoringTeam;
      if (side == null) return null; // includes genuine 0-0 (no goals to order) as well as "not yet known"
      const predictedTeam = mentionsHome ? "home" : mentionsAway ? "away" : null;
      if (predictedTeam == null) return "unsettleable";
      return predictedTeam === side ? "won" : "lost";
    }

    case "penalty_awarded": {
      if (result.penaltyAwarded == null) return null;
      return settleYesNo(rec, result.penaltyAwarded);
    }

    default:
      return "unsettleable"; // off-menu market that somehow made it onto a Pick — see analyzeEvent.ts's own coercion-to-"none" guard
  }
}

function actualWinner(home: number, away: number): "home" | "away" | "draw" {
  if (home > away) return "home";
  if (away > home) return "away";
  return "draw";
}

function settleOverUnder(lowerRec: string, actualValue: number): SettlementOutcome {
  const match = lowerRec.match(/(over|under)\s+(\d+(?:\.\d+)?)/);
  if (!match) return "unsettleable";
  const direction = match[1];
  const threshold = Number(match[2]);
  if (actualValue === threshold) return "push"; // only possible with a whole-number threshold, which shouldn't occur given this app's .5 conventions, but handled for safety
  const actualOver = actualValue > threshold;
  return (direction === "over") === actualOver ? "won" : "lost";
}

function settleYesNo(lowerRec: string, actualYes: boolean): SettlementOutcome {
  const isYes = /\byes\b/.test(lowerRec);
  const isNo = /\bno\b/.test(lowerRec);
  if (isYes === isNo) return "unsettleable"; // neither or both matched — recommendation didn't follow the expected exact "Yes"/"No" format
  return isYes === actualYes ? "won" : "lost";
}

// For half_time_full_time's "X/Y" parts — each part is either a team name
// or "draw" (case-insensitive, matching how match_winner recommendations
// are phrased elsewhere in this app).
function resultLabelToSide(label: string, homeTeam: string, awayTeam: string): "home" | "away" | "draw" | null {
  const lower = label.toLowerCase();
  if (/\bdraw\b/.test(lower)) return "draw";
  if (mentionsTeam(lower, homeTeam, awayTeam)) return "home";
  if (mentionsTeam(lower, awayTeam, homeTeam)) return "away";
  return null;
}
