// Shared helpers for the hook client scripts. Zero dependencies by design:
// these run inside Cowork sandboxes where npm installs are unavailable.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

// Version reported to the service as `client.plugin_version`.
//
// This used to be the frozen literal '0.1.0-skeleton', fully decoupled from the
// version build-plugin.mjs writes into .claude-plugin/plugin.json from the root
// package.json. That made the field useless for its ONE stated product purpose:
// docs/05-surface-architecture.md's exp-05 finding is that the Cowork VM serves
// STALE plugin code that survives uninstall, and its recorded consequence is
// "the service MUST detect stale `client.plugin_version` per payload". A constant
// that never changes can never be detected as stale -- every build, forever,
// reports the same string.
//
// Read from the shipped manifest instead, which is a sibling of scripts/ in the
// built tree (see PLUGIN.md's output tree). Falls back rather than throwing: this
// file also runs straight from packages/client/src/ in dev and in tests, where no
// manifest exists. `-dev` is deliberately distinguishable from a real install.
function readPluginVersion() {
  const roots = [
    process.env.CLAUDE_PLUGIN_ROOT && path.join(process.env.CLAUDE_PLUGIN_ROOT, '.claude-plugin', 'plugin.json'),
    path.join(__dirname, '..', '.claude-plugin', 'plugin.json'),
  ].filter(Boolean);
  for (const p of roots) {
    try {
      const v = JSON.parse(fs.readFileSync(p, 'utf8')).version;
      if (typeof v === 'string' && v) return v;
    } catch {
      /* not installed as a plugin, or unreadable -- try the next candidate */
    }
  }
  return '0.0.0-dev';
}

const PLUGIN_VERSION = readPluginVersion();

