'use strict';
/**
 * Delegate a DIRECTED claim check to an agentic CLI already installed locally.
 *
 * WHY THIS EXISTS.
 *
 * `docs/02-system-design.md` states the limit this closes, and states it as
 * deferred: *"`-> ok` means the tool call did not error, not that the command
 * succeeded... Catching a masked failure needs the command's output, which
 * ADR-009's redaction boundary excludes by construction. That remains
 * deferred."*
 *
 * A local agent does not need the output shipped anywhere — it can read the
 * repository itself. That covers the entire class of claims no payload can
 * ever carry: *"I added error handling to X"*, *"this is backwards
 * compatible"*, *"I refactored Y to use Z"*. The trace records that `Edit`
 * touched a file, never whether the assertion about it is true.
 *
 * Three properties make this the right shape rather than just a bigger hammer:
 *
 *  - **Zero COGS.** It runs on the user's own credentials, so the deep check
 *    costs the service nothing. That removes the structurally unwinnable
 *    problem of buying inference to compete with inference the user's own
 *    subscription already covers.
 *  - **Nothing leaves the machine.** Strictly stronger than the hosted judge's
 *    posture, not weaker: the repository is read in place and no payload is
 *    assembled at all.
 *  - **It is DIRECTED, never open-ended.** The local rules engine already knows
 *    *which* claim is uncorroborated and *why*. Asking "is this one claim true"
 *    is faster, cheaper and far less false-positive-prone than "review this
 *    code", and it is the only version that fits a hook's budget.
 *
 * DESIGN DECISIONS (Jason, 2026-07-31), each of which constrains the code:
 *
 *  1. **Detached, reported next turn.** The Stop hook's own budget is 45s
 *     against a 60s timeout; a real agentic review takes minutes. So the job is
 *     spawned, unref'd, and its answer surfaces on the FOLLOWING Stop. Latency
 *     added to the current turn is the cost of one `spawn`.
 *  2. **Read-only.** `codex --sandbox read-only`, `agy --sandbox`, and the
 *     prompt says so too. A Stop hook that spawns a shell-capable agent
 *     inheriting the user's credentials is a genuinely new security surface for
 *     this product, and the conservative default is the shippable one.
 *  3. **Opt-in, and only on an uncorroborated claim.** Off unless the user
 *     enables it. Once on, it fires only when the final message asserts
 *     something the trace cannot support — so it spends the user's tokens only
 *     when there is a real question to answer.
 *
 * Fail-soft like everything else here (ADR-004): every function returns null or
 * a no-op rather than throwing. A delegation failure must never break a
 * session, and never blocks regardless of what it finds.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { stateDir, safeSessionId } = require('./lib');

/** Marks a spawned child so its own Stop hook exits immediately (see below). */
const RECURSION_ENV = 'PROOFTRAIL_DELEGATE';

/**
 * Adapters for the CLIs this can drive, in preference order.
 *
 * `outputMode: 'file'` means the CLI writes its final answer to a path we
 * supply, which is cleaner than scraping stdout past progress chatter.
 * `'stdout'` means we redirect fd 1 to the file ourselves — uniform enough that
 * an adapter needs no other special-casing.
 *
 * Every argv here pins the CLI to a READ-ONLY policy where it has one. That is
 * decision 2 above, and it is enforced in the argv rather than only in the
 * prompt, because a prompt is a request and a flag is a constraint.
 */
const ADAPTERS = [
  {
    name: 'codex',
    bin: 'codex',
    outputMode: 'file',
    argv: (prompt, outFile) => [
      'exec',
      '--sandbox', 'read-only',
      '--skip-git-repo-check',
      '--output-last-message', outFile,
      prompt,
    ],
  },
  {
    name: 'agy',
    bin: 'agy',
    outputMode: 'stdout',
    argv: (prompt) => ['--sandbox', '--print', prompt],
  },
  {
    name: 'gemini',
    bin: 'gemini',
    outputMode: 'stdout',
    argv: (prompt) => ['--prompt', prompt],
  },
  {
    name: 'opencode',
    bin: 'opencode',
    outputMode: 'stdout',
    argv: (prompt) => ['run', prompt],
  },
];

/**
 * `PATH` lookup with no shell, so a path with spaces cannot become an exec.
 *
 * `env` is a REQUIRED input, not a convenience: reading `process.env.PATH` here
 * while callers pass an explicit env made `detectAgent({PATH: '/nonexistent'})`
 * resolve the real binary anyway, and a test that meant to use a stub CLI
 * spawned the user's actual agent against their real quota. An env parameter
 * that is silently ignored is worse than no parameter.
 */
