# Prooftrail — plugin marketplace

Claude Code / Cowork marketplace hosting the **Prooftrail** plugin: an external
supervisory review gate. A `Stop` hook sends the session's initial prompt, final
message, and optional evidence (diff + redacted tool trace) to a hosted review
service, which returns an advisory verdict.

## Install

```
/plugin marketplace add jasonbhart/prooftrail-marketplace
```

Then install `prooftrail`, set the **`SERVICE_URL`** plugin setting to your review
API origin, and run `/prooftrail:setup` to pair the device.

## Notes

- **Advisory only.** The hook never blocks; a failure, timeout, or exhausted quota
  passes straight through. Reviews are a second opinion, not a gate.
- **`SERVICE_URL` has no default** — the plugin is inert until you set it.
- **Sandbox surfaces**: plugin data is wiped per session, so pairing does not
  persist. Set the `API_TOKEN` plugin setting directly instead of running setup
  each session.
- **Egress**: Cowork sandboxes are default-deny outbound. Allowlist your
  `SERVICE_URL` host under Settings → Capabilities, or every review fails soft
  with a network notice.

## This repo is generated

Do not edit these files here. They are built from the private source repo via
`npm run build:plugin` and copied in wholesale. Edits made here will be
overwritten on the next publish.
