/**
 * Seeds the catalog of sports the market manager can offer.
 *
 * Keys deliberately match The Odds API's sport keys (the reference odds
 * provider — see src/providers/odds/TheOddsApiProvider.ts) so wiring a real
 * API key later requires zero remapping. This list is intentionally broad
 * ("all sport markets" is the goal) even though only a few are marked
 * `active` out of the box — the user enables more from the dashboard.
 */
import { prisma } from "./client";

const SPORTS: { key: string; group: string; title: string; active: boolean }[] = [
  // --- Soccer --- (the app's only in-scope sport as of this writing — see
  // src/lib/analyzeEvent.ts MARKET_MENUS; original 10 leagues verified
  // live against ESPN for both fixtures and team-level stats on
  // 2026-07-31, 10 more added and verified 2026-08-01 — see the coverage
  // table in src/config/dataSources.ts comments and each stats provider's
  // file header for exact per-source coverage of all 20)
  { key: "soccer_epl", group: "Soccer", title: "Premier League", active: true },
  { key: "soccer_spain_la_liga", group: "Soccer", title: "La Liga", active: true },
  { key: "soccer_italy_serie_a", group: "Soccer", title: "Serie A", active: true },
  { key: "soccer_germany_bundesliga", group: "Soccer", title: "Bundesliga", active: true },
  { key: "soccer_france_ligue_one", group: "Soccer", title: "Ligue 1", active: true },
  { key: "soccer_uefa_champs_league", group: "Soccer", title: "Champions League", active: true },
  { key: "soccer_uefa_europa_league", group: "Soccer", title: "Europa League", active: true },
  { key: "soccer_portugal_primeira_liga", group: "Soccer", title: "Primeira Liga", active: true },
  { key: "soccer_netherlands_eredivisie", group: "Soccer", title: "Eredivisie", active: true },
  { key: "soccer_usa_mls", group: "Soccer", title: "MLS", active: true },
  { key: "soccer_efl_champ", group: "Soccer", title: "English Championship", active: true },
  { key: "soccer_spl", group: "Soccer", title: "Scottish Premiership", active: true },
  { key: "soccer_denmark_superliga", group: "Soccer", title: "Danish Superliga", active: true },
  { key: "soccer_brazil_campeonato", group: "Soccer", title: "Brazilian Série A", active: true },
  { key: "soccer_argentina_primera_division", group: "Soccer", title: "Argentine Primera División", active: true },
  { key: "soccer_saudi_arabia_pro_league", group: "Soccer", title: "Saudi Pro League", active: true },
  { key: "soccer_turkey_super_league", group: "Soccer", title: "Turkish Süper Lig", active: true },
  { key: "soccer_belgium_first_div", group: "Soccer", title: "Belgian First Division", active: true },
  { key: "soccer_mexico_ligamx", group: "Soccer", title: "Liga MX", active: true },
  { key: "soccer_japan_j_league", group: "Soccer", title: "J1 League", active: true },
  { key: "soccer_norway_eliteserien", group: "Soccer", title: "Eliteserien", active: true }, // added + verified 2026-08-01
  // Separate from Europa League proper (soccer_uefa_europa_league) —
  // ESPN tracks qualifying under its own competition code, and the two
  // have very different data quality (far more obscure teams in
  // qualifying) worth toggling independently. See espnLeagueMap.ts.
  { key: "soccer_uefa_europa_league_qualifying", group: "Soccer", title: "Europa League Qualifying", active: true },
  // --- Basketball --- (out of scope for now — see analyzeEvent.ts)
  { key: "basketball_nba", group: "Basketball", title: "NBA", active: false },
  { key: "basketball_euroleague", group: "Basketball", title: "EuroLeague", active: false },
  // --- Tennis ---
  { key: "tennis_atp", group: "Tennis", title: "ATP", active: false },
  { key: "tennis_wta", group: "Tennis", title: "WTA", active: false },
  // --- American Football ---
  { key: "americanfootball_nfl", group: "American Football", title: "NFL", active: false },
  { key: "americanfootball_ncaaf", group: "American Football", title: "NCAAF", active: false },
  // --- Baseball ---
  { key: "baseball_mlb", group: "Baseball", title: "MLB", active: false },
  // --- Ice Hockey ---
  { key: "icehockey_nhl", group: "Ice Hockey", title: "NHL", active: false },
  // --- Combat Sports ---
  { key: "mma_mixed_martial_arts", group: "MMA", title: "MMA", active: false },
  { key: "boxing_boxing", group: "Boxing", title: "Boxing", active: false },
  // --- Cricket ---
  { key: "cricket_test_match", group: "Cricket", title: "Test Match", active: false },
  { key: "cricket_big_bash", group: "Cricket", title: "Big Bash League", active: false },
  { key: "cricket_ipl", group: "Cricket", title: "IPL", active: false },
  // --- Rugby ---
  { key: "rugbyleague_nrl", group: "Rugby League", title: "NRL", active: false },
  { key: "rugbyunion_six_nations", group: "Rugby Union", title: "Six Nations", active: false },
];

const MARKET_TYPES = ["h2h", "spreads", "totals"];

async function main() {
  for (const s of SPORTS) {
    const sport = await prisma.sport.upsert({
      where: { key: s.key },
      update: { group: s.group, title: s.title, active: s.active },
      create: s,
    });

    if (s.active) {
      for (const marketType of MARKET_TYPES) {
        await prisma.trackedMarket.upsert({
          where: { sportId_marketType: { sportId: sport.id, marketType } },
          update: { enabled: true },
          create: { sportId: sport.id, marketType, enabled: true },
        });
      }
    } else {
      // Re-running seed after flipping a sport from active:true to false
      // must actually turn its tracked markets off — an empty update{} on
      // the branch above would leave already-enabled rows untouched.
      await prisma.trackedMarket.updateMany({ where: { sportId: sport.id }, data: { enabled: false } });
    }
  }

  console.log(`Seeded ${SPORTS.length} sports (${SPORTS.filter((s) => s.active).length} active by default).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
