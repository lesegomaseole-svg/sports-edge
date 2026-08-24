/**
 * Nightly-ish DB backup — added 2026-08-24 after the Oracle account
 * termination cost this app its ENTIRE settled-pick history (calibration
 * data, hit rates, everything) because prod.db existed in exactly one
 * place with no copy anywhere else. Never again: this writes a timestamped
 * snapshot into backups/, which lives inside this project's OneDrive-synced
 * folder — confirmed live earlier this session that OneDrive actively
 * syncs this whole directory tree (it silently resurrected a deleted
 * provider file from its own cache), so anything written here gets copied
 * off this machine automatically, no separate cloud/rclone/git-remote
 * setup needed.
 *
 * Triggered on BOOT, not via system cron (added 2026-08-24, deliberate):
 * this app's real usage pattern is manually starting/stopping the process
 * (confirmed directly — "I am the one who is switching off the server
 * after manually analysing few games"), not running as an always-on
 * daemon. A cron job scheduled for 2am would silently never fire on a
 * laptop that's asleep most nights. Runs at most once per calendar day
 * (checks whether today's backup file already exists before doing
 * anything) so restarting the app 5 times in one day doesn't create 5
 * redundant snapshots — same guard pattern already used for setup.sh's
 * "seed only on a genuinely empty DB" and the paused auto-analysis idea.
 *
 * sqlite3's own `.backup` command, not a plain file copy — safe to run
 * against a database the app itself has open and may be writing to
 * concurrently (a raw `cp` of a live SQLite file risks copying a
 * half-written page).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, readdirSync, unlinkSync, statSync } from "node:fs";
import path from "node:path";

const execFileAsync = promisify(execFile);

const BACKUP_DIR = path.join(process.cwd(), "backups");
const DAILY_RETENTION_DAYS = 14;
const WEEKLY_RETENTION_WEEKS = 8;
const WEEKLY_WINDOW_DAYS = DAILY_RETENTION_DAYS + WEEKLY_RETENTION_WEEKS * 7;
const DAY_MS = 24 * 60 * 60 * 1000;

// Prisma resolves a relative DATABASE_URL (e.g. "file:./dev.db") relative
// to prisma/schema.prisma's own directory, not the process cwd — matches
// every DATABASE_URL seen in this app so far, local ("file:./dev.db") and
// the old deployed one ("file:/opt/sports-edge/data/prod.db", absolute).
function resolveDbPath(): string {
  const url = process.env.DATABASE_URL ?? "";
  const stripped = url.replace(/^file:/, "");
  if (path.isAbsolute(stripped)) return stripped;
  return path.join(process.cwd(), "prisma", stripped);
}

function todayDateString(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD, UTC
}

export async function runDbBackupIfDue(): Promise<void> {
  const dbPath = resolveDbPath();
  if (!existsSync(dbPath)) {
    console.warn(`[dbBackup] no database found at "${dbPath}" — skipping.`);
    return;
  }

  const dbBaseName = path.basename(dbPath, path.extname(dbPath)); // "dev" or "prod"
  const today = todayDateString();
  const todaysBackupPath = path.join(BACKUP_DIR, `${dbBaseName}-${today}.db`);

  if (existsSync(todaysBackupPath)) {
    return; // already backed up today — this is the "at most once/day" gate
  }

  mkdirSync(BACKUP_DIR, { recursive: true });

  try {
    await execFileAsync("sqlite3", [dbPath, `.backup '${todaysBackupPath}'`]);
    console.log(`[dbBackup] snapshot written: ${todaysBackupPath}`);
  } catch (err) {
    console.error("[dbBackup] backup failed:", (err as Error).message);
    return; // don't run retention cleanup off the back of a failed backup
  }

  applyRetention(dbBaseName);
}

// Keeps every backup from the last DAILY_RETENTION_DAYS days, then thins
// anything older than that (up to WEEKLY_WINDOW_DAYS out) down to one
// per calendar week, and deletes everything past the weekly window
// entirely. "One per week" = the oldest surviving backup in each ISO
// week, picked deterministically so repeated runs converge on the same
// set rather than reshuffling which day of each week survives.
function applyRetention(dbBaseName: string): void {
  const prefix = `${dbBaseName}-`;
  const files = readdirSync(BACKUP_DIR).filter((f) => f.startsWith(prefix) && f.endsWith(".db"));

  const now = Date.now();
  const entries = files
    .map((f) => {
      const dateStr = f.slice(prefix.length, prefix.length + 10); // "YYYY-MM-DD"
      const ts = Date.parse(dateStr + "T00:00:00Z");
      return { file: f, ts, ageDays: Math.floor((now - ts) / DAY_MS) };
    })
    .filter((e) => !Number.isNaN(e.ts))
    .sort((a, b) => a.ts - b.ts); // oldest first

  const seenWeeks = new Set<string>();
  for (const entry of entries) {
    if (entry.ageDays <= DAILY_RETENTION_DAYS) continue; // keep, daily tier
    if (entry.ageDays > WEEKLY_WINDOW_DAYS) {
      unlinkSync(path.join(BACKUP_DIR, entry.file));
      continue;
    }
    // Weekly tier: keep only the first (oldest) backup seen per ISO week.
    const weekKey = isoWeekKey(new Date(entry.ts));
    if (seenWeeks.has(weekKey)) {
      unlinkSync(path.join(BACKUP_DIR, entry.file));
    } else {
      seenWeeks.add(weekKey);
    }
  }
}

function isoWeekKey(d: Date): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((date.getTime() - yearStart.getTime()) / DAY_MS + 1) / 7);
  return `${date.getUTCFullYear()}-W${weekNum}`;
}

// Exposed for the restore-verification step (see docs) and for a manual
// `npx tsx -e` sanity check without duplicating the resolution logic.
export function _internal_resolveDbPath(): string {
  return resolveDbPath();
}
