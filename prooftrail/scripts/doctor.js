#!/usr/bin/env node
// /prooftrail:doctor — install integrity check and evidence dump.
//
// Two renderings over one collection (see the design doc): the default verdict
// mode answers "am I broken?", and --verbose dumps everything observed, which is
// how a surface nobody owns becomes self-describing.
//
// Always exits 0: this is a diagnostic, never a gate (ADR-004).
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { diagnose, detectSurface, PLUGIN_VERSION, findToken, pluginRoots, stateDir, checkStateDirOwnership } = require('./lib');

const ICON = { ok: 'OK  ', warn: 'WARN', fail: 'FAIL', unknown: '??  ' };

/** Environment snapshot with secret-shaped values masked. The token is carried
 * in CLAUDE_PLUGIN_OPTION_API_TOKEN on sandbox surfaces, so a wholesale dump
 * would leak it (ADR-007). Names are always shown -- presence is diagnostic. */
// Important 7: this output is designed to be pasted into a bug report, so the
// denylist has to cover more than the literal words "token"/"secret"/"key" --
// CLAUDE_PLUGIN_OPTION_PASSWORD, ..._CREDENTIAL, ..._COOKIE, ..._DSN,
// ..._WEBHOOK_URL, ..._AUTH_* all print verbatim under the narrower pattern,
// and per Critical 1 an env-bleed run may be showing a DIFFERENT plugin's vars.
const SENSITIVE_ENV_RE = /TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|COOKIE|DSN|WEBHOOK|AUTH/i;

function envSnapshot() {
  const out = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('CLAUDE_')) continue;
    out[k] = SENSITIVE_ENV_RE.test(k) ? '<masked: present>' : v;
  }
  return out;
}

/** Important 7 belt-and-braces: enforce the ADR-007 "never print the token"
 * rule at runtime, not just via the name-based denylist above. If the actual
 * token value shows up anywhere in the fully rendered output -- text, verbose,
 * or JSON -- replace every occurrence before it is written. This is the last
 * line of defense against a masking regression, deliberately independent of
 * envSnapshot()'s pattern-based approach. */
// Floor below which a "token" string is too plausible to be a real device
// token -- a short REVIEWSVC_TOKEN=dev override, a test fixture, or a value
// planted in an attacker-controlled auth.json (e.g. {"token":"a"}) could
// otherwise match a substring that appears incidentally all over the report
// (a path, a hostname, another finding's text), and split()/join() would
// replace every one of those occurrences, shredding the whole report and
// potentially emitting invalid JSON. Real device tokens are long random
// strings, so 16 is a generous floor that never trims a genuine token.
const MIN_MASKABLE_TOKEN_LENGTH = 16;

function maskToken(output) {
  let token;
  try {
    token = findToken();
  } catch {
    return output;
  }
  return token && token.length >= MIN_MASKABLE_TOKEN_LENGTH && output.includes(token)
    ? output.split(token).join('<masked>')
    : output;
}

/** Whether stateDir() is safe to trust for on-disk token/liveness evidence.
 * Mirrors diagnose()'s own gate in ./lib (Critical 1 / Important 3): untrustworthy
 * when CLAUDE_PLUGIN_DATA is unset/empty (stateDir() falls back to the
 * world-writable os.tmpdir(), so any local user can plant a convincing
 * auth.json) or when the resolved directory demonstrably belongs to a
 * DIFFERENT plugin. Returns the human-readable reason, or null when the
 * directory is trustworthy. */
function dataDirTrustProblem() {
  if (!process.env.CLAUDE_PLUGIN_DATA) {
    return (
      'CLAUDE_PLUGIN_DATA is unset or empty. Falling back to the shared system tmpdir ' +
      'would mean trusting files any local user can write, so nothing about pairing ' +
      'can be determined from it.'
    );
  }
  return checkStateDirOwnership(stateDir());
}

/** Presence and expiry only — never the value (ADR-007). Expiry is diagnostic:
 * an expired token looks exactly like a good one on disk.
 *
 * Gated the same way diagnose() gates the `token`/`liveness` findings (Blocker
 * 1): when stateDir() is not trustworthy, disk-derived presence and expiry
 * are withheld -- reporting a boolean `present` sourced from an untrusted or
 * foreign directory would contradict the finding directly above it, which
 * already says pairing status cannot be determined. An env-supplied token
 * (REVIEWSVC_TOKEN / CLAUDE_PLUGIN_OPTION_API_TOKEN) does not come from the
 * data dir, so presence may still be reported from those -- but expiry is
 * never read from auth.json while the directory is untrusted. */
