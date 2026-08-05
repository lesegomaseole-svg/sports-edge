# Corners/cards data-gap classification — source of truth

Status: closed. This is the reference worksheet for the corners/cards
findings from the 2026-08 pick audit (originally reported as "56% missing,"
corrected to "40%," corrected again to the figures below). Per the request
that closed this thread: further changes to these 25 picks' classification
should not happen from re-reading this same set again — only from new picks
being generated and graded. If a genuine error is found in a specific row
below, fix that row in place; don't rebuild the table from scratch.

Generated: 2026-08-04. Source data: `/tmp/all_graded_picks.jsonl` (25 graded
picks as of that date) cross-referenced against live ESPN team-list lookups
(`GET https://site.api.espn.com/apis/site/v2/sports/soccer/{league}/teams`,
checked 2026-08-04) and the DB's `Event`/`Pick` tables for team names/league.

## Method

Every pick's `dataGaps` array was read in full and checked for any mention
of corners or cards. Each mention was classified into exactly one of four
buckets:

- **genuine** — the model states corners/cards data was absent for at least
  one team, AND that team's exact name fails to match ESPN's own live team
  list for its league. A naming/resolution failure is structural and
  timeless — it would fail on any date, regardless of provider health — so
  this is a confirmed, attributable cause.
- **unknowable** — same absence claim, but the named team(s) resolve
  **exactly** against ESPN's live team list today. Since naming isn't the
  cause, the original gap can't be explained that way, and there's no
  surviving health-history record (`DataSourceHealth` keeps one mutable row
  per source, no history — see `src/lib/dataSourceHealth.ts`) to check
  whether a provider was silently down during that specific pick's
  generation window. The gap may have been real; the cause can't be
  confirmed either way after the fact.
- **mislabeled** — the model had corners/cards data but wanted a narrower or
  more corroborated cut of it (a home/away split, an H2H-specific figure, a
  second source, a larger sample) — not a case of missing data, a case of
  imperfect data being described using absence language.
