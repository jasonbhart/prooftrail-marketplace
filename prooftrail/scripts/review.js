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
  emitHookOutput,
  sanitizeFeedback,
  resolveBaseUrl,
  collectDiff,
  parseTranscript,
  collectTrace,
  detectSurface,
  buildAskWindow,
  prependHouseRules,
  resolvePromptId,
  shouldShowQuotaNotice,
  shouldShowGateOffer,
  shouldShowUnsatNotice,
  shouldShowConnectNotice,
  idempotencyKey,
} = require('./lib');
const {
  runLocalRules,
  collectFacts,
  routeFindings,
  formatViolations,
  formatUnsatisfiable,
  formatUnsatisfiableForAgent,
  formatOffers,
} = require('./rules');
const { readRulesCache, writeRulesCache, cachePath } = require('./rules-cache');
const {
  RECURSION_ENV,
  detectUncorroboratedClaims,
  startJob,
  collectJob,
  awaitJob,
  formatJob,
} = require('./delegate');

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
  // RECURSION GUARD, first statement in the hook. A delegated local agent
  // inherits this environment, and if it is itself a Claude Code CLI it loads
  // this plugin and fires its own Stop hook -- which would spawn another agent,
  // which would spawn another. Nothing below this line may run in that child.
  if (process.env[RECURSION_ENV]) return;

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

  // ---- the LOCAL rules pass -------------------------------------------------
  // Runs before anything network-shaped, and deliberately before the token
  // check: computable rules need no account, no service and no model, so a
  // user who has never signed up still gets them. That is not a giveaway --
  // ADR-001's amendment says a rule that CAN be computed MUST be computed, and
  // experiments/16 found the two shipped local predicates outscoring the
  // hosted judge (14/22 vs 12/22) on the same stops and independent labels.
  // Paying a model to compare two integers it was handed is the thing that
  // measurement ruled out.
  //
  // Parsed once here and handed to collectTrace below -- real transcripts reach
  // 15 MB and this hook runs on every turn.
  const parsedTranscript = parseTranscript(evt.transcript_path);
  let localFindings = '';   // notify-level: the user only
  let localForModel = '';
  let unsatForModel = '';   // inform-level: additionalContext
  let blockReason = '';     // block-level: decision:"block"
  let gateOffer = '';
  // Judgment rules: measured PROSE the service ships for judgment families
  // that are `on` (rulesDb.ts's `judgment-prose`, inside the same signed
  // cache as `checks`), turned into `{family, label, computable: false,
  // enforcement: 'judge', text}` objects by rulesFromCache. Never a computable
  // rule, and never routed through routeFindings -- see prependHouseRules for
  // why the split between this and the local evaluator's findings is exact.
  let judgmentRules = [];
  // How many families the CACHE mentioned that this client's RULE_FAMILIES
  // does not know -- an old client talking to a newer service.
  let unknownChecks = 0;
  // Computed from the transcript DIRECTLY, not via runLocalRules -- that
  // returns null when the project has no rules file, and a false "tests pass"
  // is worth checking whether or not anyone wrote a rule about tests.
  const localFacts = collectFacts(parsedTranscript);
  // Task 5: rules come from the signed cache Task 4 verifies, never from a
  // repo file -- a file in the repo is editable by the agent being checked,
  // which is the whole reason rules moved server-side. `null` covers "never
  // connected" and "cache failed verification" identically by design
  // (rules-cache.js's contract: unverifiable is treated exactly like absent,
  // never like a partial or downgraded rule set).
  const cachedRules = readRulesCache();
  // A cache FILE that exists but failed verification is a DIFFERENT situation
  // from never having one -- tampering or corruption, not "not connected yet"
  // -- and a user who believed a `block` rule was still enforced deserves to
  // know it silently stopped being enforced, not just see the generic
  // not-connected copy below.
  let cacheTamperedNotice = '';
  try {
    if (!cachedRules && fs.existsSync(cachePath())) {
      cacheTamperedNotice = 'Prooftrail: local rule cache failed verification (tampered or corrupted) — ignoring it.';
    }
  } catch {
    /* fail-soft: this is a notice, never the gate */
  }
  try {
    const local = runLocalRules(evt.cwd, parsedTranscript, cachedRules);
    judgmentRules = (local && local.judgment) || [];
    unknownChecks = (local && local.unknown) || 0;

    // Each violation travels on the channel its own rule asked for. Default is
    // `inform` -- the model sees it, the turn still ends. A rules gate whose
    // findings only ever reached the user was a reporting tool, not a gate.
    const routed = routeFindings(local && local.evaluation, local && local.commands, finalMessage, evt.cwd);
    localFindings = formatViolations(routed.notifying);

    // A check for a tool this project does not have can never pass, so it is
    // withdrawn rather than repeated every turn (exp-20). BOTH parties are told
    // once, and told what to do -- a setting that silently changes behaviour is
    // the hidden knowledge a demo should not require someone to already have.
    if (routed.unsatisfiable.length && shouldShowUnsatNotice(evt.session_id)) {
      localFindings = [localFindings, formatUnsatisfiable(routed.unsatisfiable)].filter(Boolean).join('\n\n');
      unsatForModel = formatUnsatisfiableForAgent(routed.unsatisfiable);
    }
    localForModel = formatViolations(routed.informing);

    // BLOCKING IS THE GUARDED PATH, and both guards are load-bearing.
    //
    // `stop_hook_active` is true when this Stop fired BECAUSE a previous block
    // refused to let the turn end. Blocking again on the same unmet condition
    // is how a hook loops until the session quota is gone --
    // anthropics/claude-code#55754 records exactly that, ~50 minutes and a full
    // session. So we block at most once, then step aside and let the finding
    // travel as context instead.
    //
    // routeFindings applies the second guard: a rule is only promoted to
    // `block` when the agent could plausibly satisfy it (see canRemedy).
    if (routed.blocking.length) {
      if (evt.stop_hook_active) {
        localForModel = [localForModel, formatViolations(routed.blocking)].filter(Boolean).join('\n');
      } else {
        blockReason = formatViolations(routed.blocking);
      }
    }
    // Only when the engine can check nothing AND not already shown today.
    if (local && local.offers && local.offers.length && shouldShowGateOffer(evt.session_id)) {
      gateOffer = formatOffers(local.offers, local.sources);
    }
  } catch {
    localFindings = ''; // fail-soft (ADR-004): an advisory check never breaks a session
    localForModel = '';
    blockReason = '';
    gateOffer = '';
    judgmentRules = [];
    unknownChecks = 0;
  }

  // ---- the optional LOCAL AGENT pass (ADR-012, Task 7) ----------------------
  // `deep-check` is now a server-held setting, delivered inside the same
  // signed cache as every other rule (rules-cache.js) -- not a client env var
  // choice. `off` means "do nothing" and is also the fallback when there is
  // no cache at all (never connected, or a tampered cache that failed
  // verification): a Stop hook must never start WAITING on a check nobody on
  // the account authorized.
  //
  //   off    -- the pass is skipped entirely (pre-Task-7 default).
  //   inform -- unchanged ADR-012 behaviour: detached, reported next turn.
  //   await  -- additionally waits up to AWAIT_WINDOW_S for THIS turn's job
  //             and can block on a refutation. See delegate.js's awaitJob for
  //             why the window expiring does not kill the job.
  let agentFinding = '';
  try {
    const deepMode = (cachedRules && cachedRules.rules && cachedRules.rules['deep-check']) || 'off';
    if (deepMode !== 'off') {
      // Collect BEFORE starting, so a finished answer is surfaced rather than
      // replaced by a fresh job (unchanged from ADR-012).
      const prior = collectJob(evt.session_id);
      if (prior && prior.verdict === 'RETRYING') {
        // Exactly one retry (delegate.js's collectJob; borrowed from
        // agy-code-review.sh's AGY_RETRY_ON_EMPTY -- "even on exit 0, empty
        // means something went wrong"). A do-over, not a finding: nothing is
        // emitted for it, this turn or ever -- only the eventual real verdict
        // (or the final NO_OUTPUT once the retry also comes up empty) is.
        startJob(evt.session_id, evt.cwd, [{ claim: prior.claim, why: 'previous attempt produced no output' }], localFacts);
      } else {
        if (prior) agentFinding = formatJob(prior);
        const claims = detectUncorroboratedClaims(finalMessage, localFacts);
        if (claims.length) {
          const started = startJob(evt.session_id, evt.cwd, claims, localFacts);
          if (started && deepMode === 'await') {
            // NO progress note is possible here. The hook protocol is ONE
            // JSON object per invocation, so a "verifying..." line written
            // now would corrupt the object written at the end -- the user's
            // only feedback that the hook is working is Claude Code's own
            // hook-running indicator.
            const verdict = await awaitJob(evt.session_id);
            if (verdict && verdict.verdict === 'RETRYING') {
              // Landed inside the window but came back empty -- same rule as
              // above: retry once, emit nothing.
              startJob(evt.session_id, evt.cwd, [{ claim: verdict.claim, why: 'previous attempt produced no output' }], localFacts);
            } else if (verdict && verdict.verdict === 'FALSE') {
              // Merge rather than overwrite: a local-rules block from earlier
              // in this same function must not be silently discarded just
              // because the deep check also refuted something.
              blockReason = [blockReason, formatJob(verdict)].filter(Boolean).join('\n');
            } else if (verdict) {
              agentFinding = [agentFinding, formatJob(verdict)].filter(Boolean).join('\n\n');
            }
            // else: the window expired without an answer. The job keeps
            // running toward its own JOB_TIMEOUT_S ceiling (delegate.js) and
            // is collected as `prior` on the NEXT turn -- `await` only
            // changes WHEN the answer lands, never WHETHER it does.
          }
        }
      }
    }
  } catch {
    agentFinding = ''; // fail-soft: an optional deep check never breaks a session
  }

  const token = findToken();
  if (!token) {
    // Still worth saying: the local half of the product works unauthenticated
    // -- IF a rule cache exists. Without a token there is never a way to have
    // fetched one, so this is realistically always "no rules configured", but
    // the check is written against `cachedRules` (not `!token`) so it reads
    // correctly if that ever changes.
    const unauth = [];
    if (localFindings) unauth.push(`Prooftrail (local rules):\n${localFindings}`);
    if (agentFinding) unauth.push(agentFinding);
    if (gateOffer) unauth.push(gateOffer);
    if (cacheTamperedNotice) unauth.push(cacheTamperedNotice);
    if (unknownChecks > 0) unauth.push(`Prooftrail: ${unknownChecks} newer check(s) need a plugin update.`);
    unauth.push(
      localFindings || gateOffer || agentFinding || localForModel || blockReason
        ? 'Not connected — run /prooftrail:setup to add hosted review.'
        : 'Prooftrail: not connected — run /prooftrail:setup to enable reviews.',
    );
    // DELIBERATELY NO second connect line here. This branch already says
    // "not connected — run /prooftrail:setup" immediately above, and a
    // brand-new user's very first impression was those two near-identical
    // sentences stacked. That reads as a bug, which is a poor opening for a
    // tool whose whole pitch is that it notices things. Found by walking the
    // cold-start path on the published build; `shouldShowConnectNotice` is kept
    // for the case this one never covered — a PAIRED install with no rule set
    // yet, where the user is connected, sees nothing, and has no idea why.
    emitHookOutput({
      systemMessage: unauth.join('\n\n'),
      additionalContext: [localForModel ? `Prooftrail (your rules):\n${localForModel}` : '', unsatForModel].filter(Boolean).join('\n\n'),
      blockReason: blockReason ? `Prooftrail (your rules):\n${blockReason}` : '',
    });
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
  // Local findings needed no network to produce, so they must survive EVERY
  // network failure path below -- a service outage degrading the hosted review
  // to nothing is expected (F1-F6), silently dropping a rule violation we
  // already computed on this machine is not.
  //
  // `degrade()` emits ALL THREE channels, not just the user-facing one: an
  // outage must not silently cost the AGENT a finding that needed no network to
  // compute. Returning early after only a systemMessage was that exact bug.
  const degrade = (text) => {
    const parts = [];
    if (pinNotice) parts.push(pinNotice);
    if (localFindings) parts.push(`Prooftrail (local rules):\n${localFindings}`);
    if (agentFinding) parts.push(agentFinding);
    if (gateOffer) parts.push(gateOffer);
    if (cacheTamperedNotice) parts.push(cacheTamperedNotice);
    if (unknownChecks > 0) parts.push(`Prooftrail: ${unknownChecks} newer check(s) need a plugin update.`);
    if (text) parts.push(text);
    emitHookOutput({
      systemMessage: parts.join('\n'),
      additionalContext: [localForModel ? `Prooftrail (your rules):\n${localForModel}` : '', unsatForModel].filter(Boolean).join('\n\n'),
      blockReason: blockReason ? `Prooftrail (your rules):\n${blockReason}` : '',
    });
  };
  if (!baseUrl) {
    // T2.3: don't fail silently — a workspace clearing/spoofing the URL must be visible.
    degrade(('Prooftrail: not configured (invalid or missing service URL) — run /prooftrail:setup.'));
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
      initial_prompt: prependHouseRules(buildAskWindow(captured), judgmentRules),
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
  const trace = collectTrace(evt.transcript_path, undefined, parsedTranscript);
  if (trace) {
    body.payload.tier = 'trace';
    body.payload.trace = trace.trace;
    body.payload.trace_truncated = trace.truncated;
    // ALT-1: tells the service the trace carries `[category]` verification tags,
    // so absent tags mean "no verification ran" rather than "this client is too
    // old to tag". The service refuses to derive attested.verification without
    // it -- see deriveAttested.
    body.payload.trace_classified = trace.classified === true;
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
    degrade(('Prooftrail: Review skipped — service unreachable (check network/egress allowlist).')); // F1/F2
    return;
  }

  if (!res.ok) {
    // F3: surface the server's actionable hint (e.g. "run /prooftrail:setup" on 401).
    let hint = '';
    try {
      const b = await res.json();
      if (b && typeof b.hint === 'string') hint = ` — ${sanitizeFeedback(b.hint)}`;
    } catch {}
    degrade((`Prooftrail: Review skipped — service error (${res.status})${hint}.`)); // F3/F4/F6
    return;
  }

  let result;
  try {
    result = await res.json();
  } catch {
    degrade(('Prooftrail: Review skipped — malformed service response.')); // F6
    return;
  }

  // Persist the rule set the service just sent, for the NEXT turn. THIS turn
  // was evaluated against the cache read at the top of main() -- rules are
  // always at most one turn behind, which is the caching decision this module
  // accepts explicitly (a Stop hook cannot block on a network fetch).
  try {
    if (result && result.rules) writeRulesCache({ ...result.rules, fetched_at: Date.now() });
  } catch {
    // fail-soft: a cache write failure must not affect the review just returned
  }

  // Compose one systemMessage from the pin notice + advisory feedback
  // (revise) + quota notice (F14) -- exactly one stdout write regardless of
  // how many of these apply.
  const parts = [];
  if (pinNotice) parts.push(pinNotice);
  // Deterministic findings lead: they are computed, not judged, and on the one
  // rule with independent labels the local predicates outscored the judge.
  if (localFindings) parts.push(`Prooftrail (local rules):\n${localFindings}`);
  if (agentFinding) parts.push(agentFinding);
  if (gateOffer) parts.push(gateOffer);
  if (cacheTamperedNotice) parts.push(cacheTamperedNotice);
  if (unknownChecks > 0) parts.push(`Prooftrail: ${unknownChecks} newer check(s) need a plugin update.`);
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
  emitHookOutput({
    systemMessage: parts.join('\n'),
    additionalContext: [localForModel ? `Prooftrail (your rules):\n${localForModel}` : '', unsatForModel].filter(Boolean).join('\n\n'),
    blockReason: blockReason ? `Prooftrail (your rules):\n${blockReason}` : '',
  });
  // approve with no notice -> silent
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
