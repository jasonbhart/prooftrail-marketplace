---
name: doctor
description: Check whether Prooftrail is correctly installed and actually running, and print diagnostic evidence. Use when the user runs /prooftrail:doctor, asks why reviews are not appearing, reports that Prooftrail seems to do nothing, or needs to gather information for a bug report.
---

# Prooftrail doctor

Reports whether this install can actually run reviews, and why not if it cannot.
Reviews failing silently is the plugin's most common failure mode: hooks can be
dropped by the install channel or by a duplicate install, and a hook that never
runs cannot report its own absence.

## Steps

1. **Run the diagnostic.** Run **exactly this**, including both environment
   variables:

   ```bash
   CLAUDE_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA}" \
   CLAUDE_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT}" \
   CLAUDE_PLUGIN_OPTION_SERVICE_URL="${CLAUDE_PLUGIN_OPTION_SERVICE_URL}" \
   node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.js"
   ```

   **Do not drop those env vars.** A Bash tool call does NOT inherit this
   plugin's hook environment — verified on a real install 2026-07-28, where the
   ambient `CLAUDE_PLUGIN_DATA` pointed at a *different* installed plugin's data
   directory and `CLAUDE_PLUGIN_ROOT` was unset entirely. Without the overrides
   the diagnostic inspects the wrong directory and reports confident nonsense.
   The values above are interpolated from this skill's own context, which is
   correct; the process environment is not. `CLAUDE_PLUGIN_ROOT` must be passed
   explicitly too, not just used to locate the script — the doctor's own checks
   read it from its process environment.

2. **Relay the output verbatim.** It is already written for the user — do not
   re-derive, re-check, or summarize away the remedies. Each `FAIL` line is
   followed by a `→` remedy that is the action to take.

3. **If the user is filing a bug report or the surface is unfamiliar**, re-run
   with `--verbose` appended (or `--json` for machine-readable output) and relay
   that instead. It adds every path probed, every copy of the plugin found, and
   the `CLAUDE_*` environment. This is how an unsupported surface gets diagnosed
   without anyone needing access to the machine.

## Notes

- The report never contains the device token in any mode, by design (ADR-007).
  It reports only whether a token is present.
- It reports real paths and hostnames without redaction — that is deliberate, and
  is what makes the output useful to paste.
- `unknown` means the check could not inspect anything on this surface, NOT that
  everything is fine. If you see `unknown`, use `--verbose`.
- The doctor never blocks anything and always exits 0. It is a diagnostic, not a gate.
