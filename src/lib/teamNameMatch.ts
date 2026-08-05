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

/** `text` is matched case-insensitively; pass it already-lowercased if you have it, otherwise this lowercases internally. */
export function mentionsTeam(text: string, teamName: string): boolean {
  const lowerText = text.toLowerCase();
  const full = teamName.toLowerCase();
  if (lowerText.includes(full)) return true;

  const tokens = full.split(/\s+/).filter((t) => t.length >= 3 && !GENERIC_NAME_WORDS.has(t));
  return tokens.length > 0 && tokens.some((t) => lowerText.includes(t));
}