function tokenSummary() {
  const reason = dataDirTrustProblem();
  if (reason) {
    const envToken = process.env.REVIEWSVC_TOKEN || process.env.CLAUDE_PLUGIN_OPTION_API_TOKEN || null;
    return { present: envToken ? true : null, expires_at: null, reason };
  }
  const present = Boolean(findToken());
  let expires_at = null;
  try {
    expires_at = JSON.parse(fs.readFileSync(path.join(stateDir(), 'auth.json'), 'utf8')).expires_at ?? null;
  } catch {
    /* no auth.json, or token came from the API_TOKEN setting */
  }
  return { present, expires_at };
}

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const verbose = args.includes('--verbose') || json;

  let findings = [];
  try {
    findings = await diagnose({});
  } catch (e) {
    // Fail-soft: a diagnostic that crashes is worse than one that says less.
    findings = [
      { id: 'diagnose', status: 'unknown', title: 'Diagnostics failed to run', detail: String((e && e.message) || e), remedy: null, data: {} },
    ];
  }

  const surface = detectSurface();
  const report = {
    plugin_version: PLUGIN_VERSION,
    surface,
    // The signals detectSurface() actually decides on. These are reported in
    // EVERY mode, beside the conclusion: cloud and local Cowork VMs are
    // near-twins (both hostname `vm`, both /root/.claude paths), so the
    // entrypoint is the only thing that tells them apart — and in a real run it
    // was summarised away because it sat at the bottom of the verbose dump.
    surface_signals: {
      hostname: os.hostname(),
      platform: process.platform,
      entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT || null,
      remote: process.env.CLAUDE_CODE_REMOTE || null,
    },
    token: tokenSummary(),
    // Every path we probed and whether it existed. On an unfamiliar surface this
    // is the most valuable line in the report: it shows exactly where we looked
    // and therefore why we concluded nothing.
    probed_paths: verbose ? pluginRoots({ surface }).roots.map((p) => ({ path: p, exists: fs.existsSync(p) })) : undefined,
    findings,
    env: verbose ? envSnapshot() : undefined,
  };

  if (json) {
    process.stdout.write(maskToken(`${JSON.stringify(report, null, 2)}\n`));
    return;
  }

  // Evidence next to the conclusion. An ABSENT value is diagnostic too, so
  // render it as (unset) rather than omitting it — omission reads as "not
  // checked", which is the kind of ambiguity this whole tool exists to remove.
  const sig = report.surface_signals;
  const shown = (v) => (v === null || v === '' ? '(unset)' : v);
  const signalLine =
    `  detected from: entrypoint=${shown(sig.entrypoint)} hostname=${shown(sig.hostname)} ` +
    `platform=${shown(sig.platform)} remote=${shown(sig.remote)}`;
  const lines = [`Prooftrail doctor — plugin ${PLUGIN_VERSION} on surface "${report.surface}"`, signalLine, ''];
  for (const f of findings) {
    lines.push(`[${ICON[f.status] || f.status}] ${f.title}`);
    if (verbose || f.status !== 'ok') lines.push(`       ${f.detail.split('\n').join('\n       ')}`);
    if (f.remedy) lines.push(`       → ${f.remedy}`);
    lines.push('');
  }
  if (verbose) {
    lines.push('Paths probed:');
    for (const p of report.probed_paths) lines.push(`  ${p.exists ? '[exists] ' : '[absent] '}${p.path}`);
    lines.push('');
    lines.push(
      report.token.present === null
        ? `Token: unknown (${report.token.reason})`
        : `Token: ${report.token.present ? 'present' : 'absent'}${report.token.expires_at ? `, expires ${report.token.expires_at}` : ''}`,
    );
    lines.push('');
    lines.push('Environment:');
    for (const [k, v] of Object.entries(envSnapshot())) lines.push(`  ${k}=${v}`);
    lines.push('');
    // (The deciding signals are already in the header, in every mode.)
    lines.push('');
  }
  // Critical 2: `unknown` must never render as an unqualified all-clear -- a
  // run where every check learned nothing (env bleed, unset CLAUDE_PLUGIN_DATA)
  // used to still print "No blocking problems found.", which is the exact
  // false-confidence failure this diagnostic exists to eliminate, on the exact
  // line the doctor skill tells the agent to relay verbatim.
  const fails = findings.filter((f) => f.status === 'fail').length;
  const unknowns = findings.filter((f) => f.status === 'unknown').length;
  let summary;
  if (fails > 0) {
    summary = `${fails} problem(s) will prevent reviews from running.`;
    if (unknowns > 0) summary += ` ${unknowns} check(s) could not be verified.`;
  } else if (unknowns > 0) {
    summary = `No blocking problems found, but ${unknowns} check(s) could not be verified.`;
  } else {
    summary = 'No blocking problems found.';
  }
  lines.push(summary);
  process.stdout.write(maskToken(`${lines.join('\n')}\n`));
}

main().catch((e) => {
  process.stdout.write(`Prooftrail doctor: ${(e && e.message) || e}\n`);
});
