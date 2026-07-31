'use strict';
/**
 * The local rules engine — decides computable rules WITHOUT a model call.
 *
 * WHY THIS EXISTS, and why it is local.
 *
 * ADR-001's 2026-07-31 amendment states the governing rule: *"a rule that can
 * be computed must be computed; only rules that genuinely require judgment
 * reach the model."* It was documented as the architecture and never built —
 * every computed fact so far is derived SERVER-side in `deriveAttested` and
 * then handed to the judge as advice, which still spends a model call to
 * compare two integers.
 *
 * Three measurements say that is the wrong shape:
 *
 *  1. **A local regex beat the hosted judge.** On the only rule with labels the
 *     author did not write, the two shipped attested booleans alone scored
 *     14/22 (63.6%) against the judge's 12/22 (54.5%) — same stops, same
 *     labels, no model (experiments/16-independent-labels). If a two-line
 *     predicate ties a hosted LLM, the LLM should not be in that path.
 *  2. **Computing beats prose, repeatedly.** Supplying a word count took a
 *     style rule from 66.7% to 100% (exp-15b); computing the verification
 *     predicate took claims-vs-evidence from 7/75 to 54/75 (exp-12). Four
 *     prose interventions over the same period produced no change or a
 *     regression, one halving catch from 55.6% to 22.2% (exp-17).
 *  3. **76.3% of what people actually write is computable.** Across 1,972 real
 *     repos, tests-ran is written by 26.0% and lint/build by 17.1%, while the
 *     judgment rules this project spent a day measuring are written by 1.0%
 *     (docs/reviews/2026-07-31-what-rules-people-write.md).
 *
 * And why LOCAL rather than in the service: 93.6% of real Bash calls exceed the
 * trace's 100-char target cap, and classifying the capped text loses 71.2% of
 * verification signal. The full command text exists only on this machine and
 * ADR-009 forbids shipping tool output. A local checker is not an optimisation
 * here — it is the only place the data exists.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO.
 *
 * It does not guess. Every family resolves to `pass`, `violation`, or
 * `unknown`, and **`unknown` is never reported as a pass**. Attesting a
 * falsehood in a trusted block is what once blocked 43 of 57 good sessions by
 * reporting `diff_files: []` for a diff that merely failed to parse. The same
 * discipline governs here: no edits observed means "tests ran" is not
 * applicable rather than satisfied, and no transcript means everything is
 * unknown rather than fine.
 *
 * It also does not pretend to check what it cannot. 17.6% of repos that write
 * rules write ones no deterministic checker can score — follow-existing-
 * patterns (7.4%), error handling (5.1%), input validation (5.1%). Those are
 * reported by name as unchecked. Saying so plainly is the honest story, and it
 * is also the only way a user can tell what the tool is worth.
 */
const fs = require('node:fs');
const path = require('node:path');
const { classifyCommand } = require('./lib');

/** Categories that CHECK the work, as opposed to performing or shipping it. */
const VERIFYING_CATEGORIES = new Set(['test', 'build', 'lint', 'typecheck']);

/** Tools that mutate a file. Mirrors the judge's EDIT_TOOLS. */
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);

/**
 * Edits to these are not code, so they cannot make a test run "stale".
 * Identical to the judge's PROSE_EXTENSIONS — a session that edits only
 * markdown after a green test run has not invalidated it, and treating that as
 * staleness was a false-positive source before exp-12 caught it.
 */
const PROSE_EXTENSIONS = /\.(md|mdx|markdown|txt|rst|adoc)$/i;

/** Discovery order. AGENTS.md first — it is winning the filename war (§5). */
const RULES_FILENAMES = ['AGENTS.md', 'CLAUDE.md', '.cursorrules', '.claude/CLAUDE.md'];

/** Bounds every file read, so a pathological repo cannot stall the Stop hook. */
const MAX_RULES_BYTES = 256 * 1024;
/** `@import` recursion bound — cycles are also tracked by realpath below. */
const MAX_IMPORT_DEPTH = 3;
/** How far up the tree to look for a rules file. */
const MAX_PARENT_WALK = 8;