- **n/a** — no corners/cards absence claim at all (no mention, a mention of
  something else like weather, or a single-source/corroboration concern that
  doesn't amount to a stated absence).

Team-name resolution was checked with the same exact-match, case-insensitive
logic the app itself uses (`resolveEspnTeamId` in
`src/providers/espn/espnLeagueMap.ts`) — a "close match" (e.g. our stored
"Tigres" vs ESPN's "Tigres UANL") counts as a failure, since the app's own
resolver would fail the same way.

## Summary

- 25 picks total.
- **13 genuine-or-unknowable** (a real, currently-unresolved absence claim) → **52%** (13/25).
  - 10 genuine (structural naming/resolution failure, confirmed live).
  - 3 unknowable (111, 115, 116 — team(s) resolve fine today; cause can't be confirmed).
- 6 mislabeled (data existed; narrower cut wanted, not absence).
- 6 n/a (no corners/cards absence claim).

## Full classification (all 25 picks)

| id | market | outcome | league | home | away | corners/cards gap text (verbatim from `dataGaps`) | classification | evidence |
|----|--------|---------|--------|------|------|----------------------------------------------------|-----------------|----------|
| 83 | total_goals | lost | Liga MX | Querétaro | Tigres | "No corners or cards data at all for Tigres, preventing any total_corners/total_cards market call despite Querétaro data being available" | genuine | ESPN `mex.1` team list has no exact match for "Tigres" (real name: "Tigres UANL") |
| 84 | double_chance | won | Danish Superliga | Lyngby | AGF Aarhus | "No SofaScore statistical data available for AGF's most recent match, preventing a fair corners/cards total-market comparison"; "Total-goals and corners/cards h2h trends come from a single aggregator (protipster) not independently corroborated" | n/a | Single-source/corroboration concern (one source lacked AGF's most recent match), not a stated absence of corners/cards data itself |
| 85 | double_chance | won | Scottish Premiership | Falkirk F.C. | St Mirren | "No Falkirk-side corner or card statistics were provided (only St Mirren's), so total_corners/total_cards markets cannot be assessed with genuine two-team data" | genuine | ESPN `sco.1` team list has no exact match for "Falkirk F.C." (real name: "Falkirk") |
| 88 | double_chance | won | Argentine Primera División | Belgrano de Cordoba | Argentinos Juniors | "No corners, cards, fouls, xG, or shot data provided for Belgrano de Cordoba at all — only Argentinos Juniors has statistical data" | genuine | ESPN `arg.1` team list has no exact match for "Belgrano de Cordoba" (real name: "Belgrano (Córdoba)") |
| 90 | match_winner | won | Norway Eliteserien | IK Start | Viking FK | "No weather forecast available, removing one variable relevant to set-piece and card markets" | n/a | Weather gap only — not a corners/cards data absence claim |
| 91 | double_chance | won | Argentine Primera División | Gimnasia Mendoza | Union Santa Fe | "No current-season corner or card data for either team specific to this Clausura campaign" | genuine | ESPN `arg.1` has no exact match for "Gimnasia Mendoza" (real: "Gimnasia (Mendoza)") or "Union Santa Fe" (no match at all) |
| 92 | team_total_goals | won | Norway Eliteserien | Fredrikstad FK | Sandefjord | "No Fredrikstad-side corner or card data was provided (only Sandefjord's ESPN stats block), preventing a confident total_corners/total_cards call" | genuine | ESPN `nor.1` has no exact match for "Fredrikstad FK" (real name: "Fredrikstad") |
| 95 | both_teams_to_score | won | MLS | New York Red Bulls | Orlando City SC | "No dedicated head-to-head corners or cards history between these two specific teams" | mislabeled | H2H-specific request — team-level corners/cards data not claimed absent, only an H2H-specific cut |
| 98 | team_total_goals | lost | MLS | CF Montreal | New England Revolution | (none) | n/a | No corners/cards gap mentioned |
| 99 | double_chance | won | Scottish Premiership | Aberdeen | Hearts | "Corners/cards structured data only covers Aberdeen (4.4 corners, 0.8 yellow cards/game from cup matches vs weak opposition) with no comparable current Hearts figures" | genuine | ESPN `sco.1` has no exact match for "Hearts" (real name: "Heart of Midlothian") |
| 100 | over_under_corners | lost | Argentine Primera División | Estudiantes de Río Cuarto | Banfield | (none) | n/a | No corners/cards gap mentioned — clean pick |
| 101 | draw_no_bet | won | Argentine Primera División | Estudiantes | Defensa y Justicia | "Team-level corner/card total-match breakdown is incomplete - only Defensa's corner/card averages were reliably sourced, with no clean matching figure for Estudiantes" | genuine | ESPN `arg.1` has no exact match for "Estudiantes" (two similarly-named clubs exist: "Estudiantes de La Plata", "Estudiantes de Río Cuarto" — ambiguous shorthand) |
| 102 | total_goals | lost | MLS | Vancouver Whitecaps FC | Los Angeles FC | "No structured corners or cards data at all, so total_corners/over_under_corners/total_cards picks could not be built on genuine data" | genuine | ESPN `usa.1` has no exact match for "Vancouver Whitecaps FC" (real: "Vancouver Whitecaps") or "Los Angeles FC" (no match at all) |
| 103 | match_winner | won | MLS | Philadelphia Union | Atlanta United FC | (none) | n/a | No corners/cards gap mentioned |
| 104 | match_winner | lost | MLS | Inter Miami CF | Columbus Crew SC | "No Columbus corners-per-game or cards-per-game data found (search or structured) — total_corners/total_cards markets could not be properly assessed" | genuine | ESPN `usa.1` has no exact match for "Columbus Crew SC" (real name: "Columbus Crew") |
| 105 | over_under_corners | won | Argentine Primera División | Racing Club | CA Tigre BA | "No corner data specific to the current 2026 Clausura squads under new managers... the cited corner averages blend historical and general-season data rather than a clean current-form sample" | mislabeled | Data existed; model wanted a narrower current-form cut, not absent data |
| 106 | team_corners | won | MLS | D.C. United | Nashville SC | "No independent third source... confirming the exact corner splits"; "No data on Nashville's set-piece/corner generation tendencies as an away side against other strong home teams, only vs D.C. United specifically" | mislabeled | Data existed (corner splits, D.C. United matchup data); wanted corroboration/broader context, not absent data |
| 107 | team_corners | lost | MLS | FC Cincinnati | San Jose Earthquakes | "No home/away split for Cincinnati's corner average specifically (only season-wide and last-5/last-10 windows), so the true home-context number is inferred rather than confirmed" | mislabeled | Matches `EspnMatchStatsProvider`'s `MIN_SPLIT_SAMPLE=3` split-suppression design — data existed at season-level, home/away cut suppressed by design, not absent |
| 110 | both_teams_to_score | lost | Argentine Primera División | Newells Old Boys | Boca Juniors | "No Newell's-specific corners/cards data available from any structured source (sofascore reports none recorded)" | genuine | ESPN `arg.1` has no exact match for "Newells Old Boys" (real name: "Newell's Old Boys" — apostrophe) |
| 111 | both_teams_to_score | won | Argentine Primera División | River Plate | Rosario Central | "Structured feed had no corners/cards/form data to cross-check search findings" | unknowable | Both "River Plate" and "Rosario Central" exact-match ESPN `arg.1` today — naming isn't the cause, so the absence cause can't be confirmed after the fact |
| 112 | match_winner | won | Liga MX | América | Santos Laguna | (none) | n/a | No corners/cards gap mentioned |
| 113 | over_under_bookings | won | Argentine Primera División | Vélez Sarsfield | Independiente | "No cards data specific to this exact fixture's head-to-head history"; "Both teams' role-matched corners/cards splits are only n=4, below a robust sample size" | mislabeled | Data existed at broader granularity; wanted an H2H-specific/larger-sample cut |
| 114 | over_under_bookings | won | Argentine Primera División | Huracán | Atlético Tucumán | "Home/away card and corner splits suppressed for both teams in their role for this fixture... forced reliance on blended or thin-sample figures" | mislabeled | Explicit "suppressed"/"blended" language — matches split-suppression design, data existed at a coarser level |
| 115 | over_under_bookings | won | Argentine Primera División | Platense | Talleres (Córdoba) | "Home/away card and corner splits suppressed for both teams... (Huracán home n=1, Tucumán away n=3 used as best available)"; "Team-specific cards/fouls data for Platense and Talleres" | unknowable | Both "Platense" and "Talleres (Córdoba)" exact-match ESPN `arg.1` today — naming isn't the cause |
| 116 | over_under_bookings | won | Argentine Primera División | Central Córdoba (Santiago del Estero) | San Lorenzo | "No card, foul, or discipline data for San Lorenzo from any source" | unknowable | "San Lorenzo" exact-matches ESPN `arg.1` today — naming isn't the cause |

## C2: picks whose chosen market was corners/cards-family

Markets counted: `total_corners`, `over_under_corners`, `team_corners`,
`total_cards`, `over_under_bookings`, `team_cards`. 8 of the 25 graded picks
chose one of these. "Flagged anyway" = the pick both flagged a corners/cards
gap for the market it then chose AND that gap classified as genuine or
unknowable (not mislabeled) — i.e. a case where the model picked a
corners/cards market despite an unresolved (not just imperfect) gap in
exactly that data.

| id | market | outcome | gap classification | flagged anyway? |
|----|--------|---------|---------------------|------------------|
| 100 | over_under_corners | lost | n/a (no gap) | no |
| 105 | over_under_corners | won | mislabeled | no — granularity, not a real gap |
| 106 | team_corners | won | mislabeled | no — granularity, not a real gap |
| 107 | team_corners | lost | mislabeled | no — granularity, not a real gap |
| 113 | over_under_bookings | won | mislabeled | no — granularity, not a real gap |
| 114 | over_under_bookings | won | mislabeled | no — granularity, not a real gap |
| 115 | over_under_bookings | won | unknowable | **yes** |
| 116 | over_under_bookings | won | unknowable | **yes** |

**C2 = 2 of 8**, and both are unknowable, not confirmed-real — the two
surviving cases can't be shown to have been a genuine data gap the model
ignored, only an unresolved one.

## Note on concentration

7 of these 8 corners/cards-market picks are Argentine Primera División (all
except 106). Per this thread's standing constraint, this is reported as a
fact about the sample, not used to draw any further conclusion — see the
retracted Argentina-cluster finding earlier in this audit for why that
league gets flagged rather than reasoned from.
