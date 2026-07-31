---
name: rules
description: Show which of the user's rules Prooftrail checks, which it cannot check, and which gates it could enable from commands their AGENTS.md or CLAUDE.md already documents. Use when the user runs /prooftrail:rules, asks what Prooftrail is checking, asks why a rule of theirs was not enforced, or wants to know what rules to write.
---

# What Prooftrail checks

Reports exactly which of the user's own rules are being enforced, which are not,
and what could be turned on for free. Run it in the project the user is asking
about — discovery starts at the working directory.

## Steps

1. **Run the report.** Run **exactly this** from the project root:

   ```bash
   node -e '
   const R=require(process.env.CLAUDE_PLUGIN_ROOT+"/scripts/rules.js");
   const L=require(process.env.CLAUDE_PLUGIN_ROOT+"/scripts/lib.js");
   const r=R.runLocalRules(process.cwd(),null);
   if(!r){console.log("No AGENTS.md, CLAUDE.md or .cursorrules found from "+process.cwd());process.exit(0);}
   console.log("Rules file(s): "+r.sources.join(", ")+"\n");
   const chk=r.rules.filter(x=>x.computable), un=r.rules.filter(x=>!x.computable);
   console.log("CHECKED MECHANICALLY ("+chk.length+"):");
   for(const x of chk)console.log("  ["+x.family+"] "+x.text);
   console.log("\nWRITTEN BUT NOT CHECKABLE ("+un.length+"):");
   for(const x of un)console.log("  ["+x.family+"] "+x.text);
   console.log("\nGATES AVAILABLE FROM COMMANDS YOU ALREADY DOCUMENT ("+r.allOffers.length+"):");
   for(const o of r.allOffers)console.log("  "+o.line);
   console.log("\nAll documented commands found:");
   for(const c of r.commands)console.log("  ["+c.category+"] "+c.command);
   '
   ```

2. **Report what it printed.** Present the four sections plainly. Do not
   re-run it with modifications and do not summarise away the "not checkable"
   list — naming what is *not* checked is the point of that section.

3. **If gates are available**, offer to append those exact lines to the rules
   file. Ask first; do not edit the file unprompted. The lines are ready to
   paste as printed.

4. **If no rules file was found**, say so and offer to create an `AGENTS.md`.
   Suggest starting with rules that are checked mechanically — running tests,
   running lint/typecheck/build, and not claiming done before verifying.

## What to tell the user about the two categories

- **Checked mechanically** means decided on their machine from the session's
  own tool calls: no model, no network, no account, and no judgment involved.
- **Not checkable** means no deterministic answer exists — "follow existing
  patterns", "handle errors properly", "stay in scope". Prooftrail names these
  rather than pretending to score them. If the user has the hosted judge
  enabled, some judgment-shaped rules are still evaluated there, but the
  mechanical engine does not claim them.

Be accurate about the limit: an outcome of `ok` means the **tool call** did not
error, not that the command succeeded. A piped command or one ending in
`|| true` reports `ok` even when it failed underneath.
