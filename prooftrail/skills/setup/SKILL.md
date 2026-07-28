---
name: setup
description: Connect this workspace to the supervisory review service. Use when the user runs /prooftrail:setup, asks to connect/pair/authenticate the prooftrail plugin, or when a review was skipped because the plugin is not connected.
---

# Prooftrail setup (pairing)

Connect the plugin to the review service by exchanging a short-lived setup code for
a device token. The token is written to the plugin's data directory; the setup code
is the only thing the user pastes into the conversation (ADR-007 — the long-lived
token never transits chat).

## Steps

1. **Check if already connected.** If `${CLAUDE_PLUGIN_DATA}/auth.json` exists and is
   non-empty, tell the user they're already connected and stop (offer to re-pair only
   if they ask).

2. **Point the user to the dashboard.** The dashboard's address is not derivable
   from `SERVICE_URL` (that is the review API's origin; the dashboard is a
   separate origin). The current dashboard is:

   **https://supervisor-dashboard.pages.dev/setup**

   Tell the user, verbatim-ish:
   > Open **https://supervisor-dashboard.pages.dev/setup** in any browser, sign
   > in, and copy the 8-character setup code. Paste it here.

   The dashboard runs in the user's own browser — no sandbox egress needed for it.

   If that address does not work (self-hosted, or the service has since moved to
   its own domain), ask the user: "What's the URL for your review dashboard's
   setup page?" — and use what they give you. Do not invent a different one; in
   particular do NOT guess a hostname from the product name, as the dashboard
   origin does not track the product name.

   **Prerequisite:** this plugin's `SERVICE_URL` setting must already be
   configured (Settings → Plugins → prooftrail) — it has no built-in default.
   If it is missing, step 3 below will fail before it ever reaches the
   network, printing `Prooftrail: service URL not configured (set
   REVIEWSVC_URL, or the SERVICE_URL plugin setting).` on stderr. If you see
   that, tell the user to set `SERVICE_URL` in the plugin's settings first,
   then re-run `/prooftrail:setup`.

3. **Exchange the code.** When the user pastes a code like `WXYZ-2345`, run
   **exactly this**, including both environment variables:

   ```bash
   CLAUDE_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA}" \
   CLAUDE_PLUGIN_OPTION_SERVICE_URL="${CLAUDE_PLUGIN_OPTION_SERVICE_URL}" \
   node "${CLAUDE_PLUGIN_ROOT}/scripts/pair.js" <CODE>
   ```

   **Do not drop those env vars, and do not assume the plugin's settings reach
   this process.** They do not. A Bash tool call does NOT inherit this plugin's
   hook environment — verified on a real install 2026-07-28, where the ambient
   `CLAUDE_PLUGIN_DATA` pointed at a *different installed plugin's* data
   directory and `CLAUDE_PLUGIN_ROOT` was unset entirely. Without the override,
   `pair.js` would write this plugin's live 90-day token into that other
   plugin's directory and still print success, while the Stop hook (which runs
   with the correct environment) looks in the right place, finds nothing, and
   reports "not connected" forever — so each retry leaks another token. The
   values above are interpolated from the skill's own context, which is correct;
   the process environment is not. `pair.js` now also refuses outright if it
   detects it is about to write into another plugin's directory.

   If it prints `service URL not configured`, the `SERVICE_URL` setting did not
   reach the process. Ask the user for the review API origin and retry with it
   supplied explicitly:

   ```bash
   CLAUDE_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA}" \
   REVIEWSVC_URL="<origin the user gave>" \
   node "${CLAUDE_PLUGIN_ROOT}/scripts/pair.js" <CODE>
   ```

   A failure here happens *before* any network call, so the setup code is NOT
   consumed — reuse the same one.

   The script exchanges the code, writes the token to
   `${CLAUDE_PLUGIN_DATA}/auth.json` (mode 0600), and then confirms the pair
   stuck by calling `/auth/whoami` **in-process** — the token never transits
   a subprocess argv (and so never appears in `ps`/`/proc` or shell history).

4. **Relay the script's own stdout to the user, verbatim.** `pair.js` already prints
   exactly one of these lines — do not re-derive or re-check anything yourself:
   - `Prooftrail: connected as <label> (<plan>, <used>/<limit> reviews).` — pairing
     confirmed; relay it as-is.
   - `Prooftrail: pairing did not stick (token not recognized) — please re-run setup.`
     — tell the user to re-run `/prooftrail:setup` with a fresh code.
   - `Prooftrail: connected, but couldn't confirm right now — do not re-pair.` — the
     service couldn't be reached to confirm (e.g. a transient outage), but pairing
     itself succeeded; tell the user they're connected and NOT to request a new code.

   If the script exits non-zero instead, relay its stderr (e.g. "request a fresh
   code") — codes are single-use and expire in 10 minutes — and stop.

5. **Tell the user to restart their session — pairing alone does NOT start reviews.**
   On a successful pair, always finish with:

   > Restart your Claude Code session to activate reviews. Pairing is saved, but
   > the hooks don't start firing until a session that begins after the install.

   This is not optional politeness. Claude Code snapshots plugin state at session
   start (docs/05 bug register, upstream #68020), so a plugin installed mid-session
   has its **skill** available immediately — which is how this pairing flow ran at
   all — while its **hooks are not wired**. Verified 2026-07-28 on a real install:
   after a successful pair, the session ended and *nothing happened*. No captured
   prompt, no review, no notice. Every visible signal said it was working.

   That silence is the failure mode to prevent: the user sees the skill appear,
   pairs, gets `connected as … (free, N/50 reviews)`, and concludes the product is
   running when it is completely inert. Say the restart line every time.

## Notes
- Tokens are per-surface (host / local-VM / cloud). If the user works across surfaces,
  each pairs once. Sandbox data dirs are ephemeral (exp-05) — `${CLAUDE_PLUGIN_DATA}`
  is wiped per session there, so re-pairing on every sandbox session is impractical.
  For sandbox surfaces, prefer setting the plugin's `API_TOKEN` setting directly
  (a sensitive userConfig value, keychain-backed and exported as
  `CLAUDE_PLUGIN_OPTION_API_TOKEN`) instead of running this pairing flow.
- Never ask the user for the token directly, and never echo it. Only the disposable
  setup code belongs in the conversation.
