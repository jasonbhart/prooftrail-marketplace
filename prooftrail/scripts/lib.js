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

function gateOfferMarkerPath(sessionId, nowMs) {
  return path.join(stateDir(), `gate-offer-${safeSessionId(sessionId)}-${utcDateStr(nowMs)}.json`);
}

/**
 * The documented-command offer is capped at once per (session_id, UTC day),
 * exactly like the quota notice above and for the same reason: the Stop loop
 * runs on EVERY turn, so anything unthrottled there becomes nagware. The offer
 * is additionally only produced when the engine can check nothing at all (see
 * `runLocalRules`), so a user with a working gate never sees it.
 *
 * Same atomic mark-and-check via exclusive create, and the same fail-soft
 * default -- but inverted. Where the quota notice defaults to SHOWING on an fs
 * error (missing a paid-quota warning is worse than repeating it), an
 * unsolicited suggestion defaults to STAYING SILENT. Erring toward noise is
 * only correct when the message is something the user needs.
 */
function shouldShowGateOffer(sessionId, nowMs = Date.now()) {
  try {
    fs.writeFileSync(gateOfferMarkerPath(sessionId, nowMs), '1', { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

function connectNoticeMarkerPath(sessionId, nowMs) {
  return path.join(stateDir(), `connect-notice-${safeSessionId(sessionId)}-${utcDateStr(nowMs)}.json`);
}

/**
 * Task 5: with local rule definitions removed, an unconnected install performs
 * no checks at all -- there is no cache, so `rulesFromCache` returns nothing.
 * That is worth saying, but the Stop loop runs every turn, so it is capped at
 * once per (session_id, UTC day) exactly like the gate offer above, and for
 * the same reason and with the same fail-soft default: an unsolicited notice
 * defaults to STAYING SILENT on an fs error rather than repeating forever.
 */
function shouldShowConnectNotice(sessionId, nowMs = Date.now()) {
  try {
    fs.writeFileSync(connectNoticeMarkerPath(sessionId, nowMs), '1', { flag: 'wx' });
    return true;
  } catch {
    return false;
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
  // Lowest precedence: a workspace token file, .prooftrail/auth.json, in an
  // EXPLICITLY MOUNTED user directory. This is the Cowork workaround
  // (2026-07-29): sandbox plugin data is wiped between sessions and #39455
  // blocks the settings editor everywhere, but attached project files travel
  // with the user -- pair once, drop the file in the mounted project, and every
  // session finds it. SECRET_PATH_RE excludes .prooftrail/ so collectDiff can
  // never ship it to the judge, and ADR-007 holds: the value never transits chat.
  //
  // SECURITY (fix 2026-07-30): this used to ALSO walk four cwd ancestors, which
  // made any cloned repository a credential source. A hostile repo shipping
  // .prooftrail/auth.json handed a working token to any unpaired user who
  // cloned it and started a session there -- their prompts, diffs and traces
  // would be judged under the ATTACKER's account, and the findings, which quote
  // the victim's requirements and claims, would land on the attacker's
  // dashboard. The original reasoning covered the OUTBOUND direction (never
  // ship this file to the judge) and never the inbound one (never TRUST a file
  // the workspace supplies). CLAUDE_ADDITIONAL_DIRECTORIES is set by the
  // harness from what the USER attached, not by repo content, and it is the
  // only case the Cowork workaround ever needed -- so the walk is gone rather
  // than narrowed. Same class as the resolveBaseUrl pin (TM-4): repo content
  // must never steer where the client sends data, or which credential it uses.
  const candidates = [];
  for (const d of String(process.env.CLAUDE_ADDITIONAL_DIRECTORIES || '').split(':')) {
    if (d) candidates.push(d);
  }
  for (const d of candidates) {
    try {
      const f = path.join(d, '.prooftrail', 'auth.json');
      if (fs.existsSync(f)) {
        const t = JSON.parse(fs.readFileSync(f, 'utf8')).token;
        if (t) return t;
      }
    } catch {
      /* malformed or unreadable -- keep looking, fail-soft */
    }
  }
  return null;
}

/** Emit a hook systemMessage (the only user-visible channel we use in advisory mode). */
function emitSystemMessage(text) {
  process.stdout.write(JSON.stringify({ systemMessage: text }));
}

/**
 * Write the hook's single JSON object, routing each part to the audience that
 * can actually act on it.
 *
 * The three channels are NOT interchangeable, and conflating them is why
 * findings went nowhere until 2026-07-31:
 *
 * - `systemMessage` — **the user only.** Documented as "Warning message shown
 *   to the user". Everything this plugin emitted went here, so the agent never
 *   learned it had broken a rule; the human had to relay it.
 * - `hookSpecificOutput.additionalContext` — **the model**, without an error
 *   label and without preventing the turn from ending. The binary's own schema
 *   calls this "the sanctioned feedback channel", kept separate from
 *   `hook_errors` precisely so it is not read as a failure.
 * - `decision: "block"` + `reason` — **the model**, and the turn cannot end.
 *   Powerful and dangerous: anthropics/claude-code#55754 records a blocking
 *   Stop hook running ~50 minutes and consuming an entire session quota because
 *   the agent structurally could not satisfy it. Callers must gate this.
 *
 * Exactly one object is written, because the hook protocol is one JSON object
 * per invocation — two writes produce a parse error, not two messages.
 */
function emitHookOutput({ systemMessage, additionalContext, blockReason } = {}) {
  const out = {};
  if (systemMessage) out.systemMessage = systemMessage;
  if (additionalContext) {
    out.hookSpecificOutput = { hookEventName: 'Stop', additionalContext };
  }
  if (blockReason) {
    out.decision = 'block';
    out.reason = blockReason;
  }
  if (Object.keys(out).length === 0) return false;
  process.stdout.write(JSON.stringify(out));
  return true;
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
/** The shipped manifest's userConfig.SERVICE_URL.default, or null. Same
 * read-from-manifest pattern as readPluginVersion(): the default travels with
 * the BUILD, not the source, so dev and tests (no shipped manifest) see no
 * default and self-hosters can strip it from their build. Decision 2026-07-29
 * (Cowork workaround design): the hosted URL is not a secret and is identical
 * for every customer, and sandboxes have no working settings editor (#39455) —
 * a baked default with override preserved beats "required, no default". */
function readManifestServiceUrlDefault() {
  const roots = [
    process.env.CLAUDE_PLUGIN_ROOT && path.join(process.env.CLAUDE_PLUGIN_ROOT, '.claude-plugin', 'plugin.json'),
    path.join(__dirname, '..', '.claude-plugin', 'plugin.json'),
  ].filter(Boolean);
  for (const p of roots) {
    try {
      const d = JSON.parse(fs.readFileSync(p, 'utf8'))?.userConfig?.SERVICE_URL?.default;
      if (typeof d === 'string' && d) return d;
    } catch {
      /* try next */
    }
  }
  return null;
}

function resolveBaseUrl() {
  const pin = process.env.CLAUDE_PLUGIN_OPTION_SERVICE_URL;
  const envOverride = process.env.REVIEWSVC_URL;
  if (pin) {
    return { url: validateBaseUrl(pin), envIgnored: Boolean(envOverride) };
  }
  if (envOverride) {
    return { url: validateBaseUrl(envOverride), envIgnored: false };
  }
  // Lowest precedence: the built-in default. validateBaseUrl still applies —
  // an invalid default is rejected, never trusted.
  return { url: validateBaseUrl(readManifestServiceUrlDefault()), envIgnored: false };
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
    '(^|/)\\.prooftrail/', // our own workspace token file (Cowork workaround) -- never ship it to the judge
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

/**
 * Verification predicates (ALT-1, 2026-07-30) -- why this exists.
 *
 * exp-10 and exp-11 independently measured the same failure: the judge cannot
 * RETRIEVE a verification fact out of a 20 000-char trace. exp-10 showed a
 * corroborating run-line that is present byte-for-byte gets missed once the
 * trace reaches production size (false-block 0% -> 7.7-15.4%). exp-11 showed
 * planted claims-vs-evidence defects caught 0/39 at production payload. The
 * judge prompt already STATES all three rules (uncorroborated / contradicted /
 * stale) -- so this was never a rubric gap, it is a needle-in-a-haystack
 * problem. The fix is to stop asking the model to find the needle: classify
 * the command HERE, where the full text still exists, and let the service
 * derive structured predicates the judge reads instead of searching for.
 *
 * Why the classification must happen in the client and not in the service:
 * the trace target is hard-capped at TRACE_TARGET_CAP (100) chars, and real
 * commands are compound -- `cd ~/proj && ... && npx vitest run`. Measured over
 * the archived exp-09 transcripts: 93.6% of Bash calls exceed the cap, and
 * classifying the CAPPED target instead of the full command loses 71.2% of the
 * real verification signal. A predicate derived from the capped trace would
 * therefore attest "no test ran" on most sessions where one did -- the exact
 * shape of the diff_files: [] regression that once blocked 43 of 57 good
 * sessions by asserting a falsehood in the one block the judge must trust.
 *
 * ADR-009 is not weakened: this reads the command ARGUMENT (already summarized
 * into the trace, in capped form) and emits a fixed category label. It never
 * touches a tool RESULT body, so the redaction boundary is unchanged -- and the
 * label is strictly less information than the capped target it accompanies.
 */
const COMMAND_CATEGORIES = [
  ['test', /(?:^|[\s;&|(])(?:npx |pnpm |yarn |bun )?(?:vitest|jest|pytest|mocha|ava)(?![\w-])|(?:npm|pnpm|yarn|bun) (?:run )?test(?![\w-])|cargo test(?![\w-])|go test(?![\w-])|(?:^|[\s;&|(])(?:phpunit|rspec)(?![\w-])/i],
  ['typecheck', /tsc(?![\w-])[^;&|]*--noEmit|(?:npm|pnpm|yarn) run (?:typecheck|check-types)(?![\w-])|(?:^|[\s;&|(])mypy(?![\w-])/i],
  ['build', /(?:npm|pnpm|yarn|bun) run build(?![\w-])|cargo build(?![\w-])|go build(?![\w-])|(?:^|[\s;&|(])tsc(?![\w-])|(?:^|[\s;&|(])make(?![\w-])/i],
  ['lint', /(?:^|[\s;&|(])(?:npx )?(?:eslint|ruff|flake8|clippy|prettier|biome)(?![\w-])|(?:npm|pnpm|yarn) run lint(?![\w-])/i],
  // The gap excludes newlines as well as `;&|` so `git` and its subcommand must
  // be the same shell invocation -- otherwise `git log` on one line could pair
  // with the bare word `commit` several lines later in a multi-line script.
  ['vcs', /\bgit(?![\w-])[^;&|\n]{0,160}?\b(?:commit|push|merge)(?![\w-])/i],
  ['deploy', /\bconvex (?:deploy|dev)(?![\w-])|\bwrangler (?:deploy|publish)(?![\w-])|\bnpm publish(?![\w-])|\bfly deploy(?![\w-])|\bvercel (?:deploy|--prod)(?![\w-])/i],
];

/**
 * Replace every quoted span with whitespace, tracking quote state in a single
 * left-to-right pass rather than pairing quotes with a regex (regex pairing
 * mis-handles `-m "don't do this"` whichever quote style you strip first).
 *
 * This is what stops PROSE from being classified as an executed command.
 * Measured false positives on real archived commands, all three from text that
 * was written, never run: `git commit -m "...requires a coupled Worker+Convex
 * deploy"` classified as `deploy`; a commit message quoting the shell snippet
 * `npx vitest run ... && git commit && git merge` classified as `test`+`vcs`;
 * and `**Goal:** make reviews work...` inside a heredoc classified as `build`.
 *
 * An unterminated quote drops the remainder of the string. That is the safe
 * direction on purpose: a MISSING tag costs a catch, a WRONG tag corrupts the
 * one block the judge is told to trust absolutely.
 */
function stripQuotedSpans(s) {
  let out = '';
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === '\\' && quote === '"') { i++; continue; } // escaped char inside "..."
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; out += ' '; continue; }
    out += ch;
  }
  return out;
}

// `<<EOF` / `<<'EOF'` / `<<-EOF` ... terminator on its own line. Heredoc bodies
// are the single largest source of prose inside a command string (writing a
// doc, appending to a progress file), so they are removed before anything else.
const HEREDOC_RE = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[\s\S]*?^[\t ]*\2[\t ]*$/gm;
const HEREDOC_UNTERMINATED_RE = /<<-?\s*(['"]?)[A-Za-z_][A-Za-z0-9_]*\1[\s\S]*$/;

/**
 * The executable skeleton of a command: heredoc bodies and quoted spans
 * removed, so only text the shell would actually run as words remains.
 */
function commandSkeleton(cmd) {
  let s = String(cmd);
  s = s.replace(HEREDOC_RE, ' ');
  s = s.replace(HEREDOC_UNTERMINATED_RE, ' '); // truncated/unclosed -> drop the tail
  return stripQuotedSpans(s);
}

/**
 * Categories this command belongs to, in COMMAND_CATEGORIES order, or [] when
 * it is not a verification command. Classifies the SKELETON, never the raw
 * string (see commandSkeleton).
 */
function classifyCommand(cmd) {
  if (typeof cmd !== 'string' || !cmd) return [];
  const skeleton = commandSkeleton(cmd);
  const out = [];
  for (const [name, re] of COMMAND_CATEGORIES) {
    if (re.test(skeleton)) out.push(name);
  }
  return out;
}

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
/**
 * Parse a transcript into ordered tool calls and their error outcomes.
 *
 * Factored out of `collectTrace` so the LOCAL rules engine (src/rules.js) can
 * read the same structure without a second full parse, and -- the reason it
 * matters -- without the 100-char target cap `collectTrace` applies for
 * transport. Measured over the archived transcripts, 93.6% of Bash calls
 * exceed that cap and classifying the capped text loses 71.2% of real
 * verification signal, so anything evaluating a rule must see the FULL
 * command. That asymmetry is the entire architectural argument for computing
 * locally: this data cannot be reconstructed from any payload the service is
 * permitted to receive.
 *
 * Returns `null` on a missing/unreadable transcript or one with no tool calls
 * -- never throws (F10 fail-soft, same contract as its callers).
 *
 * ADR-009: `block.content` (the tool result BODY) is never read here, by
 * construction rather than by filtering. Only `is_error` is.
 */
function parseTranscript(transcriptPath) {
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
            // never read here -- see the ADR-009 note above.
          }
        }
      }
    }

    if (toolUses.length === 0) return null;
    return { toolUses, outcomes };
  } catch {
    return null; // missing/unreadable transcript (F10)
  }
}

/**
 * `preParsed` lets a caller that has ALREADY run `parseTranscript` reuse the
 * result rather than re-reading the transcript. review.js needs the same parse
 * for the local rules engine, and real transcripts reach 15 MB -- parsing twice
 * per Stop hook costs ~200ms for nothing. Omitted, this parses as before.
 */
function collectTrace(transcriptPath, maxChars = 100000, preParsed) {
  try {
    const parsed = preParsed || parseTranscript(transcriptPath);
    if (!parsed || !Array.isArray(parsed.toolUses) || parsed.toolUses.length === 0) return null;
    const { toolUses, outcomes } = parsed;

    // Verification tag (ALT-1): classified from the FULL command, emitted next
    // to the CAPPED target. The tag has to be produced here because 93.6% of
    // real Bash calls exceed TRACE_TARGET_CAP and the verification verb is
    // usually past the cut -- see the COMMAND_CATEGORIES note above.
    const lines = toolUses.map((tu) => {
      const isError = outcomes.get(tu.id) === true;
      const cats = classifyCommand(tu.input && tu.input.command);
      const tag = cats.length > 0 ? `[${cats.join(',')}] ` : '';
      return `${tu.name} ${tag}${traceTarget(tu.name, tu.input)} -> ${isError ? 'error' : 'ok'}`;
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
      // `classified` says only "a classifying collector produced this trace",
      // never "verification was found". The service needs that distinction to
      // tell an OLD client (tags impossible -> predicates unknown) apart from a
      // new client that simply saw no verification commands (-> predicates
      // genuinely empty). Without it, every pre-ALT-1 client would silently
      // attest "nothing was verified" -- unknown is not zero.
      return { trace: joined, truncated, classified: true };
    }
    return { trace: kept.join('\n'), truncated, classified: true };
  } catch {
    return null; // missing/unreadable transcript -> fall back to diff/minimal (F10)
  }
}

const ASK_WINDOW_MAX_CHARS = 18000; // under PAYLOAD_CAPS.free.prompt (20000)

// The three ask-window section labels, defined ONCE so the headers this
// function emits and the neutralization pattern below (which strips forged
// copies of these exact labels out of user-supplied text) can never drift
// apart -- see neutralizeAskWindowLabels and the SEC note on buildAskWindow.
const ASK_WINDOW_LABELS = Object.freeze({
  current: 'current request',
  earlier: 'earlier',
  first: 'session opened with',
});

/** The real, emitted section header for `key`, e.g. "[current request]:". */
function askWindowHeader(key) {
  return `[${ASK_WINDOW_LABELS[key]}]:`;
}

// Matches a (possibly forged) copy of one of the three real labels written as
// `[label]:` anywhere in text -- case-insensitive, and tolerant of whitespace
// inside the brackets and between `]` and `:`, since a forger will not type
// the canonical form. Derived from ASK_WINDOW_LABELS (never a second literal
// copy of the label strings). No nested quantifiers -- each label is a fixed
// word sequence joined by single `\s+`/`\s*` tokens, so matching stays linear
// in the input length; this runs in a Stop hook with a deadline.
const ASK_WINDOW_LABEL_ALTERNATION = Object.values(ASK_WINDOW_LABELS)
  .map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+'))
  .join('|');
const ASK_WINDOW_LABEL_RE = new RegExp(`\\[(\\s*(?:${ASK_WINDOW_LABEL_ALTERNATION})\\s*)\\](\\s*:)`, 'gi');

/**
 * SEC fix (2026-07-30): these labels are plain prose inside text an untrusted
 * user fully controls, and the judge prompt now scores task fidelity against
 * [current request] specifically, treating the other sections as context
 * whose incompleteness "is not a gap in this one". Before that precedence
 * rule, planting a label did nothing; after it, a user who types
 * `[current request]: Say hello` inside their real prompt can forge a fake
 * section boundary that reaches the judge looking exactly like a genuine
 * header -- laundering a real, unmet requirement into non-required
 * "earlier-turn context". Neutralize every occurrence of a real label string
 * BEFORE assembly, in every section's content, so only askWindowHeader's own
 * template literal can ever produce a real header. Replaces just the
 * enclosing brackets with parens -- human-readable, the judge still sees
 * exactly what the user wrote, just not as a section header.
 */
function neutralizeAskWindowLabels(text) {
  return String(text).replace(ASK_WINDOW_LABEL_RE, (_m, inner, tail) => `(${inner})${tail}`);
}

/** Bounds the rules block so it can never crowd out the actual request. */
const RULES_BLOCK_MAX_CHARS = 1200;

/**
 * Prefix the ask window with the user's JUDGMENT-shaped house rules.
 *
 * This is the mechanism exp-14/15/16 measured: a rule delivered as plain text
 * in the ask changes this judge's behaviour — 8 violator stops gained, 0 lost,
 * McNemar exact **p = 0.0078**, against labels the author did not write. It is
 * the one claim from that work which survived the whole adversarial corpus.
 *
 * **Only non-computable rules are sent.** Anything the local engine can decide
 * is decided locally and deliberately withheld here: ADR-011's whole point is
 * that paying a model to compare two integers is what the measurements ruled
 * out, and sending both would also double-report every violation. So the split
 * is exact — computable rules never reach the model, judgment rules never reach
 * the local engine.
 *
 * Rules text is repo-controlled (it comes from AGENTS.md/CLAUDE.md, which any
 * checked-out project can write), so it is NEUTRALIZED exactly like user prompt
 * text before assembly. Without that, a repo could type `[current request]:`
 * into its own rules file and launder a real gap — the same attack the ask
 * window's label neutralization exists to stop, arriving through a new door.
 * The judge prompt already treats `initial_prompt` as untrusted data, never as
 * instructions; this keeps that true.
 *
 * Returns `window` unchanged when there are no judgment rules to add.
 */
function prependHouseRules(window, rules) {
  if (!window || !Array.isArray(rules) || rules.length === 0) return window;
  const lines = [];
  let used = 0;
  for (const r of rules) {
    const text = neutralizeAskWindowLabels(String((r && r.text) || '').trim());
    if (!text) continue;
    const line = `- ${text}`;
    if (used + line.length > RULES_BLOCK_MAX_CHARS) break;
    used += line.length + 1;
    lines.push(line);
  }
  if (lines.length === 0) return window;
  return `(house rules — the work is not complete unless these hold):\n${lines.join('\n')}\n\n${window}`;
}

/**
 * Assemble the labeled ask window sent as `initial_prompt`.
 *
 * ORDER IS LOAD-BEARING: the current request comes FIRST. Server-side
 * truncation is `initialPrompt.slice(0, caps.prompt)` -- it keeps the HEAD --
 * so an opening-ask-first window that exceeded the cap would have the current
 * request silently deleted, leaving the judge to score fidelity against stale
 * context only. That is a worse version of the bug this window exists to fix.
 * The 18000 cap here means the server's truncation should never engage at all;
 * the ordering is the belt to that braces.
 *
 * Accepts BOTH state-file shapes. A file written by an older capture-prompt.js
 * has only a top-level `prompt` -- the runtime re-syncs plugins mid-session, so
 * a new reader really does meet old files.
 */
function buildAskWindow(captured) {
  if (!captured || typeof captured !== 'object') return '';
  const first =
    captured.first && typeof captured.first.prompt === 'string'
      ? captured.first.prompt
      : typeof captured.prompt === 'string'
        ? captured.prompt
        : '';
  const recent = Array.isArray(captured.recent)
    ? captured.recent.filter((r) => r && typeof r.prompt === 'string').map((r) => r.prompt)
    : [];

  const latest = recent.length ? recent[recent.length - 1] : first;
  if (!latest) return '';
  // Single-turn session: byte-identical to the pre-window behaviour, aside
  // from label neutralization -- this bare-prompt path is unlabeled and
  // reaches the judge verbatim, which is exactly where the attack above
  // lands, and it is easy to miss because it returns early.
  if (!recent.length || (recent.length === 1 && latest === first)) {
    return neutralizeAskWindowLabels(first || latest);
  }

  const earlier = recent.length >= 2 ? recent[recent.length - 2] : null;

  // Built bottom-droppable: sections are appended most-important first, and we
  // stop before exceeding the cap rather than slicing mid-section. Dedup
  // comparisons below use the RAW (pre-neutralization) strings -- neutralizing
  // is deterministic, so this changes nothing about which sections get
  // emitted, only what their content looks like once emitted.
  const sections = [`${askWindowHeader('current')} ${neutralizeAskWindowLabels(latest)}`];
  // FINDING 2: only emit [earlier] when it actually differs from the current
  // request -- otherwise a user repeating the same text on consecutive turns
  // gets it printed twice under two labels. Mirrors the guard already applied
  // to [session opened with] below.
  if (earlier && earlier !== latest) sections.push(`${askWindowHeader('earlier')} ${neutralizeAskWindowLabels(earlier)}`);
  if (first && first !== latest && first !== earlier) sections.push(`${askWindowHeader('first')} ${neutralizeAskWindowLabels(first)}`);

  // FINDING 1: the current-request section is the one thing this function
  // exists to preserve (see the ORDER IS LOAD-BEARING note above), so unlike
  // the later context sections it must be TRUNCATED to fit when oversized,
  // never dropped whole. Without this, a first (and only, at this point)
  // section alone exceeding ASK_WINDOW_MAX_CHARS would make the assembly loop
  // below break on iteration one -- `out` never gets assigned, and the whole
  // window returns '', silently losing exactly what the judge scores. Today
  // that is reachable only because capture-prompt.js independently caps every
  // captured prompt at MAX_PROMPT_CHARS (6000) -- an invariant enforced in a
  // DIFFERENT file. This branch makes the guarantee self-sufficient: it must
  // hold even if that cap is later raised or removed.
  if (sections[0].length > ASK_WINDOW_MAX_CHARS) {
    sections[0] = sections[0].slice(0, ASK_WINDOW_MAX_CHARS);
  }

  let out = '';
  for (const s of sections) {
    const next = out ? `${out}\n\n${s}` : s;
    if (next.length > ASK_WINDOW_MAX_CHARS) break;
    out = next;
  }
  return out;
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
 *
 * `trace` joined the hashed tuple 2026-07-30. It had been omitted while the
 * server's contentHash included it, so a second Stop with an identical final
 * message and diff replayed the stored verdict and the NEW trace was never
 * judged -- evidence silently swallowed, bounded to 48h by IDEMPOTENCY_TTL_MS.
 */
function idempotencyKey(sessionId, promptId, payload) {
  const hash = crypto
    .createHash('sha256')
    .update(JSON.stringify([payload.tier, payload.initial_prompt, payload.final_message, payload.diff || '', payload.trace || '']))
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
  // Prefer the explicit entrypoint over the hostname heuristic. exp-08 captured
  // CLAUDE_CODE_ENTRYPOINT=remote_cowork in a real cloud sandbox; `hostname ===
  // 'vm'` happens to work there too, but it would misclassify any host actually
  // named "vm" and would miss a sandbox whose hostname changes. This is
  // load-bearing, not cosmetic: the sandbox-specific findings tell the user that
  // Cowork cannot be configured yet (#39455), and a misclassified sandbox would
  // instead be told to run /prooftrail:setup — a remedy that cannot work there.
  if (process.env.CLAUDE_CODE_ENTRYPOINT === 'remote_cowork') return 'cowork-vm';
  if (process.platform === 'linux' && os.hostname() === 'vm') return 'cowork-vm';
  if (process.env.CLAUDE_CODE_ENTRYPOINT === 'claude-desktop') return 'code-desktop';
  return 'code-cli';
}

/**
 * Candidate directories that may contain copies of this plugin, per surface.
 *
 * These layouts are NOT portable (exp-06 surface matrix): the desktop keeps
 * account plugins under remote/plugins/<hash>/ and CLI-marketplace installs
 * under plugins/cache/<marketplace>/<name>/<version>/, while a Cowork sandbox
 * uses plugins/synced/<name>/ (exp-05). An unrecognised surface returns
 * known:false so callers report `unknown` rather than a false all-clear.
 *
 * @param {{surface?: string, home?: string}} opts
 */
function pluginRoots({ surface = detectSurface(), home = os.homedir(), configDir = process.env.CLAUDE_CONFIG_DIR } = {}) {
  // CLAUDE_CONFIG_DIR relocates Claude Code's ENTIRE config tree -- plugin cache
  // included -- so when it is set, ~/.claude holds nothing to find. Proven by a
  // clean-room install 2026-07-28: the plugin landed under
  // $CLAUDE_CONFIG_DIR/plugins/cache/... while this function searched $HOME/.claude,
  // and a perfectly healthy install reported "could not locate this plugin".
  // It is not an either/or search: if the config dir is relocated, a copy sitting in
  // ~/.claude is not installed at all, and counting it would fabricate a collision.
  // Also load-bearing for sandboxes -- upstream #40495 records that they ignore the
  // host's ~/.claude entirely and expect config at CLAUDE_CONFIG_DIR in the mount.
  const claude = configDir || path.join(home, '.claude');
  if (surface === 'cowork-vm') {
    return { surface, known: true, roots: [path.join(claude, 'plugins', 'synced')] };
  }
  if (surface === 'code-desktop' || surface === 'code-cli') {
    return {
      surface,
      known: true,
      roots: [path.join(claude, 'remote', 'plugins'), path.join(claude, 'plugins', 'cache')],
    };
  }
  return { surface, known: false, roots: [] };
}

/** A finding with no remedy is informational, not actionable. */
function finding(id, status, title, detail, remedy = null, data = {}) {
  return { id, status, title, detail, remedy, data };
}

/** Does the copy we are RUNNING FROM actually carry a hooks declaration?
 * Two valid forms: hooks/hooks.json (the path convention) or a `hooks` key in
 * the manifest (exp-07 proved both fire). The account channel strips the
 * directory but copies the manifest byte-identically. */
function checkHooksWired() {
  const root = process.env.CLAUDE_PLUGIN_ROOT || path.join(__dirname, '..');
  try {
    const hooksJson = path.join(root, 'hooks', 'hooks.json');
    if (fs.existsSync(hooksJson)) {
      return finding('hooks_wired', 'ok', 'Hooks are wired', `Found ${hooksJson}`, null, { root });
    }
    const manifestPath = path.join(root, '.claude-plugin', 'plugin.json');
    if (!fs.existsSync(manifestPath)) {
      return finding(
        'hooks_wired',
        'unknown',
        'Cannot tell whether hooks are wired',
        `No plugin manifest at ${manifestPath}`,
        null,
        { root },
      );
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (manifest.hooks) {
      return finding('hooks_wired', 'ok', 'Hooks are wired', 'Declared in plugin.json', null, { root });
    }
    return finding(
      'hooks_wired',
      'fail',
      'This copy has no hooks — no reviews will run',
      `${root} has a plugin manifest but neither hooks/hooks.json nor a "hooks" manifest key.`,
      'This copy was delivered without its hooks. Install Prooftrail from a CLI marketplace (claude plugin marketplace add …) rather than the claude.ai plugin directory, which does not deliver hooks to desktop surfaces.',
      { root },
    );
  } catch (e) {
    return finding('hooks_wired', 'unknown', 'Cannot tell whether hooks are wired', String((e && e.message) || e), null, { root });
  }
}

/** Read a plugin manifest, returning null when absent/unparseable. */
function readManifestAt(dirPath) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dirPath, '.claude-plugin', 'plugin.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** Walk a roots tree looking for plugin manifests whose name matches ours.
 * Depth is bounded: the deepest real layout is
 * plugins/cache/<marketplace>/<name>/<version>/ -- 3 levels below the root. */
function findInstalls({ surface, home, name = readPluginName() } = {}) {
  const { known, roots } = pluginRoots({ surface, home });
  // `reason` distinguishes the two ways this can come back unknown -- production
  // is overwhelmingly the second case (readPluginName() found no manifest),
  // never the first (every surface pluginRoots() enumerates already sets
  // known:true), and the two need different explanations (Important 5).
  if (!known) return { known: false, installs: [], reason: 'surface' };
  if (!name) return { known: false, installs: [], reason: 'name' };
  const installs = [];
  const seen = new Set();
  const visit = (dirPath, depth) => {
    if (depth > 3 || seen.has(dirPath)) return;
    seen.add(dirPath);
    const manifest = readManifestAt(dirPath);
    if (manifest && manifest.name === name) {
      installs.push({
        path: dirPath,
        version: typeof manifest.version === 'string' ? manifest.version : null,
        hasHooks: Boolean(manifest.hooks) || fs.existsSync(path.join(dirPath, 'hooks', 'hooks.json')),
      });
      return; // do not descend into a matched plugin tree
    }
    let entries = [];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const childPath = path.join(dirPath, e.name);
      if (e.isDirectory()) {
        visit(childPath, depth + 1);
        continue;
      }
      // Dirent.isDirectory() is FALSE for a symlink pointing at a directory, so a
      // symlinked duplicate install (e.g. an account-channel mirror symlinked into
      // place) would otherwise be invisible to this walk. fs.statSync follows the
      // link; wrapped in try/catch so a broken symlink is skipped silently, never
      // thrown. Recurse with childPath itself (the symlink's own location) --
      // that is the exact value `visit` adds to `seen`, so a symlink loop cannot
      // spin (bounded doubly by the depth check above regardless).
      if (e.isSymbolicLink()) {
        try {
          if (fs.statSync(childPath).isDirectory()) visit(childPath, depth + 1);
        } catch {
          /* broken symlink -- skip silently */
        }
      }
    }
  };
  for (const r of roots) visit(r, 0);
  return { known: true, installs };
}

/**
 * The single most valuable check in the diagnostic (see docs/05, exp-06):
 * Claude Code loads only the INTERSECTION of components across every install
 * of a given plugin name. An account-channel copy (no hooks) sitting beside a
 * CLI-marketplace copy (hooks) silently drops the hooks entirely -- no error
 * anywhere, reviews just stop. This is the check that would have caught the
 * bug that cost 2026-07-28 (upstream #53923).
 */
function checkInstallShape({ surface, home } = {}) {
  try {
    const { known, installs, reason } = findInstalls({ surface, home });
    // Cowork: we know where to look (exp-05) so the evidence is collected, but
    // we decline to judge. Prooftrail has never run in a sandbox, and the
    // dominant hazard there is stale code surviving uninstall rather than
    // multi-scope collision -- claiming coverage we have not verified is exactly
    // the false confidence this design exists to remove.
    if (surface === 'cowork-vm') {
      return finding(
        'install_shape',
        'unknown',
        'Duplicate-install check does not apply to this surface yet',
        `Found ${installs.length} copy/copies under the sandbox plugin path. Collision behaviour has not been verified on Cowork, so no conclusion is drawn.\n${installs
          .map((i) => `  ${i.path} (version ${i.version ?? 'unknown'}, hooks: ${i.hasHooks ? 'yes' : 'no'})`)
          .join('\n')}`,
        null,
        { installs },
      );
    }
    if (!known) {
      // Important 5: detectSurface() only ever returns surfaces pluginRoots()
      // marks known:true, so `reason === 'surface'` is theoretical -- in
      // production this branch means readPluginName() found no manifest, and
      // saying "the surface is not known" would name a cause that cannot be
      // the real one.
      if (reason === 'name') {
        return finding(
          'install_shape',
          'unknown',
          "Cannot inspect for duplicate installs — this plugin's own name could not be resolved",
          'The running copy has no readable .claude-plugin/plugin.json (checked CLAUDE_PLUGIN_ROOT and the source tree), so installs of it cannot be matched by name. Run with --verbose and share the output.',
          null,
          { installs: [] },
        );
      }
      return finding(
        'install_shape',
        'unknown',
        'Cannot inspect this surface for duplicate installs',
        'The plugin layout for this surface is not known, so no conclusion is possible. Run with --verbose and share the output.',
        null,
        { installs: [] },
      );
    }
    if (installs.length === 0) {
      // Self-contradictory as an 'ok' (BUG: was `installs.length <= 1` -> 'ok'):
      // zero installs means we located NOTHING, which happens when the running
      // copy lives somewhere pluginRoots() does not enumerate (e.g. a
      // --plugin-dir-injected path, or a dev checkout). Reporting 'ok' here would
      // be a false all-clear -- the exact failure this whole check exists to
      // eliminate. List the probed roots so the user can see where we looked.
      const { roots } = pluginRoots({ surface, home });
      return finding(
        'install_shape',
        'unknown',
        'Could not locate this plugin in any known install location',
        `Looked in ${roots.length} known location${roots.length === 1 ? '' : 's'} for this surface but found no copy of this plugin there. This can happen when the running copy lives outside the paths this surface enumerates (for example a --plugin-dir-injected path, or a dev checkout).\n${roots
          .map((r) => `  ${r}`)
          .join('\n')}`,
        null,
        { installs: [] },
      );
    }
    if (installs.length === 1) {
      return finding('install_shape', 'ok', 'One install found', installs.map((i) => i.path).join('\n'), null, { installs });
    }
    return finding(
      'install_shape',
      'fail',
      `${installs.length} installs of this plugin are active — hooks will be silently dropped`,
      `Claude Code loads only the components common to every install of a given name (upstream #53923), so hooks present in one copy but absent from another are dropped entirely.\n${installs
        .map((i) => `  ${i.path} (version ${i.version ?? 'unknown'}, hooks: ${i.hasHooks ? 'yes' : 'no'})`)
        .join('\n')}`,
      'Remove one. Keep the CLI-marketplace install and uninstall the claude.ai one (Customize → Plugins). If the account copy reappears after uninstall, install under a different plugin name — renaming is the only verified escape.',
      { installs },
    );
  } catch (e) {
    return finding('install_shape', 'unknown', 'Duplicate-install check failed', String((e && e.message) || e), null, { installs: [] });
  }
}

/**
 * Single round trip that answers BOTH "is the service reachable" and "is our
 * token accepted". /auth/whoami is used because it is one of only four routes
 * the Worker actually serves; there is no health endpoint, and probing a
 * nonexistent path would report a healthy service as broken. Never throws.
 */
async function probeWhoami({ url, token }) {
  if (!url) return { reachable: false, status: null, body: null, error: 'no url' };
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/auth/whoami`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(10000),
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* a non-JSON body still proves reachability */
    }
    return { reachable: true, status: res.status, body, error: null };
  } catch (e) {
    return { reachable: false, status: null, body: null, error: String((e && e.message) || e) };
  }
}

function checkService({ surface, url, probe }) {
  if (!url) {
    return finding(
      'service',
      'fail',
      'Service URL not configured',
      'Neither the SERVICE_URL plugin setting nor REVIEWSVC_URL resolves to a valid origin.',
      'Set SERVICE_URL in the plugin settings to the review API origin.',
      { url: null },
    );
  }
  if (probe.reachable) {
    return finding('service', 'ok', 'Service reachable', `${url} → HTTP ${probe.status}`, null, { url, status: probe.status });
  }
  return finding(
    'service',
    'fail',
    'Service unreachable',
    `${url} → ${probe.error}`,
    surface === 'cowork-vm'
      ? 'Cowork sandboxes are default-deny for outbound network calls. Allowlist this domain via Settings → Capabilities before reviews can run.'
      : 'Check network connectivity to that origin.',
    { url },
  );
}

function checkToken({ surface, token, probe }) {
  const sandbox = surface === 'cowork-vm';
  const repair = sandbox
    // Sandbox plugin data is wiped every session (exp-05) so pairing cannot
    // persist, and the API_TOKEN plugin setting -- the documented alternative --
    // CANNOT BE SET: claude.ai exposes no userConfig editor (verified live
    // 2026-07-28; upstream #39455). Telling the user to set it would be a remedy
    // they cannot act on, which is the false lead this diagnostic exists to
    // remove. Say plainly that the surface is not configurable yet.
    ? 'Run /prooftrail:setup with a fresh setup code — pairing works here, but lasts only this session (sandbox plugin data is wiped between sessions, and claude.ai has no editor for the API_TOKEN setting yet — upstream anthropics/claude-code#39455). Also confirm the service domain is allowlisted (Settings → Capabilities → Domain allowlist) or every review fails as unreachable. There is no way to persist a pairing in a sandbox automatically: the plugin data dir AND /mnt/user-data are both recreated per session (verified 2026-07-29). If your project folder syncs into the sandbox, a .prooftrail/auth.json placed there from your own machine would be found — copy it in from a host surface, never through a conversation. Otherwise expect to pair per session — and re-pair if reviews go quiet, since a sandbox can be rebuilt mid-conversation.'
    : 'Run /prooftrail:setup to pair this surface.';
  if (!token) {
    return finding('token', 'fail', 'Not connected — no device token', `No token found (checked the API_TOKEN plugin setting and ${path.join(stateDir(), 'auth.json')}).`, repair, { present: false });
  }
  const source = process.env.CLAUDE_PLUGIN_OPTION_API_TOKEN ? 'the API_TOKEN plugin setting' : path.join(stateDir(), 'auth.json');
  if (!probe.reachable) {
    return finding('token', 'unknown', 'Token present but unverified', `Loaded from ${source}; the service could not be reached to confirm it.`, null, { present: true });
  }
  if (probe.status === 200) {
    const label = probe.body && typeof probe.body.label === 'string' ? probe.body.label : 'this surface';
    return finding('token', 'ok', `Token accepted (${label})`, `Loaded from ${source}.`, null, { present: true, label });
  }
  if (probe.status === 401) {
    // Presence is not health: a revoked or expired token lives on disk exactly
    // like a good one.
    return finding('token', 'fail', 'Token rejected by the service', `Loaded from ${source}, but /auth/whoami returned 401 — it has been revoked or has expired.`, repair, { present: true, status: 401 });
  }
  // 503 auth_unavailable and friends: a backend outage is NOT a bad token, and
  // telling the user to re-pair would burn a single-use setup code for nothing.
  return finding('token', 'unknown', 'Token present but unverified', `Loaded from ${source}; /auth/whoami returned ${probe.status}.`, null, { present: true, status: probe.status });
}

// Important 4: `liveness` used to only ask "has a capture EVER existed", and
// nothing ever deletes first-prompt-*.json, so once one session ran, `ok`
// was permanent -- including throughout the exact "it worked, then silently
// stopped" regression this guard exists to catch. Age the newest capture
// instead. 14 days mirrors the dashboard's "quiet" threshold (fixed, no
// per-user cadence baseline yet -- see
// docs/plans/2026-07-28-install-integrity-guard-design.md). `unknown`, not
// `fail`: infrequent-but-legitimate use must never read as broken.
const LIVENESS_STALE_MS = 14 * 24 * 60 * 60 * 1000;

/** Local half of the chain: did UserPromptSubmit ever write a capture?
 * A capture is written on the first prompt of every session, so an empty data
 * directory means the hook has never run on this surface. */
function checkLiveness() {
  try {
    const d = stateDir();
    const captures = fs
      .readdirSync(d)
      .filter((f) => f.startsWith('first-prompt-') && f.endsWith('.json'))
      .map((f) => ({ file: f, mtime: fs.statSync(path.join(d, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (captures.length === 0) {
      return finding(
        'liveness',
        'fail',
        'The prompt-capture hook has never run on this surface',
        `No first-prompt-*.json in ${d}. Prooftrail writes one on the first prompt of every session, so this means the hook is not firing.`,
        'If you just installed, start a NEW session — hooks are not wired until a session that begins after installation. Otherwise check the duplicate-install and hooks findings above.',
        { captureCount: 0, newestIso: null },
      );
    }
    const newestMs = captures[0].mtime;
    const newestIso = new Date(newestMs).toISOString();
    const ageMs = Date.now() - newestMs;
    if (ageMs > LIVENESS_STALE_MS) {
      const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));
      return finding(
        'liveness',
        'unknown',
        'Prompt-capture hook has not run recently',
        `Newest capture is ${newestIso} (${ageDays} day(s) ago) in ${d}. That is beyond the ${Math.floor(LIVENESS_STALE_MS / (24 * 60 * 60 * 1000))}-day quiet threshold, so this could be legitimate low usage or reviews that have silently stopped running.`,
        'Reviews may have stopped running on this surface. Check the duplicate-install and hooks findings above for a cause.',
        { captureCount: captures.length, newestIso },
      );
    }
    return finding('liveness', 'ok', 'Prompt-capture hook has run', `${captures.length} capture(s) in ${d}; newest ${newestIso}`, null, {
      captureCount: captures.length,
      newestIso,
    });
  } catch (e) {
    return finding('liveness', 'unknown', 'Liveness check failed', String((e && e.message) || e), null, { captureCount: null });
  }
}

/**
 * Collects install-integrity findings. NEVER throws: each check is guarded, and
 * a check that cannot inspect its inputs reports `unknown` rather than `ok`.
 *
 * @param {{static?: boolean}} opts `static: true` restricts to checks needing
 *   no network and no session history -- the set pair.js can run at pairing
 *   time, when hooks are legitimately not yet wired.
 * @returns {Promise<Array<{id,status,title,detail,remedy,data}>>}
 */
// `surface`/`home` are accepted from the start so tests can stay hermetic: a
// call without them falls through to pluginRoots' own detectSurface() default
// rather than walking the real ~/.claude of whoever runs the suite.
//
// `surface` MUST default to detectSurface() here too, not just in pluginRoots.
// checkInstallShape() below compares this raw argument against 'cowork-vm' to
// decide whether to withhold a verdict; if a caller invokes diagnose({}) with
// no explicit surface, an undefined default would skip that carve-out while
// pluginRoots() still resolves the real (sandbox) surface internally --
// silently defeating the Cowork carve-out on an actual Cowork VM.
async function diagnose({ static: staticOnly = false, surface = detectSurface(), home } = {}) {
  const findings = [];
  findings.push(checkInstallShape({ surface, home }));
  findings.push(checkHooksWired());
  if (!staticOnly) {
    let url = null;
    try {
      url = resolveBaseUrl().url;
    } catch {
      url = null;
    }

    // Critical 1 / Important 3: `token` and `liveness` both read from
    // stateDir(), and a Bash-tool invocation does NOT reliably inherit this
    // plugin's own CLAUDE_PLUGIN_DATA -- proven live on the first real install
    // (2026-07-28): the ambient CLAUDE_PLUGIN_DATA pointed at a DIFFERENT
    // installed plugin's data directory, CLAUDE_PLUGIN_ROOT was unset, and the
    // doctor (before this fix) confidently reported "not connected" and "hook
    // has never run" on a healthy, paired install. Two distinct ways stateDir()
    // can be untrustworthy, both of which must degrade to `unknown` rather than
    // silently reading the wrong (or a world-writable) directory and reporting
    // a verdict on it:
    let dataDirProblem = null;
    if (!process.env.CLAUDE_PLUGIN_DATA) {
      // Important 3: stateDir() would fall back to os.tmpdir() -- world-
      // writable, so any local user can manufacture a healthy verdict. Verified
      // live: with CLAUDE_PLUGIN_DATA empty, the doctor read this machine's
      // stray /tmp/auth.json and /tmp/first-prompt-*.json and reported a token
      // present and the hook healthy. pair.js already refuses to touch tmpdir
      // for exactly this reason (Fix 7 there); the doctor must refuse to trust
      // it too, not just to write to it.
      dataDirProblem = {
        title: 'Cannot determine pairing/hook status — plugin data directory is not known',
        detail:
          'CLAUDE_PLUGIN_DATA is unset or empty. Falling back to the shared system tmpdir ' +
          'would mean trusting files any local user can write, so nothing about pairing or ' +
          'hook activity can be determined from it.',
      };
    } else {
      const ownershipError = checkStateDirOwnership(stateDir());
      if (ownershipError) {
        dataDirProblem = {
          title: 'Cannot determine pairing/hook status — plugin data directory belongs to another plugin',
          detail: ownershipError,
        };
      }
    }

    // Never read a foreign or untrusted data directory even just for the
    // service probe's token -- only env-supplied credentials are trusted here.
    const token = dataDirProblem
      ? process.env.REVIEWSVC_TOKEN || process.env.CLAUDE_PLUGIN_OPTION_API_TOKEN || null
      : findToken();
    const probe = await probeWhoami({ url, token });
    findings.push(checkService({ surface, url, probe }));

    if (dataDirProblem) {
      // The remedy is deliberately an environment fix, never a re-pair prompt:
      // sending the user to /prooftrail:setup here would spend a single-use
      // setup code diagnosing nothing.
      const remedy =
        "Re-run this command with CLAUDE_PLUGIN_DATA and CLAUDE_PLUGIN_ROOT set to this plugin's own values, then try again.";
      findings.push(finding('token', 'unknown', dataDirProblem.title, dataDirProblem.detail, remedy, { present: null }));
      findings.push(finding('liveness', 'unknown', dataDirProblem.title, dataDirProblem.detail, remedy, { captureCount: null }));
    } else {
      findings.push(checkToken({ surface, token, probe }));
      findings.push(checkLiveness());
    }
  }
  return findings;
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
  emitHookOutput,
  sanitizeFeedback,
  validateBaseUrl,
  resolveBaseUrl,
  collectDiff,
  looksLikeSecretPath,
  parseTranscript,
  collectTrace,
  classifyCommand,
  detectSurface,
  buildAskWindow,
  prependHouseRules,
  resolvePromptId,
  shouldShowQuotaNotice,
  shouldShowGateOffer,
  shouldShowConnectNotice,
  idempotencyKey,
  pluginRoots,
  diagnose,
  finding,
  findInstalls,
  probeWhoami,
};