/**
 * Rule families.
 *
 * `detect` matches a line of a rules file. `family` names the fact it resolves
 * against. Ordering matters only for reporting; a line may match several
 * families and each is recorded once.
 *
 * The `computable` families are ranked by how often real repos write them
 * (docs/reviews/2026-07-31-what-rules-people-write.md §2, ranks 1-12 cover
 * 59.1% of all repos that write any rule). The `undecidable` ones are listed
 * NOT to check them but so the engine can name them as unchecked — a rule the
 * user wrote and we silently ignored is worse than one we decline out loud.
 */
const RULE_FAMILIES = [
  {
    family: 'tests-ran',
    computable: true,
    label: 'run tests',
    // "run the tests", "make sure tests pass", "always run pytest", "npm test"
    detect: /\b(?:run|running|execute|always run|must run|make sure|ensure|verify)\b[^.\n]{0,60}\b(?:tests?|test suite|unit tests?|pytest|vitest|jest|go test|cargo test|npm test|yarn test|pnpm test)\b/i,
  },
  {
    family: 'tests-passed',
    computable: true,
    label: 'tests must pass',
    detect: /\btests?\b[^.\n]{0,40}\b(?:pass|passing|green|succeed)\b|\b(?:all|the)\s+tests?\s+(?:must|should|need to)\b/i,
  },
  {
    family: 'lint-ran',
    computable: true,
    label: 'run lint',
    detect: /\b(?:run|running|execute|always run|must run|ensure)\b[^.\n]{0,60}\b(?:lint|linter|eslint|ruff|flake8|clippy|prettier|biome|format(?:ter)?)\b/i,
  },
  {
    family: 'typecheck-ran',
    computable: true,
    label: 'run typecheck',
    detect: /\b(?:run|running|execute|always run|must run|ensure)\b[^.\n]{0,60}\b(?:typecheck|type-check|type check|tsc|mypy|pyright)\b/i,
  },
  {
    family: 'build-ran',
    computable: true,
    label: 'run build',
    detect: /\b(?:run|running|execute|always run|must run|ensure)\b[^.\n]{0,60}\b(?:build|compile|make\b)/i,
  },
  {
    family: 'verify-after-edit',
    computable: true,
    label: 'verify before claiming done',
    // Tightened after a dry-run over the 2,203-file corpus: a looser version
    // anchored on a bare `before|after` plus stems like `complet`/`declar`
    // matched "Never start servers with raw `&`" and a paragraph about three
    // config files, because `complet` also matches "completely". Both halves
    // now require the verify-then-claim shape explicitly.
    detect: /\b(?:verif|validat|test|check|confirm)\w*\b[^.\n]{0,40}\bbefore\b[^.\n]{0,30}\b(?:claim|say|report|declar|mark|done|complet|finish)\w*\b|\b(?:don'?t|do not|never)\b[^.\n]{0,30}\b(?:claim|say|report|mark|tell|state)\w*\b[^.\n]{0,40}\b(?:done|complet|finish|working|fixed|passing)\w*\b/i,
  },
  {
    family: 'no-commit-without-permission',
    computable: true,
    label: 'no commit/push without asking',
    // Must be about AUTHORISATION, not about what may be committed. The first
    // draft matched any prohibition containing "commit", so "Do not commit
    // secrets", "Never force push ... unless the user requests it" and "use
    // `pnpm run commit` instead of `git commit`" all registered as this rule --
    // 14.8% of the corpus, nearly all of it the wrong rule. Attributing a
    // finding to a rule the user did not write is worse than missing one.
    detect: /\b(?:commit|push|merge)\w*\b[^.\n]{0,60}\b(?:without (?:permission|asking|approval|explicit|being told)|unless (?:explicitly |the user |i )?(?:ask|request|instruct|tell|confirm|approv|say)|ask (?:first|before|me|for permission|the user)|(?:my|user'?s?|explicit) (?:permission|approval|consent))\b|\b(?:never|do not|don'?t)\b[^.\n]{0,30}\b(?:commit|push)\w*\b[^.\n]{0,40}\b(?:unless|until|without)\b/i,
  },
  // ---- written often, genuinely undecidable here (research §5) --------------
  {
    family: 'follow-existing-patterns',
    computable: false,
    label: 'follow existing patterns',
    detect: /\b(?:follow|match|respect|adhere to|consistent with)\b[^.\n]{0,40}\b(?:existing|current|established|surrounding|codebase)\b[^.\n]{0,30}\b(?:patterns?|conventions?|style|idioms?)\b/i,
  },
  {
    family: 'error-handling',
    computable: false,
    label: 'error handling',
    detect: /\b(?:handle|proper|graceful|appropriate)\b[^.\n]{0,30}\berrors?\b|\berror handling\b/i,
  },
  {
    family: 'input-validation',
    computable: false,
    label: 'input validation',
    detect: /\b(?:validate|validation|sanitiz)\w*\b[^.\n]{0,30}\b(?:input|user data|parameters?|arguments?)\b/i,
  },
  {
    family: 'scope-discipline',
    computable: false,
    label: 'stay in scope / YAGNI',
    detect: /\byagni\b|\b(?:don'?t|do not|never|avoid)\b[^.\n]{0,40}\b(?:over-?engineer|scope creep|gold-?plat|unnecessary abstraction|speculative)\b|\bonly\b[^.\n]{0,30}\bwhat (?:was|is) asked\b/i,
  },
];

/**
 * Commands documented in a rules file, by the category they would gate.
 *
 * This is research finding §3, and the largest single opportunity it found:
 * **59.9% of files mention a test command, but only 9.3% tie one to an
 * end-of-turn moment.** Most of a CLAUDE.md is reference, not rules — 35.7% of
 * files contain no rule from any of 38 families and are pure documentation.
 *
 * So a documented command is not a rule and is never enforced as one. It is an
 * OFFER: "your AGENTS.md documents `make test` — want that as a gate?" That
 * converts the 9.3% who authored a gate into the 59.9% who documented a
 * command, using data already in the file, with no new authoring burden.
 */
const COMMAND_PATTERNS = [
  ['test', /^(?:[\w./-]*(?:npm|pnpm|yarn|bun|make|just|task|cargo|go|uv|poetry|rake|mix)\s+)?(?:run\s+)?(?:test|tests|check)\b|^(?:npx\s+|uvx\s+)?(?:vitest|jest|pytest|mocha|ava|rspec|phpunit)\b/i],
  ['lint', /^(?:[\w./-]*(?:npm|pnpm|yarn|bun|make|just|task|cargo)\s+)?(?:run\s+)?(?:lint|format|fmt)\b|^(?:npx\s+)?(?:eslint|ruff|flake8|clippy|prettier|biome)\b/i],
  ['typecheck', /^(?:[\w./-]*(?:npm|pnpm|yarn|bun|make|just|task)\s+)?(?:run\s+)?(?:typecheck|type-check|types)\b|^(?:npx\s+)?(?:tsc|mypy|pyright)\b/i],
  ['build', /^(?:[\w./-]*(?:npm|pnpm|yarn|bun|make|just|task|cargo|go)\s+)?(?:run\s+)?build\b/i],
];

/**
 * Read a rules file, following a symlink and inlining `@imports` one level at
 * a time.
 *
 * Both cases are real and both silently yield nothing if unhandled (research
 * §5): `vercel/next.js`, `apache/airflow` and `ghostty-org/ghostty` ship
 * `CLAUDE.md` as a **symlink** whose raw content is the literal string
 * `AGENTS.md`, and `block/goose` ships an 11-byte `CLAUDE.md` containing
 * `@AGENTS.md`. A naive reader finds zero rules in each.
 *
 * `seen` holds realpaths, so an import cycle terminates on the first repeat
 * rather than on the depth bound alone.
 */
function readRulesFile(file, depth = 0, seen = new Set()) {
  if (depth > MAX_IMPORT_DEPTH) return null;
  let real;
  try {
    real = fs.realpathSync(file);
  } catch {
    return null;
  }
  if (seen.has(real)) return null;
  seen.add(real);

  let text;
  try {
    const stat = fs.statSync(real);
    if (!stat.isFile()) return null;
    text = fs.readFileSync(real, 'utf8').slice(0, MAX_RULES_BYTES);
  } catch {
    return null;
  }

  const sources = [real];
  // A file whose entire content is a bare filename is the symlink-as-text
  // idiom above; treat it as a pointer, not as a rules file with one odd line.
  const bare = text.trim();
  if (/^[\w./-]+\.(?:md|markdown)$/i.test(bare)) {
    const target = readRulesFile(path.resolve(path.dirname(real), bare), depth + 1, seen);
    if (target) return { text: target.text, sources: sources.concat(target.sources) };
    return { text, sources };
  }

  // `@path/to/file.md` on its own line -> inline it in place.
  const out = [];
  for (const line of text.split('\n')) {
    const imp = /^\s*@([\w./-]+\.(?:md|markdown))\s*$/i.exec(line);
    if (!imp) {
      out.push(line);
      continue;
    }
    const target = readRulesFile(path.resolve(path.dirname(real), imp[1]), depth + 1, seen);
    if (target) {
      out.push(target.text);
      sources.push(...target.sources);
    } else {
      out.push(line); // unresolvable import stays as text rather than vanishing
    }
  }
  return { text: out.join('\n'), sources };
}

/**
 * Find and read the rules files governing `cwd`, walking up to the repo root.
 *
 * Returns `{ text, sources }` with every discovered file concatenated, or
 * `null` when there are none. Never throws.
 */
function discoverRules(cwd) {
  if (!cwd || typeof cwd !== 'string') return null;
  const texts = [];
  const sources = [];
  const seen = new Set();
  let dir;
  try {
    dir = path.resolve(cwd);
  } catch {
    return null;
  }

  for (let i = 0; i < MAX_PARENT_WALK; i++) {
    for (const name of RULES_FILENAMES) {
      const found = readRulesFile(path.join(dir, name), 0, seen);
      if (found) {
        texts.push(found.text);
        sources.push(...found.sources);
      }
    }
    // Stop at the repo root -- rules above it belong to another project.
    try {
      if (fs.existsSync(path.join(dir, '.git'))) break;
    } catch {
      /* fall through to the parent walk */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  if (texts.length === 0) return null;
  return { text: texts.join('\n'), sources };
}

/**
 * Strip fenced code blocks before matching PROSE rules.
 *
 * Without this, a README documenting `npm test` inside a shell fence reads as
 * the rule "run tests". The fences are still parsed separately by
 * `extractCommands` — the same text answers two different questions, and
 * conflating them is what makes 35.7%-pure-documentation files look like rule
 * files.
 */
function stripFences(text) {
  return text.replace(/^```[\s\S]*?^```/gm, '\n');
}

/**
 * Rule instances found in a rules file, deduplicated by family.
 *
 * A line only counts when it reads as an instruction. Requiring a directive
 * verb is what keeps `## Testing\nThe test suite uses vitest.` — reference
 * prose, which is most of a real CLAUDE.md — from registering as a rule.
 */
const DIRECTIVE = /\b(?:must|should|always|never|do not|don'?t|ensure|make sure|required?|need to|before|after|no\b)\b|^\s*[-*]\s|^\s*\d+\.\s/i;

function extractRules(text) {
  if (!text || typeof text !== 'string') return [];
  const found = new Map();
  for (const raw of stripFences(text).split('\n')) {
    const line = raw.trim();
    if (!line || line.length > 400) continue;
    if (!DIRECTIVE.test(line)) continue;
    for (const f of RULE_FAMILIES) {
      if (found.has(f.family)) continue;
      if (f.detect.test(line)) {
        found.set(f.family, {
          family: f.family,
          label: f.label,
          computable: f.computable,
          text: line.replace(/^\s*(?:[-*]|\d+\.)\s*/, '').slice(0, 200),
        });
      }
    }
  }
  return [...found.values()];
}

/**
 * Commands documented anywhere in the file — fenced blocks, inline code, or a
 * markdown table cell. Returns `[{ category, command }]`, deduplicated.
 *
 * These are OFFERS, never rules (see COMMAND_PATTERNS above).
 */
function extractCommands(text) {
  if (!text || typeof text !== 'string') return [];
  const candidates = [];

  // Fenced blocks: every non-comment line is a candidate command.
  for (const m of text.matchAll(/^```[a-z]*\n([\s\S]*?)^```/gm)) {
    for (const line of m[1].split('\n')) {
      const t = line.trim().replace(/^\$\s*/, '');
      if (t && !t.startsWith('#')) candidates.push(t);
    }
  }
  // Inline code spans -- `npm test` in a bullet or a table cell.
  for (const m of text.matchAll(/`([^`\n]{2,80})`/g)) candidates.push(m[1].trim());

  const out = new Map();
  for (const cmd of candidates) {
    if (cmd.length > 80) continue;
    for (const [category, re] of COMMAND_PATTERNS) {
      if (re.test(cmd) && !out.has(cmd)) out.set(cmd, { category, command: cmd });
    }
  }
  return [...out.values()];
}

/**
 * Compute the facts a rule is decided against, from the UNCAPPED transcript.
 *
 * This is the same shape the service derives in `deriveVerification`, computed
 * from the full command text rather than from the 100-char trace target — the
 * asymmetry this module exists for. `parsed` is `parseTranscript`'s output.
 *
 * Returns `null` when there is no transcript, which callers must treat as
 * "everything unknown", never as "nothing ran".
 */
function collectFacts(parsed) {
  if (!parsed || !Array.isArray(parsed.toolUses) || parsed.toolUses.length === 0) return null;
  const { toolUses, outcomes } = parsed;

  const categories = [];
  const last_outcome = Object.create(null);
  let edits = 0;
  let codeEdits = 0;
  let lastCodeEditIdx = -1;
  let lastVerifyIdx = -1;

  for (let i = 0; i < toolUses.length; i++) {
    const tu = toolUses[i];
    if (EDIT_TOOLS.has(tu.name)) {
      edits++;
      const target =
        tu.input && typeof tu.input === 'object'
          ? String(tu.input.file_path || tu.input.path || tu.input.notebook_path || '')
          : '';
      // An unreadable target falls through as CODE rather than as prose: that
      // preserves staleness detection on an unknown path instead of silently
      // suppressing it, which is the safe direction for an advisory check.
      if (!PROSE_EXTENSIONS.test(target)) {
        codeEdits++;
        lastCodeEditIdx = i;
      }
    }
    const cats = classifyCommand(tu.input && tu.input.command);
    if (cats.length === 0) continue;
    const isError = outcomes.get(tu.id) === true;
    for (const cat of cats) {
      if (!categories.includes(cat)) categories.push(cat);
      // Later calls overwrite earlier ones, so this ends as the MOST RECENT
      // outcome per category -- the one a claim about current state rests on.
      last_outcome[cat] = isError ? 'error' : 'ok';
      if (VERIFYING_CATEGORIES.has(cat)) lastVerifyIdx = i;
    }
  }

  // Only answerable when BOTH a code edit and a verifying call are visible.
  const ran_after_last_edit =
    lastCodeEditIdx === -1 || lastVerifyIdx === -1 ? null : lastVerifyIdx > lastCodeEditIdx;

  return { categories, last_outcome, ran_after_last_edit, edits, code_edits: codeEdits };
}

/** `-> ok` means the TOOL CALL did not error, not that the command succeeded. */
const OUTCOME_CAVEAT =
  'outcome is the tool call\'s own status; a piped or `|| true` command still reports ok';

/**
 * Decide one rule family against the facts.
 *
 * Every branch returns one of `pass` / `violation` / `unknown` / `n/a`, and the
 * unknown paths are deliberate: with no transcript nothing is decidable, and
 * with no code edits a "run the tests" rule has nothing to be violated by.
 */
function decide(family, facts) {
  if (!facts) return { status: 'unknown', detail: 'no transcript available' };

  const ranCategory = (cat) => facts.categories.includes(cat);
  const failed = (cat) => facts.last_outcome[cat] === 'error';

  // "did a verifying command of this kind run, given that code changed?"
  const ranGate = (cat, noun) => {
    if (facts.code_edits === 0) {
      return { status: 'n/a', detail: 'no code files were changed this turn' };
    }
    if (ranCategory(cat)) {
      return failed(cat)
        ? { status: 'violation', detail: `${noun} ran and reported an error` }
        : { status: 'pass', detail: `${noun} ran (${OUTCOME_CAVEAT})` };
    }
    return { status: 'violation', detail: `${facts.code_edits} code file(s) changed and no ${noun} ran` };
  };

  switch (family) {
    case 'tests-ran':
      return ranGate('test', 'tests');
    case 'lint-ran':
      return ranGate('lint', 'lint');
    case 'typecheck-ran':
      return ranGate('typecheck', 'typecheck');
    case 'build-ran':
      return ranGate('build', 'build');

    case 'tests-passed':
      if (!ranCategory('test')) {
        // NOT a pass. "No failing test observed" and "the tests pass" are
        // different claims, and conflating them is the diff_files:[] error.
        return { status: 'unknown', detail: 'no test run observed, so nothing to report on' };
      }
      return failed('test')
        ? { status: 'violation', detail: 'the most recent test run reported an error' }
        : { status: 'pass', detail: `most recent test run was ok (${OUTCOME_CAVEAT})` };

    case 'verify-after-edit':
      if (facts.ran_after_last_edit === null) {
        return {
          status: 'n/a',
          detail:
            facts.code_edits === 0
              ? 'no code files were changed this turn'
              : 'no verifying command ran, so there is nothing to be stale',
        };
      }
      return facts.ran_after_last_edit
        ? { status: 'pass', detail: 'verification ran after the last code edit' }
        : { status: 'violation', detail: 'the last code edit came AFTER the last verifying command' };

    case 'no-commit-without-permission':
      // The FACT is "a commit or push happened". Whether permission was given
      // is not in the trace, so this reports and never verdicts -- attesting a
      // heuristic as a measurement is the failure mode this codebase has
      // already paid for once.
      return ranCategory('vcs')
        ? { status: 'report', detail: 'a git commit/push/merge ran this turn' }
        : { status: 'pass', detail: 'no commit, push or merge ran' };

    default:
      return { status: 'unknown', detail: 'no local check for this rule' };
  }
}

/**
 * Evaluate every discovered rule against the facts.
 *
 * Returns `{ violations, passes, unknowns, unchecked, reports }` where
 * `unchecked` names the rules the user wrote that no deterministic checker can
 * score. Nothing here calls a model or touches the network.
 */
function evaluateRules(rules, facts) {
  const violations = [];
  const passes = [];
  const unknowns = [];
  const unchecked = [];
  const reports = [];

  for (const rule of rules || []) {
    if (!rule.computable) {
      unchecked.push(rule);
      continue;
    }
    const outcome = { ...rule, ...decide(rule.family, facts) };
    if (outcome.status === 'violation') violations.push(outcome);
    else if (outcome.status === 'pass') passes.push(outcome);
    else if (outcome.status === 'report') reports.push(outcome);
    else unknowns.push(outcome); // 'unknown' and 'n/a' -- never counted as pass
  }

  return { violations, passes, unknowns, unchecked, reports };
}

/**
 * One advisory line per violation, imperative, no preamble — the feedback
 * shape ADR-001 mandates ("cite the specific unmet requirement, one per line").
 * Returns `''` when there is nothing to say, so the hook stays silent.
 */
function formatFindings(evaluation) {
  if (!evaluation || evaluation.violations.length === 0) return '';
  return evaluation.violations.map((v) => `- ${v.label}: ${v.detail}`).join('\n');
}

/**
 * The whole local pass, end to end. `parsed` is `parseTranscript`'s output.
 *
 * Never throws: a rules-engine failure must not break a Stop hook (ADR-004).
 */
function runLocalRules(cwd, parsed) {
  try {
    const discovered = discoverRules(cwd);
    if (!discovered) return null;
    const rules = extractRules(discovered.text);
    if (rules.length === 0) {
      return {
        sources: discovered.sources,
        rules: [],
        commands: extractCommands(discovered.text),
        evaluation: { violations: [], passes: [], unknowns: [], unchecked: [], reports: [] },
      };
    }
    const facts = collectFacts(parsed);
    return {
      sources: discovered.sources,
      rules,
      commands: extractCommands(discovered.text),
      facts,
      evaluation: evaluateRules(rules, facts),
    };
  } catch {
    return null; // fail-soft: an advisory check never breaks the session
  }
}

module.exports = {
  RULE_FAMILIES,
  discoverRules,
  readRulesFile,
  extractRules,
  extractCommands,
  collectFacts,
  decide,
  evaluateRules,
  formatFindings,
  runLocalRules,
};
