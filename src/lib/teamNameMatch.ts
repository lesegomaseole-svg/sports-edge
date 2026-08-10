/**
 * Shared "does this text refer to this team" heuristic — used by
 * settlement.ts (matching a Pick's free-text recommendation against
 * home/away) and analyzeEvent.ts (filtering news items to ones actually
 * about one of the two teams in a fixture). Extracted here 2026-08-01
 * rather than duplicated, since both call sites need the exact same
 * "full name, or a significant non-generic token of it" fallback — see
 * settlement.ts's "BUG FOUND + FIXED" note on why the naive full-name
 * substring check alone isn't enough (e.g. "Fredrikstad" for the stored
 * "Fredrikstad FK").
 */

const GENERIC_NAME_WORDS = new Set([
  "fc", "fk", "cf", "sc", "sk", "bk", "afc", "cfc", "united", "city", "town",
  "athletic", "atletico", "club", "real", "de", "the", "sporting", "cd",
]);

/**
 * `text` is matched case-insensitively; pass it already-lowercased if you
 * have it, otherwise this lowercases internally.
 *
 * `opponentName` (added 2026-08-10, after a real bug): pass the OTHER
 * team in the fixture whenever the caller needs to tell the two apart
 * (settlement.ts's double_chance and resultLabelToSide — anywhere an OR
 * across both teams is fine, e.g. analyzeEvent.ts's news filter, it's
 * safe to omit). Without it, the token-fallback below can false-positive
 * on a word two same-city clubs share — confirmed live: "Feyenoord
 * Rotterdam or Draw" registered as mentioning "Sparta Rotterdam" too,
 * purely because "Rotterdam" isn't in GENERIC_NAME_WORDS, which pushed a
 * double_chance pick's covered-outcomes count to 3 and marked it
 * unsettleable even though the recommendation was perfectly gradable.
 * Any word shared with the opponent's name can never be what
 * distinguishes the two, so it's excluded from the fallback token set
 * before matching.
 */
export function mentionsTeam(text: string, teamName: string, opponentName?: string): boolean {
  const lowerText = text.toLowerCase();
  const full = teamName.toLowerCase();
  if (lowerText.includes(full)) return true;

  const opponentTokens = new Set(opponentName ? opponentName.toLowerCase().split(/\s+/) : []);
  const tokens = full
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !GENERIC_NAME_WORDS.has(t) && !opponentTokens.has(t));
  return tokens.length > 0 && tokens.some((t) => lowerText.includes(t));
}