function which(bin, env = process.env) {
  const dirs = String((env && env.PATH) || '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    const p = path.join(d, bin);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/**
 * The adapter to use, or `null`.
 *
 * `PROOFTRAIL_LOCAL_AGENT` is the opt-in (decision 3): unset means OFF, `1` or
 * `auto` means "use whichever is installed", and a name pins one. Never
 * auto-enables — spending a user's model quota is not a default.
 */
function detectAgent(env = process.env) {
  const opt = String(env.PROOFTRAIL_LOCAL_AGENT || env.CLAUDE_PLUGIN_OPTION_LOCAL_AGENT || '').trim();
  if (!opt || opt === '0' || opt.toLowerCase() === 'off') return null;
  const wanted = opt === '1' || opt.toLowerCase() === 'auto' ? null : opt.toLowerCase();
  for (const a of ADAPTERS) {
    if (wanted && a.name !== wanted) continue;
    const bin = which(a.bin, env);
    if (bin) return { ...a, path: bin };
  }
  return null;
}

/**
 * Sentences asserting that verification happened or succeeded.
 *
 * Named for what it MATCHES, not what it proves. A match is only ever used to
 * decide whether to ASK a question — it is never attested to the judge and
 * never becomes a finding on its own. That distinction is why a heuristic is
 * acceptable here and was not acceptable in `attested`.
 */
const VERIFICATION_CLAIM =
  /\b(?:tests?|suite|specs?|checks?|lint|build|typecheck|type-check|everything|all)\b[^.!?\n]{0,60}\b(?:pass(?:ed|ing|es)?|green|clean|succeed(?:ed|s)?|working|works|fine|good)\b|\b(?:verified|confirmed|double-checked|validated)\b/i;

/** First sentence of `text` that reads as a verification claim, else null. */
function findClaimSentence(text) {
  if (!text || typeof text !== 'string') return null;
  for (const raw of text.split(/(?<=[.!?\n])\s+/)) {
    const s = raw.trim();
    if (s.length < 8 || s.length > 400) continue;
    if (VERIFICATION_CLAIM.test(s)) return s.replace(/\s+/g, ' ');
  }
  return null;
}

/**
 * Claims the trace cannot corroborate, given locally computed facts.
 *
 * Deliberately independent of whether the user wrote any rule: the rules engine
 * only speaks when a rule exists, while a false "tests pass" is worth checking
 * whether or not anyone wrote a rule about tests.
 *
 * Returns `[]` — never a guess — when facts are unavailable. Unknown is not a
 * problem, and unknown is certainly not a violation.
 */
function detectUncorroboratedClaims(finalMessage, facts) {
  if (!facts) return [];
  const claim = findClaimSentence(finalMessage);
  if (!claim) return [];
  const ran = facts.categories || [];
  const outcome = facts.last_outcome || {};
  const verifying = ['test', 'build', 'lint', 'typecheck'].filter((c) => ran.includes(c));

  if (verifying.length === 0) {
    if ((facts.code_edits || 0) === 0) return []; // nothing changed; nothing to doubt
    return [{ claim, why: 'no test, build, lint or typecheck command ran in this session at all' }];
  }
  if (verifying.some((c) => outcome[c] === 'error')) {
    const bad = verifying.filter((c) => outcome[c] === 'error').join(', ');
    return [{ claim, why: `the most recent ${bad} run reported an error` }];
  }
  if (facts.ran_after_last_edit === false) {
    return [{ claim, why: 'the last code edit came AFTER the last verifying command, so the run is stale' }];
  }
  return [];
}

/**
 * The directed question. Narrow on purpose — see the DIRECTED note above.
 *
 * The read-only instruction is repeated here even though the argv already pins
 * it, because the two protect against different things: the flag stops the
 * agent from writing, this stops it from *trying* and reporting the attempt as
 * work done.
 */
function buildPrompt(claims, facts) {
  const c = claims[0];
  const edited = facts && facts.code_edits ? `${facts.code_edits} code file(s) were changed.` : '';
  return [
    'You are checking ONE specific claim an AI coding agent just made about work it says it completed.',
    '',
    `CLAIM: "${c.claim}"`,
    `WHY IT IS IN DOUBT: ${c.why}.`,
    edited,
    '',
    'Inspect the repository and decide whether that claim is TRUE, FALSE, or UNVERIFIABLE.',
    'Run the project\'s own tests or checks ONLY if you can do so without modifying anything.',
    'Do not edit, create or delete any file. Do not commit. Do not install anything.',
    '',
    'Answer in under 80 words, starting with exactly one of TRUE / FALSE / UNVERIFIABLE,',
    'then one sentence of evidence citing file:line where you can.',
    'If you cannot determine it, say UNVERIFIABLE — do not guess.',
  ]
    .filter(Boolean)
    .join('\n');
}

const jobPath = (sessionId) => path.join(stateDir(), `delegate-${safeSessionId(sessionId)}.json`);
const outPath = (sessionId) => path.join(stateDir(), `delegate-${safeSessionId(sessionId)}.out`);

/** Is a pid still running? `signal 0` tests existence without delivering one. */
function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM'; // alive but not ours
  }
}

/**
 * Start a detached job. Returns the adapter name, or null when nothing ran.
 *
 * The child is fully detached and `unref`'d so this process can exit while it
 * keeps working — that is what makes decision 1 possible at all.
 *
 * RECURSION: the child inherits the environment, and if it is itself a
 * Claude Code CLI it will load this very plugin and fire its own Stop hook.
 * `PROOFTRAIL_DELEGATE=1` marks it, and `review.js` exits immediately when it
 * sees that. Without this the hook spawns an agent that spawns an agent.
 */
