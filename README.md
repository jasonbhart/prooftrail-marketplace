# Prooftrail — plugin marketplace

Claude Code / Cowork marketplace hosting the **Prooftrail** plugin: an external
supervisory review gate. A `Stop` hook sends the session's initial prompt, final
message, and optional evidence to a hosted review service, which returns an
advisory verdict.

## Install

```
/plugin marketplace add jasonbhart/prooftrail-marketplace
```

Then install `prooftrail`, set the **`SERVICE_URL`** plugin setting to your review
API origin, and run `/prooftrail:setup` to pair the device.

## What gets sent

On each Stop, the plugin sends the session's initial prompt and final message.
On paid tiers it also attaches evidence:

- **A git diff** — staged and unstaged changes to tracked files, **plus the full
  contents of untracked files** that git does not ignore. That is deliberate: an
  agent that creates new files should have them reviewed. But it means a new,
  untracked, non-gitignored file leaves your machine in full.

  Files whose names match common credential shapes (`.env*`, `*.pem`, `*.key`,
  `id_rsa`, `credentials*`, `secrets.*`, `.aws/`, `.ssh/`, `.npmrc`, …) are
  **withheld**. This removes the common accident; it is not a security boundary,
  and a secret in an ordinarily-named file will still be sent. If your workspace
  holds sensitive material, do not enable diff evidence.

- **A tool-call trace** — one redacted line per call (`<tool> <target> -> ok|error`).
  It never contains tool output.

Nothing is sent at all until you set `SERVICE_URL` and pair.

## Behavior

- **Advisory only.** The hook never blocks. A failure, timeout, unreachable
  service, or exhausted quota passes straight through and the session continues —
  every path exits 0. Reviews are a second opinion, not a gate.
- **`SERVICE_URL` has no default.** The plugin is inert until you set it.
- **Sandbox surfaces**: plugin data is wiped per session, so pairing does not
  persist. Set the `API_TOKEN` plugin setting directly instead of running setup
  each session.
- **Egress**: Cowork sandboxes are default-deny outbound. Allowlist your
  `SERVICE_URL` host under Settings → Capabilities, or every review fails soft
  with a network notice.

## This repo is generated

Everything under `prooftrail/` is built from a private source repo via
`npm run build:plugin` and copied in wholesale — edits there are overwritten on
the next publish. This README is the exception: it has no upstream source and is
maintained here.
