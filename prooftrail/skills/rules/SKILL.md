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
   const C=require(process.env.CLAUDE_PLUGIN_ROOT+"/scripts/rules-cache.js");
   const cached=C.readRulesCache();
   const r=R.runLocalRules(process.cwd(),null,cached);
   if(!cached){console.log("No rules configured, or not connected — run /prooftrail:setup. Rules come from the connected account, not from a repo file.");}
   else{
     console.log("Rule set version "+cached.version+(cached.stale?" (STALE — "+Math.round(cached.age_days)+" day(s) old; block enforcement is demoted to inform until the next successful review)":""));
     console.log("Deep check: "+cached.rules["deep-check"]);
   }
   console.log("");
   const chk=r.rules.filter(x=>x.computable), un=r.rules.filter(x=>!x.computable);
   console.log("CHECKED MECHANICALLY ("+chk.length+"):");
   for(const x of chk)console.log("  ["+x.family+"] "+x.label+" ("+x.enforcement+")");
   console.log("\nWRITTEN BUT NOT CHECKABLE ("+un.length+"):");
   for(const x of un)console.log("  ["+x.family+"] "+x.label+" ("+x.enforcement+")");
   if(r.unknown>0)console.log("\n"+r.unknown+" check(s) from the account are unrecognised by this plugin version — update the plugin.");
   console.log("\nGATES AVAILABLE FROM COMMANDS YOU ALREADY DOCUMENT ("+r.allOffers.length+"):");
   for(const o of r.allOffers)console.log("  "+o.hint);
   console.log("\nAll documented commands found"+(r.sources.length?" in "+r.sources.join(", "):" (no AGENTS.md/CLAUDE.md found)")+":");
   for(const c of r.commands)console.log("  ["+c.category+"] "+c.command);
   console.log("\nManage your rules at https://supervisor-dashboard.pages.dev/rules");
   '
   ```

2. **Report what it printed.** Present the sections plainly. Do not re-run it
   with modifications and do not summarise away the "not checkable" list --
   naming what is *not* checked is the point of that section. The rule set
   version and staleness line come straight from the signed cache -- they are
   what the SERVER last sent this machine, not anything read from the repo.

3. **If gates are available**, those are commands the user's AGENTS.md/CLAUDE.md
   already documents that have no matching rule turned on in their account.
   Point them at the dashboard link printed above (or `/prooftrail:setup`) to
   turn the check on -- these are no longer enabled by editing the repo file,
   since a rule read from a repo file the agent can edit could never carry an
   integrity guarantee.

4. **If no rules are configured** (`cached` is null above), say so plainly and
   send the user to `/prooftrail:setup`. Do not offer to create or edit an
   AGENTS.md to define rules — that mechanism is gone; rules are set on the
   connected account.

## What to tell the user about the two categories

- **Checked mechanically** means decided on their machine from the session's
  own tool calls: no model, no network round-trip at review time, and no
  judgment involved. It DOES require a connected account -- the rule
  definitions themselves are fetched and signed by the service, cached
  locally, and evaluated offline; a never-connected install has an empty
  cache and checks nothing.
- **Not checkable** means no deterministic answer exists — "follow existing
  patterns", "handle errors properly", "stay in scope". Prooftrail names these
  rather than pretending to score them. If the user has the hosted judge
  enabled, some judgment-shaped rules are still evaluated there, but the
  mechanical engine does not claim them.

Be accurate about the limit: an outcome of `ok` means the **tool call** did not
error, not that the command succeeded. A piped command or one ending in
`|| true` reports `ok` even when it failed underneath.
