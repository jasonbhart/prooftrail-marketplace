# Prooftrail — plugin marketplace

Claude Code / Cowork marketplace hosting the **Prooftrail** plugin: it checks
whether your AI coding agent followed **the rules you set**, at the end of every
turn.

Your rules live on the service so the agent cannot edit them; the checking runs
on your machine, where the evidence actually is.

## Install

```
/plugin marketplace add jasonbhart/prooftrail-marketplace
```

Then install `prooftrail` and run **`/prooftrail:setup`** to connect it.

> **Changed in 0.8.0, and it is a breaking change.** Rules used to be written in
> your `AGENTS.md`. They are not read from any file any more, and **an
> unconnected install performs no checks at all.**
>
> The reason is the point of the product: a file in your repo is a file the
> agent being checked can edit. It could downgrade its own enforcement level, or
> delete a rule it kept failing, and nothing would notice. Rules now live on the
> service, signed, and the client verifies that signature before trusting them.

## Your rules, set once, enforced on your machine

Set them at **[the dashboard](https://supervisor-dashboard.pages.dev/rules)** —
a list of checks, each `off`, `inform` (tell the agent) or `block` (the agent
cannot end its turn until it is addressed). Your machine does the checking, from
the session's own tool calls:

| Rule you wrote | What it checks |
|---|---|
| "Always run the tests after changing code" | whether a test command actually ran this turn |
| "All tests must pass" | whether the most recent test run errored |
| "Run lint / typecheck / build" | same, per category |
| "Don't claim done until it's verified" | whether verification ran **after** the last code edit |
| "Never commit without asking" | reports when a commit/push happened — it does not judge whether you approved it |

**The checking still runs entirely on your machine** — no model is called for it
and your code is never sent anywhere, which is why it can read the full command
text a redacted payload could never carry. What comes from the service is the
rule *definitions*, so the agent cannot quietly weaken them. ~240 ms on a 15 MB
session transcript.

**Offline is fine.** The verified rule set is cached, so an outage keeps your
checks running. After a week without contact a `block` softens to `inform`, so a
stale rule cannot halt your work indefinitely.

**Rules it cannot check are named, not silently ignored.** "Follow existing
patterns", "handle errors properly", "stay in scope" — these have no
deterministic answer, so Prooftrail says so rather than pretending.

**No rules set yet? It offers checks based on commands your repo already documents.**
Most of a real `AGENTS.md` is reference, not rules — across 2,203 public repos,
35% document a test command and only 23% state it as a rule. If your file has a
commands section, Prooftrail proposes the exact line to paste:

```
Turn on the `tests-ran` check — this repo documents `npm test`.
```

That offer appears **at most once per session**, and only when nothing is
checkable yet — if you already have a working gate you will never see it. Run
**`/prooftrail:rules`** any time for the full picture: what is checked, what is
not checkable, and every gate available to you.

**A check your project can't satisfy is withdrawn, and explained.** Switch on
`lint-ran` in a project with no linter and the check can never pass, no matter
what the agent does. Rather than repeat that every turn, Prooftrail withdraws it
and tells you which check, why, and both ways to fix it — switch it off, or add
the tool. The agent is told separately that the check was withdrawn and that it
should *not* go install the tool on its own.

**"Unknown" is never reported as a pass.** If no test ran at all, a "tests must
pass" rule comes back *unknown*, not *satisfied*.

### You choose what each check does when it fails

Per check, in the dashboard:

| Level | What happens |
|---|---|
| `inform` | The agent is told, and can act on it. The turn still ends. |
| `block` | The agent **cannot end the turn** until it's addressed. |
| `notify` | Only you are told. The agent is not steered. |
| `off` | Not checked. |

`block` is deliberately hard to misuse. It fires **at most once per turn**, it
is skipped when the fix isn't available (no test command in the repo means "run
the tests" is not a fair demand), and it stands down when the agent says it
can't proceed. In every one of those cases the finding still reaches the agent —
only its power to halt the turn is dropped. A gate you can argue with beats one
that loops on your session quota.

One honest limit of this local half: a command's outcome is the **tool call's**
own status. A piped command or one ending in `... || true` reports success even
when it failed underneath, and the rules engine cannot see that — reading
command output would mean sending it, which the design forbids. The optional
deep check below is how that gets caught, by running the command itself instead
of reading a claim about it.

## Optional: deep claim checks with an agent you already have

Some claims leave **no trace at all**. *"I added error handling to X."* *"This is
backwards compatible."* *"I refactored Y to use Z."* Nothing in a session trace
can confirm or deny those — and a command ending in `|| true` reports success
even when it failed underneath.

If you have `codex` or `agy` installed, set the
**`LOCAL_AGENT`** plugin setting to `auto` (or name one). When a final message
claims something the trace cannot support, Prooftrail asks that CLI to check it
against your actual repository:

```
Prooftrail (agy, last turn): a claim did NOT hold up.
  claim: "I added a guard so a discount over 100% cannot produce a negative
          total, and all tests pass."
  FALSE. billing.js contains no guard preventing a discount over 100% from
  producing a negative total — line 3 simply returns total - total * (pct/100).
```

- **Off unless you set it.** It spends your model quota, so it is never a default.
- **Read-only.** Pinned by the CLI's own sandbox flag, not just by asking nicely.
  It cannot edit, create, delete or commit anything.
- **Runs in the background.** Your turn is never slowed; the answer arrives on
  the next one.
- **Only when there is a real question** — a claim of verification the session
  cannot back up.
- **Nothing leaves your machine.** Your repository is read in place by a tool you
  already trust, on your own credentials.

Only `codex` and `agy` are supported, and both were run end to end before
shipping. `opencode` is deliberately excluded — it has no read-only mode, only
`--dangerously-skip-permissions` or a default that would sit waiting for
approval in a background job. An adapter ships here only if it can be pinned
read-only and has actually been run.

Honest limits: it is an LLM, so it is advisory like everything else here and it
never blocks. It is told to answer UNVERIFIABLE rather than guess, and when a
claim checks out it says nothing at all. If your agent CLI is not logged in it
will say so rather than quietly doing nothing.

## The optional hosted half

`/prooftrail:setup` pairs your device and adds a hosted judge for the rules that
genuinely need judgment rather than computation — did the work match the ask,
is every claim in the final message supported by what actually happened.

**What gets sent, if you enable it:**

- **The session's ask and the agent's final message.**
- **A tool-call trace** — one redacted line per call
  (`<tool> [category] <target> -> ok|error`). It never contains tool output.
- **A git diff**, when the working directory is a repo — staged and unstaged
  changes to tracked files, **plus the full contents of untracked files** that
  git does not ignore. That is deliberate: an agent that creates new files
  should have them reviewed. But it means a new, untracked, non-gitignored file
  leaves your machine in full.

  Files whose names match common credential shapes (`.env*`, `*.pem`, `*.key`,
  `id_rsa`, `credentials*`, `secrets.*`, `.aws/`, `.ssh/`, `.npmrc`, …) are
  **withheld**. This removes the common accident; it is not a security boundary,
  and a secret in an ordinarily-named file will still be sent. If your workspace
  holds sensitive material, do not enable diff evidence.

The payload is judged and discarded. What is kept is the verdict, the findings,
and a content hash — never your code.

## Behavior

- **Advisory by default.** Nothing blocks unless you marked a rule `[block]`
  yourself. A failure, timeout, unreachable service, or exhausted quota passes
  straight through and the session continues — every path exits 0.
- **The hosted judge never blocks, at all.** Only your own mechanically-checked
  rules can, and only the ones you marked. A judged verdict is a second opinion,
  not a gate.
- **Local findings survive a service outage.** They needed no network to
  produce, so losing the network does not lose them.
- **`SERVICE_URL` ships with a default** pointing at the hosted service.
  Override it only for a self-hosted deployment.
- **Sandbox surfaces**: plugin data is wiped per session, so pairing does not
  persist. Set the `API_TOKEN` plugin setting directly instead of running setup
  each session.
- **Egress**: Cowork sandboxes are default-deny outbound. Allowlist your
  `SERVICE_URL` host under Settings → Capabilities, or hosted reviews fail soft
  with a network notice. Local rule checking is unaffected.

## This repo is generated

Everything under `prooftrail/` is built from a private source repo via
`npm run build:plugin` and copied in wholesale — edits there are overwritten on
the next publish. This README is the exception: it has no upstream source and is
maintained here.
