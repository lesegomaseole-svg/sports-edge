import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as os from "node:os";
import { AgentProvider, AgentRecommendation } from "./AgentProvider";
import { parseAgentJson } from "./parseAgentJson";

const execFileAsync = promisify(execFile);

/**
 * Subscription-billed agent provider (added 2026-08-02) — shells out to the
 * Claude Code CLI in non-interactive ("headless") mode instead of calling
 * the Anthropic API directly, so this app's picks draw against a Claude
 * Pro/Max subscription's included usage rather than metered API billing.
 * The sole agent provider as of 2026-08-02 — see src/agents/index.ts's
 * header for why GeminiAgent/ClaudeAgent/OpenAIAgent/FallbackAgent were
 * removed rather than kept as a fallback chain behind this.
 *
 * Verified live against code.claude.com/docs/en/headless, /tools-reference,
 * /permission-modes, and /errors on 2026-08-02 (not assumed from training
 * data), AND against 3 real end-to-end pick-generation calls the same day
 * once the CLI was installed and authenticated: real latency (111-156s per
 * original call, plus a critique pass on 2 of the 3), real web search
 * (confirmed genuinely current info, e.g. a same-day referee appointment
 * no training data could contain), and confirmed zero ANTHROPIC_API_KEY
 * usage (the key was independently confirmed at zero balance the whole
 * time — a request using it would have failed identically to every other
 * exhausted-key call this session, and these succeeded). If the CLI is
 * missing/unauthenticated/usage-limited at runtime, this throws a clear
 * error — analyzeEvent.ts surfaces it as a 500, nothing here silently
 * degrades to fake output.
 *
 * Invocation shape:
 *   claude -p "<prompt>" --output-format json --permission-mode dontAsk
 *          --allowedTools "WebSearch,WebFetch" --model sonnet
 *
 * - `-p` (print/non-interactive mode): required for any scripted call, and
 *   for headless invocation this only-documented CLI shape *is* the SDK —
 *   the headless doc page's own words are "this page covers using the
 *   Agent SDK via the CLI (`claude -p`)". The separate Python/TypeScript
 *   Agent SDK packages give more (callbacks, native message objects), but
 *   this app doesn't need them: a single fire-and-forget prompt in, JSON
 *   text out is exactly the shape `-p` already gives, and shelling out
 *   avoids adding another SDK dependency for one call site.
 * - Deliberately NOT using `--bare`: bare mode "skips OAuth and keychain
 *   reads" and requires ANTHROPIC_API_KEY or an apiKeyHelper for auth —
 *   using it would silently defeat the entire point of this file (it would
 *   fall back to metered API billing instead of the subscription session).
 *   The tradeoff is that a non-bare `-p` call auto-discovers hooks/skills/
 *   MCP servers/CLAUDE.md the way an interactive session would — mitigated
 *   below by running with `cwd` set to a neutral OS temp directory, so
 *   there is nothing project-specific for it to discover regardless.
 * - `--permission-mode dontAsk` + `--allowedTools "WebSearch,WebFetch"`:
 *   verified this is a real restriction, not just a prompt-skip — dontAsk
 *   mode "runs only actions matching your permissions.allow rules... the
 *   session never waits for input," and any tool call outside that list is
 *   denied outright rather than executed. This is NOT bypassPermissions
 *   (which disables restrictions entirely and is explicitly documented as
 *   for isolated containers only) — dontAsk is the one that actually
 *   narrows the toolset to reasoning + web search, no file or Bash access
 *   at all, matching the task's ask exactly.
 * - `--model sonnet`: pins the model explicitly (the CLI's short alias,
 *   distinct from the API's "claude-sonnet-5" string) rather than trusting
 *   whatever the account's current default happens to be.
 *
 * Env: ANTHROPIC_API_KEY (and ANTHROPIC_AUTH_TOKEN, a second var some
 * tooling honors) are explicitly stripped from the subprocess's
 * environment — see sanitizedEnv() — so the subprocess can never pick one
 * up and silently switch off subscription billing, even if a stray value
 * were sitting in this app's own .env. This is the mechanism that made
 * "zero Anthropic API-key usage while this provider is active" a
 * verifiable guarantee during live verification, not just an assumption.
 */

// Defaults to a bare "claude" (resolved via the spawning process's PATH),
// but overridable via CLAUDE_CODE_BIN — found this genuinely necessary
//2026-08-02: a global npm install with a custom prefix (e.g.
// ~/.npm-global, common when the default /usr/local needs sudo) only
// lands on PATH because the user's shell rc file exports it, and rc files
// aren't sourced by every process that might start this server (a
// non-login shell, a process manager, systemd/launchd) — not just this
// session's own tooling. Set CLAUDE_CODE_BIN to the absolute path from
// `which claude` in whatever shell you normally use if the bare name
// isn't resolving.
const CLAUDE_CODE_BIN = process.env.CLAUDE_CODE_BIN || "claude";
const CLI_MODEL_ALIAS = "sonnet";
const REPORTED_MODEL_NAME = "claude-sonnet-5";

// Generous relative to a direct API call — verified via docs (and live: a
// `-p` call took 111-156s per original analysis in practice) that a `-p`
// call can involve multiple search/fetch round-trips before returning,
// with more overhead than a raw API call (a fresh CLI process, not a warm
// API session).
const TIMEOUT_MS = Number(process.env.CLAUDE_CODE_TIMEOUT_MS || 180_000);
const MAX_BUFFER_BYTES = 20 * 1024 * 1024; // 20MB — generous headroom over Node's 1MB execFile default, since --output-format json includes full metadata alongside the result text

