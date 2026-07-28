#!/usr/bin/env node
// Stop hook: advisory-mode supervisory review (walking skeleton).
// Fail-soft everywhere per docs/03-failure-mode-matrix.md — this script must
// NEVER break a session: every path exits 0; advisory mode never blocks.
'use strict';
const fs = require('node:fs');
const {
  PLUGIN_VERSION,
  readStdinJson,
  firstPromptPath,
  findToken,
  emitSystemMessage,
  sanitizeFeedback,
  resolveBaseUrl,
  collectDiff,
  collectTrace,
  detectSurface,
  resolvePromptId,
  shouldShowQuotaNotice,
  idempotencyKey,
} = require('./lib');

// Client deadline stays BELOW the Stop-hook timeout (60s in hooks.sample.json)
// so a slow judge fails soft here, never as a raw hook timeout (matrix F2).
const DEADLINE_MS = Number(process.env.REVIEWSVC_TIMEOUT_MS || 45000);
const MIN_MSG_CHARS = 40; // fast-path floor (ADR-003): trivial replies skip review

// Audit-trail tranche (tranche 8, Phase 1, ADR-003): a bypass report is
// telemetry, not the gate -- it must never make the hook slower, so its
// deadline is far short of DEADLINE_MS above, not shared with it.
const BYPASS_TIMEOUT_MS = Number(process.env.REVIEWSVC_BYPASS_TIMEOUT_MS || 3000);

/**
 * ADR-003: "every bypass of either kind is still reported to the service as
 * an audited `bypassed` record" -- the client's two fast-path `return`s used
 * to skip review silently, leaving the audit trail with no record of why a
 * session was never judged. Best-effort and non-blocking by construction:
 * wrapped in its own try/catch with a SHORT timeout (BYPASS_TIMEOUT_MS, not
 * DEADLINE_MS) -- a failure here is silently swallowed and never surfaces to
 * the user or changes the hook's exit code (fail-soft: this is telemetry,
 * not the gate). No token/baseUrl configured -> nothing to report to, so it
 * no-ops rather than attempting a doomed call.
 */
async function reportBypass(evt, promptId, reason) {
  try {
    const token = findToken();
    if (!token) return;
    const { url: baseUrl } = resolveBaseUrl();
    if (!baseUrl) return;
    await fetch(`${baseUrl.replace(/\/$/, '')}/v1/bypass`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        session: { id: evt.session_id, prompt_id: promptId, surface: detectSurface() },
        bypass_reason: reason,
        client: { plugin_version: PLUGIN_VERSION, platform: process.platform },
      }),
      signal: AbortSignal.timeout(BYPASS_TIMEOUT_MS),
    });
  } catch {
    // fail-soft: telemetry only -- never surfaces, never blocks/slows the hook.
  }
}

