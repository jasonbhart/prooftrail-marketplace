---
name: prooftrail-setup
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

2. **Point the user to the dashboard.** The dashboard's address is not
   derivable from `SERVICE_URL` alone (`SERVICE_URL` is the review API's
   origin, e.g. `https://api.<your-domain>` — the dashboard may live on a
   different subdomain, and the naming scheme isn't finalized yet, ADR-005).
   Do not guess a URL. Instead:
   - If the user already told you the dashboard address (or it's recorded in
     this workspace's docs), use that.
   - Otherwise, ask the user directly: "What's the URL for your review
     dashboard's setup page?"

   Once you have it, tell them, verbatim-ish:
   > Open **<dashboard URL>** in any browser, sign in, and copy the
   > 8-character setup code. Paste it here.
   The dashboard runs in the user's own browser — no sandbox egress needed for it.

   **Prerequisite:** this plugin's `SERVICE_URL` setting must already be
   configured (Settings → Plugins → prooftrail) — it has no built-in default.
   If it is missing, step 3 below will fail before it ever reaches the
   network, printing `Prooftrail: service URL not configured (set
   REVIEWSVC_URL, or the SERVICE_URL plugin setting).` on stderr. If you see
   that, tell the user to set `SERVICE_URL` in the plugin's settings first,
   then re-run `/prooftrail:setup`.

3. **Exchange the code.** When the user pastes a code like `WXYZ-2345`, run:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/pair.js" <CODE>
   ```
   No env var to set by hand: once installed as a plugin, the `SERVICE_URL`
   setting is exported to this process automatically as
   `CLAUDE_PLUGIN_OPTION_SERVICE_URL`, which `pair.js` resolves the same way
   `review.js` does (env override `REVIEWSVC_URL` first, then the userConfig
   value). The script exchanges the code, writes the token to
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

## Notes
- Tokens are per-surface (host / local-VM / cloud). If the user works across surfaces,
  each pairs once. Sandbox data dirs are ephemeral (exp-05) — `${CLAUDE_PLUGIN_DATA}`
  is wiped per session there, so re-pairing on every sandbox session is impractical.
  For sandbox surfaces, prefer setting the plugin's `API_TOKEN` setting directly
  (a sensitive userConfig value, keychain-backed and exported as
  `CLAUDE_PLUGIN_OPTION_API_TOKEN`) instead of running this pairing flow.
- Never ask the user for the token directly, and never echo it. Only the disposable
  setup code belongs in the conversation.