/** Read all of stdin, parse JSON tolerantly. Returns {} on any failure. */
function readStdinJson() {
  return new Promise((resolve) => {
    let raw = '';
    process.stdin.on('data', (d) => (raw += d));
    process.stdin.on('end', () => {
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
    process.stdin.on('error', () => resolve({}));
  });
}

/** State dir: plugin data dir when available (host-persistent), tmp otherwise. */
function stateDir() {
  return process.env.CLAUDE_PLUGIN_DATA || os.tmpdir();
}

/**
 * Guard against writing this plugin's credentials into ANOTHER plugin's data dir.
 *
 * Proven live on the first real install (2026-07-28): a Bash-tool invocation --
 * which is exactly how the setup skill runs pair.js -- inherits a
 * `CLAUDE_PLUGIN_DATA` belonging to whichever plugin the harness happened to
 * export, NOT this one. Observed: `.../plugins/data/codex-openai-codex` while
 * this plugin's dir is `.../plugins/data/prooftrail-inline`, with
 * `CLAUDE_PLUGIN_ROOT` unset entirely. Following the skill verbatim would have
 * written a live 90-day token into an unrelated plugin's directory AND reported
 * success (pair.js confirms via whoami in-process, which cannot tell where the
 * file landed), while the Stop hook -- which DOES run with the correct env --
 * read the right path, found nothing, and reported "not connected" forever.
 * Every retry would have leaked another token.
 *
 * Returns null when the directory is acceptable, or an error string when it is
 * demonstrably another plugin's. Deliberately narrow: it only fires when the path
 * looks like a plugin data dir (`/plugins/data/<something>`) whose name does not
 * match this plugin's. A tmpdir, a test fixture, or an explicitly-set custom path
 * is left alone -- the point is to catch the silent cross-plugin write, not to
 * police every path.
 */
function checkStateDirOwnership(dir = stateDir(), pluginName = readPluginName()) {
  if (!pluginName) return null;
  const norm = String(dir).replace(/\\/g, '/');
  const m = norm.match(/\/plugins\/data\/([^/]+)\/?$/);
  if (!m) return null; // not a plugin data dir -- tmpdir, test fixture, custom path
  if (m[1].includes(pluginName)) return null; // ours
  return (
    `refusing to write to ${dir} — that is another plugin's data directory ` +
    `(expected one named for "${pluginName}"). The environment this process ` +
    `inherited does not belong to this plugin. Re-run with CLAUDE_PLUGIN_DATA ` +
    `set to this plugin's own data directory.`
  );
}

/** This plugin's name from the shipped manifest; null when not running as an install. */
function readPluginName() {
  const roots = [
    process.env.CLAUDE_PLUGIN_ROOT && path.join(process.env.CLAUDE_PLUGIN_ROOT, '.claude-plugin', 'plugin.json'),
    path.join(__dirname, '..', '.claude-plugin', 'plugin.json'),
  ].filter(Boolean);
  for (const p of roots) {
    try {
      const n = JSON.parse(fs.readFileSync(p, 'utf8')).name;
      if (typeof n === 'string' && n) return n;
    } catch {
      /* try next */
    }
  }
  return null;
}

/** Sanitize a session id before using it in a filename (review L2/BUG6). */
function safeSessionId(sessionId) {
  return String(sessionId || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128);
}

function firstPromptPath(sessionId) {
  return path.join(stateDir(), `first-prompt-${safeSessionId(sessionId)}.json`);
}

/** UTC calendar day, e.g. '2026-07-24' — the dedupe key's day component. */
function utcDateStr(nowMs) {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function quotaNoticeMarkerPath(sessionId, nowMs) {
  return path.join(stateDir(), `quota-notice-${safeSessionId(sessionId)}-${utcDateStr(nowMs)}.json`);
}

/**
 * Fix 4 (F14): the quota banner is capped at most once per (session_id,
 * UTC day) so it doesn't become nagware in the Stop loop — advisory
 * `revise` feedback stays UNTHROTTLED; only this quota notice is capped.
 * Marks-and-checks atomically via an exclusive create (`wx`), so two
 * concurrent processes racing on the same session/day can't both see
 * "not shown yet". Fail-soft per this module's design: ANY fs error
 * (missing dir, permissions, an unrelated race) must never break the hook,
 * so it defaults to SHOWING the notice rather than silently swallowing it
 * forever — the one exception is `EEXIST`, which means another process (or
 * an earlier review this session/day) already wrote the marker.
 */
function shouldShowQuotaNotice(sessionId, nowMs = Date.now()) {
  try {
    fs.writeFileSync(quotaNoticeMarkerPath(sessionId, nowMs), '1', { flag: 'wx' });
    return true;
  } catch (e) {
    if (e && e.code === 'EEXIST') return false;
    return true;
  }
}

/** Credential chain per ADR-007: env -> sensitive userConfig -> data-dir file. */
function findToken() {
  if (process.env.REVIEWSVC_TOKEN) return process.env.REVIEWSVC_TOKEN;
  if (process.env.CLAUDE_PLUGIN_OPTION_API_TOKEN) return process.env.CLAUDE_PLUGIN_OPTION_API_TOKEN;
  try {
    const f = path.join(stateDir(), 'auth.json');
    if (fs.existsSync(f)) {
      const t = JSON.parse(fs.readFileSync(f, 'utf8')).token;
      if (t) return t;
    }
  } catch {}
  return null;
}

/** Emit a hook systemMessage (the only user-visible channel we use in advisory mode). */
function emitSystemMessage(text) {
  process.stdout.write(JSON.stringify({ systemMessage: text }));
}

/**
 * Sanitize judge feedback before it is injected into the user's session (TM-1).
 * The judge/service is a prompt-injection channel; a compromised or MITM'd
 * response must not deliver arbitrary content. Drop control chars (keep tab and
 * newline), then hard-cap length — the last line of defense regardless of what
 * is upstream (review T2.1). Char-code based to avoid control-char literals.
 */
function sanitizeFeedback(text) {
  const s = String(text);
  let out = '';
  for (let i = 0; i < s.length && out.length < 2000; i++) {
    const c = s.charCodeAt(i);
    if (c === 9 || c === 10 || (c >= 32 && c !== 127)) out += s[i];
  }
  return out.trim();
}

/**
 * Validate the service base URL (TM-1: a hostile workspace can set env). Require
 * https except for loopback dev. Returns the URL string or null if unusable.
 */
function validateBaseUrl(raw) {
  if (!raw) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const isLoopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1';
  if (u.protocol === 'https:' || (u.protocol === 'http:' && isLoopback)) return raw;
  return null;
}

/**
 * Resolve the service base URL -- T2.2 FULL (audit-trail tranche, Phase 3;
 * TM-4). The precedence used to be `REVIEWSVC_URL` (env -- set-able by a
 * workspace's `.claude/settings.json` `env` block) OVER
 * `CLAUDE_PLUGIN_OPTION_SERVICE_URL` (the plugin's `SERVICE_URL` userConfig,
 * which a workspace CANNOT set). That was backward from a security
 * standpoint: a malicious repo could redirect every review to an attacker's
 * server, whose `feedback` is then injected authoritatively into the session
 * (TM-1). Flipped: `CLAUDE_PLUGIN_OPTION_SERVICE_URL`, when set at all, is
 * the PIN and wins UNCONDITIONALLY -- `REVIEWSVC_URL` is ignored even if
 * present, and even if the pin itself fails validation (falling through to
 * the ignored env value on an invalid pin would defeat the pin's entire
 * purpose). `REVIEWSVC_URL` remains usable only when NO pin exists at all,
 * so a repo checkout with no plugin installed (dev, the smoke guides) still
 * works. Both paths run through the same validateBaseUrl (https-only except
 * loopback).
 *
 * Returns `{ url, envIgnored }`: `url` is the resolved base URL string or
 * null (unusable/unconfigured); `envIgnored` is true exactly when a pin
 * exists AND `REVIEWSVC_URL` was ALSO set, so a caller can surface a one-line
 * notice -- an ignored override must be VISIBLE, never a silent "why isn't my
 * env var doing anything" (the plan's explicit requirement).
 */
function resolveBaseUrl() {
  const pin = process.env.CLAUDE_PLUGIN_OPTION_SERVICE_URL;
  const envOverride = process.env.REVIEWSVC_URL;
  if (pin) {
    return { url: validateBaseUrl(pin), envIgnored: Boolean(envOverride) };
  }
  return { url: validateBaseUrl(envOverride), envIgnored: false };
}

// C15: a diff well over the target maxChars cap (200KB default) can still
// legitimately be MANY megabytes of raw `git diff` output before this
// function's own truncation runs. execFileSync's default maxBuffer is
// exactly 1 MiB, so a large-but-real diff used to throw ENOBUFS -- caught by
// the bare `catch` below and degraded to a silent `null` (the whole diff
// tier lost) BEFORE the maxChars truncation logic ever got a chance to run,
// unlike every diff between maxChars and 1 MiB, which truncated gracefully.
// A generous, bounded ceiling (well above any real maxChars this function is
// ever called with) closes that gap without buffering an unbounded amount of
// child-process output.
const MAX_GIT_OUTPUT_BYTES = 20 * 1024 * 1024; // 20 MiB

/**
 * List untracked (never `git add`-ed) files, relative to `cwd`. Uses
 * `--untracked-files=all` so an untracked DIRECTORY is expanded to its
 * individual files rather than reported as one directory entry, and NUL-
 * terminated porcelain output (`-z`) so filenames with spaces or unusual
 * characters parse unambiguously. Read-only: `git status` never touches the
 * index or working tree.
 */
// Filenames whose CONTENTS must never be attached as evidence. Deliberately a
// conservative, shape-based denylist rather than content scanning: a false
// positive costs one unreviewed file, a false negative ships a live credential
// to a third-party LLM. Applied to untracked files only -- those are inlined in
// full, whereas a tracked file contributes just its delta.
//
// NOT a security boundary. A determined workspace can still name a secret
// `notes.txt`; C5 says the client is untrusted and this does not change that.
// It removes the accident, not the attack.
const SECRET_PATH_RE = new RegExp(
  [
    '(^|/)\\.env($|\\.)', // .env, .env.local, .env.production
    '(^|/)\\.(netrc|npmrc|pypirc|pgpass|htpasswd)$',
    '(^|/)id_(rsa|dsa|ecdsa|ed25519)$', // ssh private keys
    '(^|/)\\.(ssh|aws|gnupg|kube|docker)/', // credential directories
    // whole basename only (+ optional single extension), so `credentials.json`
    // is withheld while `docs/secrets-design.md` is still reviewed
    '(^|/)(credentials|secrets?|service-account)(\\.[A-Za-z0-9]+)?$',
    '\\.(pem|key|p12|pfx|jks|keystore|ppk|asc)$',
  ].join('|'),
  'i',
);

function looksLikeSecretPath(relPath) {
  return SECRET_PATH_RE.test(relPath);
}

function listUntrackedFiles(cwd, opts) {
  try {
    const { execFileSync } = require('node:child_process');
    const out = execFileSync(
      'git',
      ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
      opts,
    );
    if (!out) return [];
    return out
      .split('\0')
      .filter((entry) => entry.startsWith('?? '))
      .map((entry) => entry.slice(3))
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Diff a single untracked file's on-disk content against nothing, via
 * `git diff --no-index -- /dev/null <path>`. This reads the file's bytes
 * only -- it never stages, indexes, or otherwise mutates the caller's repo
 * state. Deliberately NOT `git add -N` (intent-to-add): that would leave a
 * permanent trace in the user's index (the file would show as staged) for
 * the caller to notice and clean up, which the 2026-07-27 triage called
 * "unacceptable" for a background review hook to do to someone's working
 * tree. `git diff --no-index` exits 1 (not 0) whenever it finds a
 * difference -- which it always will here, since one side is empty -- so
 * execFileSync throws even on success; the diff text itself is still on the
 * thrown error's `.stdout`.
 */
function diffUntrackedFile(cwd, relPath, opts) {
  try {
    const { execFileSync } = require('node:child_process');
    const devNull = process.platform === 'win32' ? 'NUL' : '/dev/null';
    return execFileSync('git', ['diff', '--no-index', '--', devNull, relPath], opts);
  } catch (e) {
    if (e && typeof e.status === 'number' && e.status === 1 && typeof e.stdout === 'string') {
      return e.stdout;
    }
    return ''; // a genuine failure (unreadable file, race with deletion, etc.) -- skip it, never throw
  }
}

/**
 * Collect evidence of changes for the `diff` tier (ADR-001 amendment / T4.1):
 * a git diff when cwd is a repo, else null. Best-effort, bounded, never throws.
 * Returns { diff, truncated } or null.
 *
 * C15 fix: `git diff HEAD` alone never shows untracked (never `git add`-ed)
 * files at all, regardless of their content -- a session that CREATES a file
 * and never stages it sent zero evidence for that file. Each untracked
 * file's content is now appended via a separate `--no-index` diff (see
 * diffUntrackedFile above), which cannot mutate the caller's index.
 */
function collectDiff(cwd, maxChars = 200000) {
  if (!cwd) return null;
  try {
    const { execFileSync } = require('node:child_process');
    const opts = { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, maxBuffer: MAX_GIT_OUTPUT_BYTES };
    // include staged + unstaged; empty output => nothing to attach
    let diff = execFileSync('git', ['diff', 'HEAD'], opts);

    // Untracked files are included WHOLE (a new file is all-additions), unlike
    // tracked files which contribute only a delta. That is deliberate -- an agent
    // that creates new files should have them reviewed -- but it means any
    // untracked, non-gitignored file's full contents leave the machine, go to a
    // third-party judge, and are retained for the plan's window (up to 365 days).
    // Verified: an untracked `.env.local` shipped `OPENAI_API_KEY=...` verbatim.
    // gitignored files are already excluded (--exclude-standard semantics), which
    // covers the common case, but "untracked AND not gitignored" is exactly how a
    // freshly-created credentials file looks. Skip the well-known secret shapes.
    const untracked = listUntrackedFiles(cwd, opts).filter((p) => !looksLikeSecretPath(p));
    for (const relPath of untracked) {
      const fileDiff = diffUntrackedFile(cwd, relPath, opts);
      if (fileDiff) diff += (diff && !diff.endsWith('\n') ? '\n' : '') + fileDiff;
    }

    if (!diff || !diff.trim()) return null;
    if (diff.length > maxChars) return { diff: diff.slice(0, maxChars), truncated: true };
    return { diff, truncated: false };
  } catch {
    return null; // not a repo / git absent / timeout -> fall back to minimal tier
  }
}

// Per-line target cap for the `trace` tier (T-tier / trace-tier tranche).
// Deliberately short: a Bash command can carry secrets in its flags, and
// every other tool's target (a file path, a grep pattern, a URL) is more
// useful as a recognizable head than as a full string. Stated here so the
// judge prompt/docs can cite one number instead of a magic constant.
const TRACE_TARGET_CAP = 100;

// Fields tried, in order, to build a short "target" for a tool_use block,
// keyed by exact tool name. Only the FIRST present string field is used.
// Deliberately narrow (never the whole `input` object): ADR-009 requires a
// short target, not a dump of every argument the model passed.
const TRACE_TARGET_FIELDS = {
  Bash: ['command'],
  Read: ['file_path'],
  Write: ['file_path'],
  Edit: ['file_path'],
  NotebookEdit: ['notebook_path', 'file_path'],
  Grep: ['path', 'pattern'],
  Glob: ['path', 'pattern'],
  WebFetch: ['url'],
  WebSearch: ['query'],
  Agent: ['description'],
  Task: ['description'],
  Skill: ['skill'],
  ToolSearch: ['query'],
};
// Fallback field order for a tool name not in TRACE_TARGET_FIELDS (e.g. an
// mcp__* tool) -- tries the most common single-string argument shapes before
// giving up. Never falls back to JSON.stringify(input): an unrecognized
// tool's full argument object could contain anything, and ADR-009 requires a
// short target, not "whatever was easiest to extract."
const TRACE_TARGET_FALLBACK_FIELDS = [
  'command',
  'file_path',
  'path',
  'pattern',
  'url',
  'query',
  'description',
  'skill',
  'prompt',
  'name',
];

/** Collapse newlines/whitespace and hard-cap a target string to TRACE_TARGET_CAP. */
function capTraceTarget(s) {
  const flat = String(s).replace(/\s+/g, ' ').trim();
  return flat.length > TRACE_TARGET_CAP ? `${flat.slice(0, TRACE_TARGET_CAP)}…` : flat;
}

/**
 * Short, redacted target string for one tool_use block (T-tier). Tries the
 * tool-specific field list first, then a generic fallback list, and never
 * the raw `input` object -- this function is the ADR-009 redaction boundary
 * for tool CALL arguments (tool RESULT bodies are never even read -- see
 * collectTrace below).
 */
function traceTarget(name, input) {
  const obj = input && typeof input === 'object' ? input : {};
  const fields = TRACE_TARGET_FIELDS[name] || TRACE_TARGET_FALLBACK_FIELDS;
  for (const f of fields) {
    const v = obj[f];
    if (typeof v === 'string' && v.length > 0) return capTraceTarget(v);
  }
  return '(no target)';
}

/**
 * Collect a summarized trace from a Claude Code JSONL transcript (T-tier /
 * trace-tier tranche): the third payload tier ADR-001 defines the
 * claims-vs-evidence rubric in terms of ("does the trace support what the
 * final message asserts") but that, until now, the client never produced.
 *
 * ADR-009 (the load-bearing constraint here): a trace is a SUMMARY, never raw
 * tool output. This function reads each transcript line, and for every
 * `tool_use` content block emits exactly one line:
 *   `<tool name> <short target> -> <ok|error>`
 * It NEVER reads a `tool_result` block's `content` (the actual command
 * output / file contents / env) -- only whether the matching result carried
 * `is_error: true`. That is the entire redaction boundary: no code path in
 * this function ever touches a tool result body, so there is nothing to
 * accidentally leak regardless of what a tool happened to return.
 *
 * C5 (adversarial review 2026-07-27) -- read this before assuming `-> ok`
 * means "the command succeeded": `is_error` is the wrapper's/harness's own
 * exit-status bit, not a judgment about the command's actual result. A
 * piped command (`npx vitest run 2>&1 | grep FAIL | head -40`), a `|| true`,
 * or a redirect can all make a genuinely FAILING command report
 * `is_error: false` -- because the wrapper's own exit code is 0 even though
 * the real command failed. `-> ok` in the emitted line therefore means only
 * "the tool call itself did not error", never "the command's output
 * indicated success". Do not add logic here to fix this by reading tool
 * output (that would cross the ADR-009 redaction boundary this function
 * exists to enforce) -- the fix lives in the judge prompt instead
 * (packages/judge/src/prompt-text.ts / benchmark/judge/judge-v0.md), which
 * now states this caveat explicitly so a claim about a command's RESULT is
 * never treated as corroborated by an `-> ok` line alone.
 *
 * The real transcript schema (learned from an actual Claude Code session
 * JSONL, not guessed -- docs/00-feasibility-report.md's caveat "the schema is
 * internal and not a stability contract" holds) is parsed defensively: each
 * line is independently JSON.parsed and skipped on failure (a lagging writer
 * can leave a half-flushed final line; unrelated line shapes like
 * `queue-operation`/`attachment`/`mode` are silently ignored since they carry
 * no `message.content` array).
 *
 * Fail-soft (global constraint / F10): any read/parse error, or a transcript
 * with no extractable tool calls at all, returns null so review.js falls
 * back to the diff tier, then minimal -- never throws.
 *
 * Newest-last ordering (transcripts are append-only, so this is just file
 * order); when the joined trace exceeds maxChars, the EARLIEST entries are
 * dropped first so the LAST N survive -- recent actions are what the
 * claims-vs-evidence check is about.
 */
function collectTrace(transcriptPath, maxChars = 100000) {
  if (!transcriptPath) return null;
  try {
    const raw = fs.readFileSync(transcriptPath, 'utf8');
    const rawLines = raw.split('\n');
    const toolUses = []; // { id, name, input } in file order
    const outcomes = new Map(); // tool_use_id -> true (is_error)

    for (const line of rawLines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry;
      try {
        entry = JSON.parse(trimmed);
      } catch {
        continue; // malformed line -- skip, keep parsing the rest
      }
      const content = entry && entry.message && entry.message.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'tool_use') {
          if (typeof block.name === 'string' && block.name) {
            toolUses.push({ id: block.id, name: block.name, input: block.input });
          }
        } else if (block.type === 'tool_result') {
          if (typeof block.tool_use_id === 'string') {
            outcomes.set(block.tool_use_id, block.is_error === true);
            // NOTE: block.content (the actual result body) is intentionally
            // never read here -- see the ADR-009 note in this function's doc
            // comment above.
          }
        }
      }
    }

    if (toolUses.length === 0) return null;

    const lines = toolUses.map((tu) => {
      const isError = outcomes.get(tu.id) === true;
      return `${tu.name} ${traceTarget(tu.name, tu.input)} -> ${isError ? 'error' : 'ok'}`;
    });

    let truncated = false;
    let kept = lines;
    if (kept.join('\n').length > maxChars) {
      truncated = true;
      while (kept.length > 1 && kept.join('\n').length > maxChars) {
        kept = kept.slice(1);
      }
      let joined = kept.join('\n');
      if (joined.length > maxChars) joined = joined.slice(joined.length - maxChars);
      return { trace: joined, truncated };
    }
    return { trace: kept.join('\n'), truncated };
  } catch {
    return null; // missing/unreadable transcript -> fall back to diff/minimal (F10)
  }
}

/**
 * T3.4 fix (audit-trail tranche, Phase 4): resolve the (session_id,
 * prompt_id) round-keying id used both for the real review payload and any
 * bypass report. Before this fix, an absent `prompt_id` (both the Stop
 * event's own copy AND the one captured back at UserPromptSubmit time
 * missing) collapsed to the literal `'unknown'` for the WHOLE SESSION, so
 * every distinct prompt asked in that session shared one (session_id,
 * 'unknown') round-counting bucket, and round counting degraded across
 * genuinely different asks.
 *
 * Falls back through three tiers:
 *   1. `evtPromptId` -- the Stop event's own id, when present.
 *   2. `captured.prompt_id` -- the id captured back at UserPromptSubmit time
 *      (capture-prompt.js), in case the Stop event's own copy is missing but
 *      an earlier hook still saw one.
 *   3. A stable per-prompt SURROGATE: sha256(`${sessionId}:${capturedPrompt}`)
 *      truncated to 16 hex chars (matching this file's other short-hash
 *      markers, e.g. idempotencyKey) -- keyed on the session id too, so the
 *      SAME prompt text asked in two DIFFERENT sessions still gets distinct
 *      keys. Two DIFFERENT prompts in one session get different surrogates;
 *      repeated Stop events for the SAME prompt (a retry, or round 2+ of one
 *      multi-round flow) stay stable, since the captured prompt text never
 *      changes mid-flow (capture-prompt.js captures the FIRST prompt only).
 *   4. The literal `'unknown'` -- the true last resort, only when there is no
 *      captured prompt at all to derive a surrogate from.
 *
 * The surrogate is a one-way hash, so per ADR-009 it never contains the
 * prompt text itself, regardless of what the prompt asked.
 */
function resolvePromptId(sessionId, evtPromptId, captured) {
  if (typeof evtPromptId === 'string' && evtPromptId) return evtPromptId;
  if (captured && typeof captured.prompt_id === 'string' && captured.prompt_id) return captured.prompt_id;
  if (captured && typeof captured.prompt === 'string' && captured.prompt) {
    return crypto.createHash('sha256').update(`${sessionId}:${captured.prompt}`).digest('hex').slice(0, 16);
  }
  return 'unknown';
}

/**
 * Idempotency key for POST /v1/review (Phase 3 / T3.3; fixed for F6). Used to
 * be a hardcoded `${sessionId}:${promptId}:1` -- the trailing `1` never
 * incremented, so the SECOND Stop for one (session, prompt) -- exactly what
 * round 2 of a multi-round flow is -- sent a byte-identical key to round 1's,
 * and the server replayed round 1's stored verdict instead of judging the
 * revised final_message (rounds.used stuck at 1 forever in production).
 *
 * The key must be STABLE for a genuine retry (a lost response resent with the
 * identical payload) but DIFFERENT across rounds. A hash of the exact payload
 * being judged satisfies both: a real retry re-sends byte-identical
 * tier/initial_prompt/final_message/diff, while a new round always carries at
 * least a different final_message. Hashed rather than raw per ADR-009 -- the
 * key itself must never carry payload content. Truncated to 16 hex chars,
 * matching this repo's other short-hash markers (e.g. authActions.ts's
 * token_prefix) -- collision risk is irrelevant here since a collision only
 * ever causes an extra replay, never a security decision.
 */
function idempotencyKey(sessionId, promptId, payload) {
  const hash = crypto
    .createHash('sha256')
    .update(JSON.stringify([payload.tier, payload.initial_prompt, payload.final_message, payload.diff || '']))
    .digest('hex')
    .slice(0, 16);
  return `${sessionId}:${promptId}:${hash}`;
}

/**
 * Detect execution surface for payload metadata (best effort).
 * NOTE (review T4.5): local-VM and cloud-remote Cowork sandboxes report an
 * identical fingerprint (linux, hostname 'vm'); they are indistinguishable from
 * inside the hook, so both map to 'cowork-vm'. `cowork-remote` is therefore never
 * returned. A non-sandbox, non-desktop process defaults to 'code-cli'.
 */
function detectSurface() {
  if (process.platform === 'linux' && os.hostname() === 'vm') return 'cowork-vm';
  if (process.env.CLAUDE_CODE_ENTRYPOINT === 'claude-desktop') return 'code-desktop';
  return 'code-cli';
}

module.exports = {
  PLUGIN_VERSION,
  readStdinJson,
  stateDir,
  checkStateDirOwnership,
  readPluginName,
  safeSessionId,
  firstPromptPath,
  findToken,
  emitSystemMessage,
  sanitizeFeedback,
  validateBaseUrl,
  resolveBaseUrl,
  collectDiff,
  looksLikeSecretPath,
  collectTrace,
  detectSurface,
  resolvePromptId,
  shouldShowQuotaNotice,
  idempotencyKey,
};