async function main() {
  const evt = await readStdinJson();
  const finalMessage = evt.last_assistant_message;
  if (!evt.session_id || typeof finalMessage !== 'string') return; // tolerant parse (exp-01/03)

  // Read the captured prompt (if any) BEFORE the fast-path checks below --
  // T3.4 fix (audit-trail tranche, Phase 4) needs it to derive a stable
  // per-prompt surrogate even on the fast paths, not just the full review
  // flow. `null` (rather than throwing) covers "no captured ask exists".
  let captured = null;
  try {
    captured = JSON.parse(fs.readFileSync(firstPromptPath(evt.session_id), 'utf8'));
  } catch {
    captured = null;
  }
  // T3.4 fix: resolved ONCE, used everywhere a prompt_id is needed below
  // (the real review payload, the idempotency key, and any bypass report) --
  // see lib.js's resolvePromptId doc comment for the fallback order.
  const promptId = resolvePromptId(evt.session_id, evt.prompt_id, captured);

  if (finalMessage.length < MIN_MSG_CHARS) {
    await reportBypass(evt, promptId, 'fast_path_short_message'); // fast path: trivial stop (ADR-003 audited)
    return;
  }
  if (!captured) {
    await reportBypass(evt, promptId, 'no_captured_prompt'); // no captured ask -> nothing to judge against (ADR-003 audited)
    return;
  }

  const token = findToken();
  if (!token) {
    emitSystemMessage('Prooftrail: not connected — run /prooftrail:setup to enable reviews.');
    return;
  }
  // T2.2 full (audit-trail tranche, Phase 3; TM-4): CLAUDE_PLUGIN_OPTION_SERVICE_URL
  // is the pin and wins unconditionally over the workspace-writable REVIEWSVC_URL
  // env var -- see lib.js's resolveBaseUrl doc comment. `pinNotice` is folded into
  // whichever single message this run ends up emitting below (never a second
  // stdout write -- the hook protocol is one JSON object per invocation).
  const { url: baseUrl, envIgnored } = resolveBaseUrl();
  const pinNotice = envIgnored
    ? 'Prooftrail: ignoring REVIEWSVC_URL — SERVICE_URL is pinned by plugin config.'
    : null;
  const withPinNotice = (text) => (pinNotice ? `${pinNotice}\n${text}` : text);
  if (!baseUrl) {
    // T2.3: don't fail silently — a workspace clearing/spoofing the URL must be visible.
    emitSystemMessage(withPinNotice('Prooftrail: not configured (invalid or missing service URL) — run /prooftrail:setup.'));
    return;
  }

  const body = {
    schema_version: '2026-07',
    session: {
      id: evt.session_id,
      prompt_id: promptId,
      surface: detectSurface(),
      cwd: evt.cwd,
    },
    payload: {
      tier: 'minimal',
      initial_prompt: String(captured.prompt).slice(0, 100000),
      final_message: finalMessage.slice(0, 200000),
    },
    client: { plugin_version: PLUGIN_VERSION, platform: process.platform },
  };

  // Trace-tier tranche (Phase 1): the Stop hook event carries `transcript_path`
  // directly (verified against the real binary -- docs/00-feasibility-report.md);
  // use it as-is, never go hunting the filesystem. A trace failure (missing,
  // unreadable, lagging, or malformed transcript -- F10) is fully absorbed by
  // collectTrace's own fail-soft contract (returns null, never throws), so
  // this degrades silently to the diff/minimal tiers below.
  const trace = collectTrace(evt.transcript_path);
  if (trace) {
    body.payload.tier = 'trace';
    body.payload.trace = trace.trace;
    body.payload.trace_truncated = trace.truncated;
  }

  // T4.1: attach a diff as evidence when cwd is a git repo. Attached
  // alongside a trace when both are available (tier stays 'trace' -- trace is
  // the richer evidence kind); otherwise this alone upgrades to diff tier.
  const evidence = collectDiff(evt.cwd);
  if (evidence) {
    if (body.payload.tier !== 'trace') body.payload.tier = 'diff';
    body.payload.diff = evidence.diff;
    body.payload.truncated = evidence.truncated;
  }

  let res;
  try {
    res = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/review`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        // F6: hashed from the exact payload being judged, not a hardcoded
        // `:1` -- see lib.js's idempotencyKey doc comment.
        'idempotency-key': idempotencyKey(evt.session_id, body.session.prompt_id, body.payload),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DEADLINE_MS),
    });
  } catch {
    emitSystemMessage(withPinNotice('Prooftrail: Review skipped — service unreachable (check network/egress allowlist).')); // F1/F2
    return;
  }

  if (!res.ok) {
    // F3: surface the server's actionable hint (e.g. "run /prooftrail:setup" on 401).
    let hint = '';
    try {
      const b = await res.json();
      if (b && typeof b.hint === 'string') hint = ` — ${sanitizeFeedback(b.hint)}`;
    } catch {}
    emitSystemMessage(withPinNotice(`Prooftrail: Review skipped — service error (${res.status})${hint}.`)); // F3/F4/F6
    return;
  }

  let result;
  try {
    result = await res.json();
  } catch {
    emitSystemMessage(withPinNotice('Prooftrail: Review skipped — malformed service response.')); // F6
    return;
  }

  // Compose one systemMessage from the pin notice + advisory feedback
  // (revise) + quota notice (F14) -- exactly one stdout write regardless of
  // how many of these apply.
  const parts = [];
  if (pinNotice) parts.push(pinNotice);
  if (result.verdict === 'revise') {
    // T2.1: bound + strip before injecting.
    const clean = typeof result.feedback === 'string' ? sanitizeFeedback(result.feedback) : '';
    if (clean) {
      parts.push(`Prooftrail (advisory): ${clean}`);
    } else {
      // F7 (docs/03-failure-mode-matrix.md): `feedback` missing/non-string/
      // empty on a `revise` verdict is a SERVER bug (can't inject empty
      // guidance) — the matrix's fail-open behavior is approve+warn, never
      // silence, and calls for logging it loudly client-side.
      console.error('Prooftrail: revise verdict with missing/invalid feedback (F7 server bug)');
      parts.push('Prooftrail: reviewer flagged an issue but sent no usable feedback (server bug) — approving anyway.');
    }
  }
  // Fix 4 (F14): the quota notice is capped at most once per session/day so
  // it doesn't become nagware every single turn once a user crosses 80% —
  // the advisory `revise` feedback above is deliberately NOT throttled.
  const notice = result.entitlements && result.entitlements.notice;
  if (typeof notice === 'string' && notice.trim() && shouldShowQuotaNotice(evt.session_id)) {
    parts.push(sanitizeFeedback(notice));
  }
  if (parts.length) emitSystemMessage(parts.join('\n'));
  // approve with no notice -> silent
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
