# Proposal: liquidity-weighted trust in odds

Status: **proposal only, not implemented.** This touches the analysis
prompt's reasoning (the EVIDENCE STANDARD section), not just measurement —
same rule as everywhere else in this app's audit history: reasoning changes
wait for an explicit go-ahead, this document is that review artifact, not
a description of something already built.

## The problem

The current prompt treats "found odds" as informative context without
distinguishing how much that price is actually worth trusting. The
corners/cards audit (`docs/corners-cards-audit.md`) already showed where
this app's real picks concentrate: 7 of 8 corners/cards-market picks were
Argentine Primera División, plus a steady stream of MLS bookings and
Eliteserien markets. Odds in these markets come from few books, wide
spreads, low volume — a genuinely different evidentiary category from an
EPL match-winner line, but nothing in the prompt currently says so. A
model that implicitly treats every found price the same way either
over-anchors to a noisy thin-market line or under-uses a genuinely strong
signal in the deep-market case it doesn't occur often in this app's actual
usage.

## What differentiating would need

1. **A liquidity signal per fixture+market.** See "the bookmaker-count
   question" below — this is the part that needed checking before writing
   the rest of this, per instruction.
2. **Prompt instruction changes** in the EVIDENCE STANDARD section of
   `analyzeEvent.ts` — something like: odds are a strong anchor only above
   a liquidity bar; below it, treat any found price as one weak data point
   among several, not a presumptive answer. Illustrative, not final
   wording — this is exactly the part that needs review before it's real:
   > "Market pricing, if found: treat it as a strong anchor ONLY when it's
   > for a top-tier league's core market (match result, main total) with
   > multiple bookmakers agreeing — in a thin/niche market (corners, cards,
   > bookings, or a smaller league generally), a found price is ONE data
   > point among several, not a presumptive answer; weigh your own
   > stats/news synthesis at least as heavily."

## The bookmaker-count question (checked before proposing its revival)

The obvious liquidity signal is bookmaker count — how many books are
quoting a given market — and this app used to compute exactly that. It was
dropped, but checking why mattered before suggesting bringing it back.

**Why it was actually dropped:** it wasn't found unreliable or wrong as a
signal. It was a side effect of a completely unrelated infrastructure
problem. See `fixtureIngestion.ts`'s header comment (lines 7-31): The Odds
API got blocked at the network level on this dev machine (a Zscaler
content-category filter, confirmed live, not an app bug, not a quota/key
issue). Since that vendor's one call supplied both fixtures and odds, the
block meant zero new fixtures at all — so fixture discovery was decoupled
onto ESPN entirely, and odds stopped being fetched at ingestion time in any
form. The bookmaker-count *scoring signal* disappeared purely because its
*data source* (the ingestion-time odds fetch) no longer runs — nothing
about the count itself was ever flagged as noisy, misleading, or a problem
on its own merits. This is a clean case, not a "the data's still there, we
can use it" hand-wave — the removal reason is fully unrelated to the
signal's own validity.

**One thing worth naming, not glossing over:** the Zscaler block that
caused all of this is specific to this dev machine's corporate network
(confirmed independently, outside this environment, as an NTT Ltd policy
block — see the earlier audit thread's E5/G3). The Oracle VM this app is
moving to (see `docs/oracle-runbook.md`) sits on different infrastructure
entirely, so a direct call to The Odds API for bookmaker-count specifically
might simply work there where it never has on this dev machine. That's
relevant to feasibility, not a reason to build blind — worth a live check
from the actual deployment target before assuming it's reachable.

**What reviving it would actually mean:** not restoring the old ingestion
signal as-is (that was a binary "does this fixture have odds at all"
sufficiency gate, evaluated once per fixture at ingestion). This would be a
new, different use of the same underlying data — a live per-market
bookmaker count fetched at *analysis* time, feeding a liquidity tier into
the prompt, not a fixture-creation gate. Same data field, different
purpose, needs its own implementation, not a revert.

## Independent baseline for the thin-market case

There's already a starting point. `src/lib/leagueBaseRates.ts` computes
rolling league-wide rates (goals/match, home/draw/away%, corners/match,
cards/match) from this app's own settled results, recomputed after every
results cycle, already surfaced to the prompt via `buildLeagueContextBlock`.
What it's missing is team-level granularity — a league average doesn't say
whether *this* fixture runs above or below it.

Two tiers worth distinguishing when this gets reviewed for real:

- **Cheap version:** extend the same aggregation pattern in
  `leagueBaseRates.ts` to also split by team and home/away, using data
  already being ingested (`MatchResult`). Fast to build — it's the same
  SQL/aggregation shape already there, just grouped one level finer. The
  real limitation: it starts from an even thinner, self-selected sample —
  only teams this app has already generated a pick for have any data at
  all, and only for whichever market got picked.
- **Real version:** ingest full historical results for tracked leagues —
  not just fixtures this app happened to analyze — via the ESPN results
  infrastructure already proven reachable elsewhere in this app
  (`espnMatchResult.ts`). Dozens/hundreds of real matches per team instead
  of a handful. More build effort (a new or extended ingestion path, not
  just a query change), but a genuinely credible baseline instead of a thin
  extrapolation from a self-selected sample.

Either tier needs the same sample-size discipline already established
elsewhere in this app (`MIN_SPLIT_SAMPLE` in `EspnMatchStatsProvider.ts`,
the "not enough graded picks yet" fallback text pattern in
`buildPerformanceFeedbackBlock`) — suppress or caveat below a reasonable N
rather than presenting a 2-match average as a real baseline.

Regardless of tier, this should be framed to the model as a sanity-check
anchor for markets where odds themselves are noisy — not a competing
predictive model, and not a reason to stop citing stats/news synthesis as
the primary evidence. It's a floor, not a substitute for actual analysis.

## What this proposal is NOT asking for yet

- No changes to `analyzeEvent.ts`'s prompt text.
- No changes to market-selection logic.
- No new provider/ingestion code.

All of the above needs a real go/no-go review, most likely split into at
least two separable decisions (the liquidity-signal mechanism, and which
tier of independent baseline to build, if any) rather than one bundled
yes/no.
