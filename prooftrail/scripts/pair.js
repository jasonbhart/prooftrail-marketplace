#!/usr/bin/env node
// /prooftrail:setup pairing script (ADR-007). Exchanges a disposable setup code
// (typed by the user, read from argv) for an opaque token, written to
// ${CLAUDE_PLUGIN_DATA}/auth.json. The long-lived token NEVER passes through the
// conversation — only the disposable code does.
//
// Usage: node pair.js <XXXX-XXXX>
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { resolveBaseUrl, detectSurface, checkStateDirOwnership, diagnose } = require('./lib');

async function main() {
  const code = (process.argv[2] || '').trim();
  if (!code) {
    process.stderr.write('Usage: pair.js <setup-code>\n');
    process.exitCode = 2;
    return;
  }
  // T2.2 full (audit-trail tranche, Phase 3): same pin-wins precedence as
  // review.js -- see lib.js's resolveBaseUrl doc comment.
  const { url: baseUrl, envIgnored } = resolveBaseUrl();
  if (envIgnored) {
    process.stderr.write('Prooftrail: ignoring REVIEWSVC_URL — SERVICE_URL is pinned by plugin config.\n');
  }
  if (!baseUrl) {
    process.stderr.write(
      'Prooftrail: service URL not configured (set REVIEWSVC_URL, or the SERVICE_URL plugin setting).\n',
    );
    process.exitCode = 2;
    return;
  }

  // Fix 7: lib.js's stateDir() falls back to os.tmpdir() when
  // CLAUDE_PLUGIN_DATA is unset — fine for non-sensitive state files, but
  // the 90-day token belongs in the plugin's own data dir, never a
  // world-readable shared temp directory. Fail closed here, BEFORE
  // spending the single-use code on an exchange we already know we can't
  // safely persist.
  const dataDir = process.env.CLAUDE_PLUGIN_DATA;
  if (!dataDir) {
    process.stderr.write(
      'Prooftrail: CLAUDE_PLUGIN_DATA is not set — refusing to write the pairing token to a shared temp directory. Re-run from a surface where the plugin data directory is available.\n',
    );
    process.exitCode = 2;
    return;
  }

  // Proven live on the first real install (2026-07-28): pair.js is invoked from
  // the setup skill via a Bash-tool call, and that process inherits a
  // CLAUDE_PLUGIN_DATA belonging to whichever plugin the harness exported --
  // observed pointing at an entirely different plugin, with CLAUDE_PLUGIN_ROOT
  // unset. The write would land a live 90-day token in that other plugin's
  // directory and still report success, because the whoami confirmation below
  // is in-process and cannot see where the file went. Meanwhile the Stop hook,
  // which runs with the CORRECT env, reads the right path, finds nothing, and
  // says "not connected" -- so every retry leaks another token.
  //
  // Fail closed BEFORE spending the single-use code, same as the check above.
  const ownershipError = checkStateDirOwnership(dataDir);
  if (ownershipError) {
    process.stderr.write(`Prooftrail: ${ownershipError}\n`);
    process.exitCode = 2;
    return;
  }

  const exchangeOnce = () =>
    fetch(`${baseUrl.replace(/\/$/, '')}/auth/setup-code/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code,
        device_label: `${require('node:os').hostname()} (${detectSurface()})`,
        surface: detectSurface(),
      }),
      signal: AbortSignal.timeout(30000),
    });

  // Retry ONCE on a 5xx, and only on a 5xx. Observed live 2026-07-27: the very
  // first request to a freshly deployed Worker returned 500 and the identical
  // request succeeded immediately after -- a cold start. A user's first ever
  // pairing attempt is precisely when that is most likely, and a 5xx means the
  // server never redeemed the code, so retrying costs nothing. A 4xx is the
  // opposite: the code is single-use and the server has already ruled on it, so
  // retrying only delays a failure the user must fix with a fresh code.
  let res;
  try {
    res = await exchangeOnce();
    if (res.status >= 500) res = await exchangeOnce();
  } catch {
    process.stderr.write('Prooftrail: could not reach the service to pair.\n');
    process.exitCode = 1;
    return;
  }

  if (!res.ok) {
    let hint = '';
    try {
      const b = await res.json();
      if (b && typeof b.hint === 'string') hint = ` ${b.hint}`;
    } catch {}
    process.stderr.write(`Prooftrail: pairing failed (${res.status}).${hint}\n`);
    process.exitCode = 1;
    return;
  }

  const { token, expires_at } = await res.json();
  if (typeof token !== 'string' || !token) {
    process.stderr.write('Prooftrail: pairing response missing token.\n');
    process.exitCode = 1;
    return;
  }

  fs.mkdirSync(dataDir, { recursive: true });
  const authPath = path.join(dataDir, 'auth.json');
  // Fix 7: writeFileSync's `mode` option only applies when the file is
  // NEWLY created — if auth.json already exists (stale permissions from a
  // previous run, a different umask, or a planted file), writing into it
  // silently keeps whatever mode it already had instead of applying 0600.
  // Remove any existing file first, then create exclusively (`wx`) so the
  // fresh 0600 mode always actually takes effect and we never write
  // through a pre-existing file.
  try {
    fs.unlinkSync(authPath);
  } catch {
    // Nothing to remove (first pair on this surface) — fine.
  }
  fs.writeFileSync(authPath, JSON.stringify({ token, expires_at: expires_at ?? null }), {
    mode: 0o600,
    flag: 'wx',
  });

  // Fix 5: confirm the pair stuck IN-PROCESS instead of the setup skill
  // shelling out to curl with the token interpolated into argv (visible in
  // `ps`/`/proc` to any local user, and captured by shell history / command
  // auditing). The token is used here only as a fetch header — it never
  // leaves this process, and is never printed.
  process.stdout.write(`${await checkWhoami(baseUrl, token)}\n`);

  // Static checks only. Liveness is excluded on purpose: the plugin was just
  // installed mid-session, so its hooks are legitimately not wired yet and a
  // liveness check here would false-alarm on every first-time install. A
  // duplicate install, by contrast, is visible on disk regardless of timing --
  // and pairing is the one moment the user is definitely paying attention.
  try {
    const problems = (await diagnose({ static: true })).filter((f) => f.status === 'fail');
    for (const f of problems) {
      process.stdout.write(`\nProoftrail: ${f.title}\n${f.detail}\n`);
      if (f.remedy) process.stdout.write(`→ ${f.remedy}\n`);
    }
  } catch {
    // Fail-soft: pairing succeeded; a diagnostic problem must never mask that.
  }
}

/**
 * Confirms a freshly-written token actually works by calling /auth/whoami
 * in-process. A whoami failure of any kind must NEVER fail pairing itself —
 * the token file is already written by the time this runs — so this always
 * resolves to a message string rather than throwing, and main() never
 * inspects the result beyond printing it.
 */
async function checkWhoami(baseUrl, token) {
  let res;
  try {
    res = await fetch(`${baseUrl.replace(/\/$/, '')}/auth/whoami`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    // Network failure confirming the pair (offline, DNS, etc.) — the token
    // is already on disk, so this is not a failure to re-pair over.
    return "Prooftrail: connected, but couldn't confirm right now — do not re-pair.";
  }

  if (res.status === 401) {
    // The token we JUST wrote isn't recognized — genuinely didn't stick.
    return 'Prooftrail: pairing did not stick (token not recognized) — please re-run setup.';
  }
  if (res.status !== 200) {
    // Includes 503 auth_unavailable (backend outage): distinguishable from
    // 401 so the agent never tells the user to burn a fresh single-use code
    // on a pair that actually succeeded.
    return "Prooftrail: connected, but couldn't confirm right now — do not re-pair.";
  }

  let body;
  try {
    body = await res.json();
  } catch {
    return "Prooftrail: connected, but couldn't confirm right now — do not re-pair.";
  }
  const label = typeof body?.label === 'string' && body.label ? body.label : 'this surface';
  const plan = typeof body?.plan === 'string' && body.plan ? body.plan : 'free';
  const used = typeof body?.usage?.used === 'number' ? body.usage.used : '?';
  const limit = typeof body?.usage?.limit === 'number' ? body.usage.limit : '?';
  return `Prooftrail: connected as ${label} (${plan}, ${used}/${limit} reviews).`;
}

main().catch((e) => {
  process.stderr.write(`Prooftrail: pairing error: ${(e && e.message) || e}\n`);
  process.exitCode = 1;
});