// Verified live 2026-08-02 (code.claude.com/docs/en/errors): non-interactive
// mode prints "You've hit your session limit · resets 3:45pm" (or "weekly
// limit" / "Opus limit") rather than a structured, machine-parseable reset
// timestamp. Rather than fragile-parse an ambiguous free-text time (no
// year/date, ambiguous AM/PM-adjacent phrasing, "Mon 12:00am" needing
// day-of-week resolution), this app remembers ONLY that a limit was hit and
// applies a fixed conservative cooldown before trying Claude Code again —
// deliberately simpler than exact reset-time parsing, and errs toward not
// re-attempting a call already known to fail rather than precision.
const USAGE_LIMIT_COOLDOWN_MS = Number(process.env.CLAUDE_CODE_USAGE_LIMIT_COOLDOWN_MS || 15 * 60 * 1000);
const USAGE_LIMIT_PATTERN = /hit your (session|weekly|Opus) limit/i;
const AUTH_FAILURE_PATTERN = /failed to authenticate/i;

// Module-level, not per-instance: a usage-limit hit is a real fact about
// the underlying subscription account, not about any one ClaudeCodeAgent
// object — every instance (and every pick in a batch — see
// src/lib/batchGenerate.ts) should see and respect the same cooldown.
let usageLimitedUntil: number | null = null;

interface ClaudeCodeJsonEnvelope {
  result?: string;
  is_error?: boolean;
  subtype?: string;
  session_id?: string;
}

export class ClaudeCodeAgent implements AgentProvider {
  readonly name = "claude-code";
  readonly modelName = REPORTED_MODEL_NAME;
  readonly supportsSearch = true;

  async analyze(prompt: string): Promise<AgentRecommendation> {
    if (usageLimitedUntil && Date.now() < usageLimitedUntil) {
      const minsLeft = Math.ceil((usageLimitedUntil - Date.now()) / 60_000);
      throw new Error(
        `Claude Code is usage-limited (remembered from an earlier call this session) — skipping for ~${minsLeft} more minute(s) rather than re-attempting a call already known to fail.`
      );
    }

    const startedAt = Date.now();
    let stdout: string;
    try {
      const result = await execFileAsync(
        CLAUDE_CODE_BIN,
        [
          "-p",
          prompt,
          "--output-format",
          "json",
          "--permission-mode",
          "dontAsk",
          "--allowedTools",
          "WebSearch,WebFetch",
          "--model",
          CLI_MODEL_ALIAS,
        ],
        {
          // Neutral cwd — see file header on why not --bare. Nothing
          // project-specific (CLAUDE.md, .claude/, .mcp.json) lives in the
          // OS temp dir, so there's nothing for non-bare mode to discover.
          cwd: os.tmpdir(),
          timeout: TIMEOUT_MS,
          maxBuffer: MAX_BUFFER_BYTES,
          env: sanitizedEnv(),
        }
      );
      stdout = result.stdout;
    } catch (err) {
      throw translateSubprocessError(err);
    }
    const latencyMs = Date.now() - startedAt;

    let envelope: ClaudeCodeJsonEnvelope;
    try {
      envelope = JSON.parse(stdout);
    } catch {
      throw new Error(`Claude Code returned non-JSON output despite --output-format json: ${stdout.slice(0, 200)}`);
    }

    const resultText = envelope.result ?? "";

    if (USAGE_LIMIT_PATTERN.test(resultText)) {
      usageLimitedUntil = Date.now() + USAGE_LIMIT_COOLDOWN_MS;
      throw new Error(`Claude Code usage-limited: "${resultText.trim()}" — will skip for ~${Math.round(USAGE_LIMIT_COOLDOWN_MS / 60_000)}min.`);
    }
    if (AUTH_FAILURE_PATTERN.test(resultText)) {
      throw new Error(`Claude Code not authenticated: "${resultText.trim()}" — run "claude" and complete /login.`);
    }

    const recommendation = parseAgentJson(resultText);
    // searchesPerformed is the model's own self-reported account — used
    // here as the searchesUsed proxy since the CLI's --output-format json
    // envelope exposes no authoritative per-call search count (verified
    // against the documented envelope shape: result/session_id/is_error/
    // subtype and a cost breakdown, nothing search-count-specific).
    const searchesUsed = recommendation.searchesPerformed.length;

    console.log(
      `[ClaudeCodeAgent] call completed in ${latencyMs}ms, ${searchesUsed} search(es) self-reported: ${recommendation.searchesPerformed.map((q) => `"${q}"`).join(", ") || "none"}`
    );

    return { ...recommendation, searchesUsed };
  }
}

// Strips Anthropic API-key auth vars so the subprocess cannot fall back to
// metered API billing even if a stray value were sitting in this app's
// own .env — see file header.
function sanitizedEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

function translateSubprocessError(err: unknown): Error {
  const e = err as NodeJS.ErrnoException & { stderr?: string; killed?: boolean; signal?: string };
  if (e.code === "ENOENT") {
    return new Error(
      `Claude Code CLI not found on PATH — install with "npm install -g @anthropic-ai/claude-code" and run "claude" once to authenticate (subscription login, not an API key).`
    );
  }
  if (e.killed || e.signal === "SIGTERM") {
    return new Error(`Claude Code timed out after ${TIMEOUT_MS}ms.`);
  }
  return new Error(`Claude Code subprocess failed: ${e.stderr?.trim() || e.message}`);
}