function startJob(sessionId, cwd, claims, facts, env = process.env) {
  try {
    if (env[RECURSION_ENV]) return null; // we ARE a delegated child
    const agent = detectAgent(env);
    if (!agent || !claims || claims.length === 0) return null;

    const job = jobPath(sessionId);
    const out = outPath(sessionId);
    // One job per session at a time: a still-running job must not be replaced,
    // and a finished one must be read before another starts.
    try {
      const prev = JSON.parse(fs.readFileSync(job, 'utf8'));
      if (isAlive(prev.pid) || fs.existsSync(out)) return null;
    } catch {
      /* no previous job */
    }

    const prompt = buildPrompt(claims, facts);
    let stdio = ['ignore', 'ignore', 'ignore'];
    let fd = null;
    if (agent.outputMode === 'stdout') {
      fd = fs.openSync(out, 'w');
      stdio = ['ignore', fd, 'ignore'];
    }
    const child = spawn(agent.path, agent.argv(prompt, out), {
      cwd: cwd || process.cwd(),
      env: { ...env, [RECURSION_ENV]: '1' },
      detached: true,
      stdio,
    });
    if (fd !== null) fs.closeSync(fd);
    child.unref();

    fs.writeFileSync(
      job,
      JSON.stringify({ pid: child.pid, agent: agent.name, started: Date.now(), claim: claims[0].claim }),
    );
    return agent.name;
  } catch {
    return null; // fail-soft: never break a session over an optional check
  }
}

/** Jobs older than this are abandoned rather than waited on forever. */
const JOB_MAX_AGE_MS = 30 * 60 * 1000;

/**
 * Collect a FINISHED job's answer, or null. Clears the job either way once it
 * is no longer running, so a session never accumulates stale state.
 */
function collectJob(sessionId) {
  const job = jobPath(sessionId);
  const out = outPath(sessionId);
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(job, 'utf8'));
  } catch {
    return null; // no job
  }
  const stale = Date.now() - (meta.started || 0) > JOB_MAX_AGE_MS;
  if (isAlive(meta.pid) && !stale) return null; // still working -- check again next turn

  let text = '';
  try {
    text = fs.readFileSync(out, 'utf8').trim();
  } catch {
    /* produced nothing */
  }
  try { fs.unlinkSync(job); } catch {}
  try { fs.unlinkSync(out); } catch {}

  // A finished job that produced NOTHING is a visible state, never silence.
  //
  // Found by running this against a real `codex` whose OAuth token had expired:
  // it printed auth errors to stderr, wrote no answer, and exited. Swallowing
  // that makes a broken deep-check indistinguishable from a clean one — the
  // exact shape of the bug that produced 15/15 false flags here, where "a
  // review judged on nothing looked identical to one that never had anything".
  // The user needs to know their local agent is not actually running.
  if (!text) return { agent: meta.agent, claim: meta.claim, verdict: 'NO_OUTPUT', body: '' };

  // Keep only the verdict line and its evidence. An agentic CLI can emit
  // banners, token counts and ANSI colour; injecting that into a session is
  // noise at best.
  const verdictLine = text.split('\n').find((l) => /\b(TRUE|FALSE|UNVERIFIABLE)\b/.test(l));
  const body = (verdictLine ? text.slice(text.indexOf(verdictLine)) : text)
    // eslint-disable-next-line no-control-regex
    .replace(/\[[0-9;]*m/g, '')
    .trim()
    .slice(0, 700);
  const verdict = /\bFALSE\b/.test(body) ? 'FALSE' : /\bTRUE\b/.test(body) ? 'TRUE' : 'UNVERIFIABLE';
  return { agent: meta.agent, claim: meta.claim, verdict, body };
}

/**
 * Render a collected result, or `''` when it should stay silent.
 *
 * A confirmed claim says nothing: this is advisory tooling and "the thing you
 * were told is true, is true" is not worth a line in the user's session.
 */
function formatJob(result) {
  if (!result || result.verdict === 'TRUE') return '';
  if (result.verdict === 'NO_OUTPUT') {
    return (
      `Prooftrail: the local agent (${result.agent}) produced no output, so deep claim checks are ` +
      `NOT running. Most often this is an expired login — try running \`${result.agent}\` once ` +
      `yourself to confirm it works.`
    );
  }
  const head =
    result.verdict === 'FALSE'
      ? `Prooftrail (${result.agent}, last turn): a claim did NOT hold up.`
      : `Prooftrail (${result.agent}, last turn): could not verify a claim.`;
  return `${head}\n  claim: "${String(result.claim).slice(0, 200)}"\n  ${result.body}`;
}

module.exports = {
  ADAPTERS,
  RECURSION_ENV,
  which,
  detectAgent,
  findClaimSentence,
  detectUncorroboratedClaims,
  buildPrompt,
  startJob,
  collectJob,
  formatJob,
};
