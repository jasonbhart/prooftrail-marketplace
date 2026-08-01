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
 * WHERE THE RULES THEMSELVES COME FROM.
 *
 * They used to be parsed out of AGENTS.md/CLAUDE.md prose. That is gone: a file
 * in the repo is editable by the agent being checked, so a rule read from it
 * could never carry an integrity property, and an agent that wanted to weaken
 * its own gate only had to edit a markdown file. Rules now arrive exclusively
 * through `rulesFromCache`, reading the Ed25519-signed set Task 4's
 * `rules-cache.js` verified and cached. An unconnected install — no cache —
 * performs no checks. That is the point, not an oversight.
 *
 * The project doc (AGENTS.md/CLAUDE.md) is still read, but for exactly one
 * remaining purpose: `extractCommands` mines it for commands already
 * documented there, to OFFER a gate on them. An offer is inert text proposed to
 * the user, never something the repo can silently turn into an enforced rule
 * — the same integrity argument that moved rule definitions out in the first
 * place.
 */
const fs = require('node:fs');
const path = require('node:path');
const { basename } = path;
const { classifyCommand } = require('./lib');

/** Where a documented-command offer sends the user to actually turn a check
 * on -- there is no longer a file to edit, only an account setting. */
const DASHBOARD_RULES_URL = 'https://supervisor-dashboard.pages.dev/rules';

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

/** Discovery order for the project doc. AGENTS.md first — it is winning the
 * filename war (§5 of the original rules-file research). */
const PROJECT_DOC_FILENAMES = ['AGENTS.md', 'CLAUDE.md', '.cursorrules', '.claude/CLAUDE.md'];

/** Bounds every file read, so a pathological repo cannot stall the Stop hook. */
const MAX_DOC_BYTES = 256 * 1024;
/** `@import` recursion bound — cycles are also tracked by realpath below. */
const MAX_IMPORT_DEPTH = 3;
/** How far up the tree to look for a project doc. */
const MAX_PARENT_WALK = 8;

/**
 * Rule families.
 *
 * `family` names the fact the evaluator (`decide`) resolves against; `label`
 * is the human-readable name used in feedback and offers; `computable` says
 * whether a deterministic check exists for it at all (the `undecidable` ones
 * below are listed NOT to check them but so a rule the service turns on for
 * them can still be reported as unchecked, never silently ignored).
 *
 * There used to be a `detect` regex here, matched against a line of a rules
 * file to discover whether the user had WRITTEN this rule. That mechanism is
 * gone along with local rule discovery — enforcement now comes exclusively
 * from `rulesFromCache` — but the family list itself, and the evaluator built
 * on it, did not move.
 */
const RULE_FAMILIES = [
  { family: 'tests-ran', computable: true, label: 'run tests' },
  { family: 'tests-passed', computable: true, label: 'tests must pass' },
  { family: 'lint-ran', computable: true, label: 'run lint' },
  { family: 'typecheck-ran', computable: true, label: 'run typecheck' },
  { family: 'build-ran', computable: true, label: 'run build' },
  { family: 'verify-after-edit', computable: true, label: 'verify before claiming done' },
  { family: 'no-commit-without-permission', computable: true, label: 'no commit/push without asking' },
  // ---- genuinely undecidable here (no deterministic checker exists) --------
  { family: 'follow-existing-patterns', computable: false, label: 'follow existing patterns' },
  { family: 'error-handling', computable: false, label: 'error handling' },
  { family: 'input-validation', computable: false, label: 'input validation' },
  { family: 'scope-discipline', computable: false, label: 'stay in scope / YAGNI' },
];

/**
 * Turn a server rule set (Task 1's `RuleSet`, delivered through Task 4's
 * verified cache) into the rule objects the evaluator consumes.
 *
 * `off` families are omitted entirely rather than carried with a flag: a rule
 * that is off should be indistinguishable from a rule that was never written,
 * so it can never appear in a report as "checked and passing".
 *
 * A STALE cache (Task 4's `stale` flag — older than `STALE_AFTER_DAYS`)
 * demotes `block` to `inform`. A week-old rule should not be able to halt a
 * turn — but enforcing nothing on a stale cache would let one service outage
 * silently disable every check, which is the exact failure this module exists
 * to avoid.
 *
 * `unknown` counts families the SERVER sent that this client's `RULE_FAMILIES`
 * does not recognise, so an old client can say "a newer check needs a plugin
 * update" instead of silently dropping a check its user believes is running.
 *
 * `judgment` carries the JUDGMENT rules -- prose the SERVICE has already
 * decided to ship (rulesDb.ts's `judgment_prose`, inside the same signed
 * envelope as `checks`), one entry per family present there, shaped
 * `{family, label, computable: false, enforcement: 'judge', text}`. This is a
 * SEPARATE mechanism from `checks`/`rules`, and the two are returned under
 * distinct keys so they can never mix: a judgment rule carries prose, not a
 * predicate, so `decide`/`evaluateRules` cannot score it and it must never
 * reach `routeFindings`; a computable rule carries no measured prose, so it
 * must never reach `prependHouseRules` and be read to the judge as a house
 * rule. Forwarded for ANY family key present in `judgment_prose`, not just
 * ones this client's `RULE_FAMILIES`/`JUDGMENT_FAMILIES` happen to know about
 * -- unlike `checks`, an unrecognised judgment family is not a capability gap
 * to warn about, it is just text for the judge to read, and gating it on a
 * client-side allowlist would silently drop an already-signed, already-on
 * rule until the plugin catches up.
 *
 * Returns `{ rules: [], judgment: [], unknown: 0 }` for anything that isn't a
 * usable cache — no cache, no token yet, a verification failure — never
 * throws, never fabricates a rule.
 */
function rulesFromCache(cached) {
  if (!cached || !cached.rules || !cached.rules.checks) return { rules: [], judgment: [], unknown: 0 };
  const known = new Set(RULE_FAMILIES.map((f) => f.family));
  const unknown = Object.keys(cached.rules.checks).filter((f) => !known.has(f)).length;
  const out = [];
  for (const f of RULE_FAMILIES) {
    const level = cached.rules.checks[f.family];
    if (!level || level === 'off') continue;
    const enforcement = cached.stale && level === 'block' ? 'inform' : level;
    out.push({ family: f.family, label: f.label, computable: f.computable, enforcement });
  }
  const prose = cached.rules.judgment_prose && typeof cached.rules.judgment_prose === 'object'
    ? cached.rules.judgment_prose
    : {};
  const judgment = Object.keys(prose)
    .filter((family) => typeof prose[family] === 'string' && prose[family].trim())
    .map((family) => ({ family, label: family, computable: false, enforcement: 'judge', text: prose[family] }));
  return { rules: out, judgment, unknown };
}

/**
 * Commands documented in a project doc, by the category they would gate.
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
/**
 * A candidate must START as a real invocation before it can be offered.
 *
 * A dry-run of the offer over the 2,203-file corpus made this necessary:
 * roughly half the proposed lines were not commands at all. Matching a bare
 * category word accepted `test/widget_test.dart`, `types.ts`, `build.gradle`,
 * `test-definitions/`, `build`, `test:` and even a line of Ruby
 * (`test "homepage shows TRUG title" do`) lifted out of a fenced example.
 *
 * An offer is text we ask the user to paste into their own rules file, so a
 * wrong one is worse than no offer at all. Requiring a known runner or a known
 * standalone tool costs a few real commands and removes every one of those.
 */
const RUNNER_HEAD =
  /^(?:npx|npm|pnpm|yarn|bun|bunx|make|just|task|cargo|go|uv|uvx|poetry|rake|mix|dotnet|composer|gradle|\.\/gradlew|mvn|deno|nx|turbo|hatch|pdm|tox|nox|swift|zig|sbt|bazel|python3?|node)\s+\S/i;
const STANDALONE_HEAD =
  /^(?:vitest|jest|pytest|mocha|ava|rspec|phpunit|eslint|ruff|flake8|clippy|prettier|biome|tsc|mypy|pyright|golangci-lint|shellcheck|stylelint|rubocop|gofmt)\b/i;

/**
 * The tool name, when there is one, is AUTHORITATIVE — it beats any verb found
 * later in the command. `ruff check` is a lint run, not a test run, and a
 * verb-only scan classifies it as `test` because "check" appears after a space.
 */
const TOOL_CATEGORY = new Map([
  ['vitest', 'test'], ['jest', 'test'], ['pytest', 'test'], ['mocha', 'test'],
  ['ava', 'test'], ['rspec', 'test'], ['phpunit', 'test'],
  ['eslint', 'lint'], ['ruff', 'lint'], ['flake8', 'lint'], ['clippy', 'lint'],
  ['prettier', 'lint'], ['biome', 'lint'], ['rubocop', 'lint'],
  ['golangci-lint', 'lint'], ['stylelint', 'lint'], ['gofmt', 'lint'],
  ['tsc', 'typecheck'], ['mypy', 'typecheck'], ['pyright', 'typecheck'],
]);

/** Verb fallback, MOST specific first — `check` is the weakest signal. */
const COMMAND_PATTERNS = [
  ['typecheck', /(?:^|\s)(?:run\s+)?(?:typecheck|type-check|types)(?![\w-])/i],
  ['lint', /(?:^|\s)(?:run\s+)?(?:lint|format|fmt)(?![\w-])/i],
  ['build', /(?:^|\s)(?:run\s+)?(?:build|compile)(?![\w-])/i],
  ['test', /(?:^|\s)(?:run\s+)?(?:test|tests|check)(?![\w-])/i],
];

/** Category for one command, or `null` when nothing recognises it. */
function categoriseCommand(cmd) {
  const head = /^(?:npx|bunx|uvx)\s+([\w.-]+)|^([\w.-]+)/.exec(cmd);
  const tool = ((head && (head[1] || head[2])) || '').toLowerCase();
  if (TOOL_CATEGORY.has(tool)) return TOOL_CATEGORY.get(tool);
  for (const [category, re] of COMMAND_PATTERNS) {
    if (re.test(cmd)) return category;
  }
  return null;
}

/**
 * Strip a trailing prose comment from a documented command.
 *
 * Real rules files annotate their command tables — `pnpm build   # Build
 * (tsup -> dist/)`, `npm test   # 运行 Jest 测试 (386 个用例)` — and offering the
 * annotation back as part of the command is how a paste-ready line stops being
 * paste-ready. Only strips a `#` that is clearly a comment (preceded by
 * whitespace, followed by whitespace or at least two words), never one inside
 * an argument like `--grep "#tag"`.
 */
function stripTrailingComment(cmd) {
  const m = /\s{2,}#|\s#\s/.exec(cmd);
  return (m ? cmd.slice(0, m.index) : cmd).trim();
}

/**
 * Read a project doc, following a symlink and inlining `@imports` one level at
 * a time.
 *
 * Both cases are real and both silently yield nothing if unhandled: vercel's
 * next.js, apache/airflow and ghostty-org/ghostty ship `CLAUDE.md` as a
 * **symlink** whose raw content is the literal string `AGENTS.md`, and
 * block/goose ships an 11-byte `CLAUDE.md` containing `@AGENTS.md`. A naive
 * reader finds zero content in each.
 *
 * `seen` holds realpaths, so an import cycle terminates on the first repeat
 * rather than on the depth bound alone.
 */
function readDocFile(file, depth = 0, seen = new Set()) {
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
    text = fs.readFileSync(real, 'utf8').slice(0, MAX_DOC_BYTES);
  } catch {
    return null;
  }

  const sources = [real];
  // A file whose entire content is a bare filename is the symlink-as-text
  // idiom above; treat it as a pointer, not as a doc with one odd line.
  const bare = text.trim();
  if (/^[\w./-]+\.(?:md|markdown)$/i.test(bare)) {
    const target = readDocFile(path.resolve(path.dirname(real), bare), depth + 1, seen);
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
    const target = readDocFile(path.resolve(path.dirname(real), imp[1]), depth + 1, seen);
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
 * Find and read the project doc(s) governing `cwd`, walking up to the repo
 * root.
 *
 * Returns `{ text, sources }` with every discovered file concatenated, or
 * `null` when there are none. Never throws.
 *
 * This is the former `discoverRules`, renamed: the file-finding logic is
 * unchanged (same filenames, same symlink and `@import` resolution, same
 * repo-root stop), but rules no longer come from here. Its only remaining
 * consumer is `extractCommands`, via `runLocalRules` below.
 */
function readProjectDoc(cwd) {
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
    for (const name of PROJECT_DOC_FILENAMES) {
      const found = readDocFile(path.join(dir, name), 0, seen);
      if (found) {
        texts.push(found.text);
        sources.push(...found.sources);
      }
    }
    // Stop at the repo root -- content above it belongs to another project.
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
  for (const raw of candidates) {
    const cmd = stripTrailingComment(raw);
    if (cmd.length < 3 || cmd.length > 80) continue;
    // Must look like an invocation, not a path, a heading or a line of source.
    if (!RUNNER_HEAD.test(cmd) && !STANDALONE_HEAD.test(cmd)) continue;
    if (out.has(cmd)) continue;
    const category = categoriseCommand(cmd);
    if (category) out.set(cmd, { category, command: cmd });
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
 * Evaluate every rule against the facts.
 *
 * Returns `{ violations, passes, unknowns, unchecked, reports }` where
 * `unchecked` names rules the service turned on that no deterministic checker
 * can score. Nothing here calls a model or touches the network.
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

/** The rule family each documented command category would enable. `verb` is
 * gone: it only ever fed the retired paste-a-line offer text. */
const CATEGORY_RULE = {
  test: { family: 'tests-ran' },
  lint: { family: 'lint-ran' },
  typecheck: { family: 'typecheck-ran' },
  build: { family: 'build-ran' },
};

/**
 * Gates that could be enabled from commands the user ALREADY documented.
 *
 * Research §3, re-measured against this extractor in exp-19: most of a real
 * rules file is reference, not rules. **35.0% of repos document a test command
 * and only 22.6% state it as a rule** — and across the four categories, 705 of
 * 2,203 files (32.0%) document at least one verifying command they never turned
 * into a gate. Offering those takes the engine from **36.9% to 56.2%** of
 * repos, a 1.52× expansion, with no new authoring burden: the answer is already
 * in the user's own file.
 *
 * Returns `[{ category, command, family, hint }]`, where `hint` names the
 * dashboard control to turn on -- NOT a line to paste. A rule now lives on the
 * connected account, so the offer's mechanism changed along with everything
 * else that moved server-side: pasting into AGENTS.md/CLAUDE.md no longer
 * does anything, and an offer that still told the user to do that would send
 * them to edit a file the client stopped reading. Empty when every documented
 * category already has a rule — the common good case, and the one that must
 * stay silent.
 */
function proposeGates(rules, commands) {
  const have = new Set((rules || []).map((r) => r.family));
  const out = [];
  const seen = new Set();
  for (const c of commands || []) {
    const spec = CATEGORY_RULE[c.category];
    if (!spec || have.has(spec.family) || seen.has(c.category)) continue;
    seen.add(c.category);
    out.push({
      category: c.category,
      command: c.command,
      family: spec.family,
      hint: `Turn on the \`${spec.family}\` check in your Prooftrail rules — this repo documents \`${c.command}\`.`,
    });
  }
  return out;
}

/**
 * The offer, as text. Deliberately names the exact check family and where to
 * turn it on rather than describing the idea in general terms -- guidance
 * that names an intent without giving the mechanism gets improvised into
 * something else. The mechanism used to be a markdown line to paste; now it
 * is a named dashboard control, so that is what gets named, plus one trailing
 * link line rather than one repeated per offer.
 */
function formatOffers(offers, sources) {
  if (!offers || offers.length === 0) return '';
  const file = sources && sources.length ? basename(sources[0]) : 'AGENTS.md';
  const head =
    `Prooftrail found no rule it can check, but your ${file} documents ` +
    `${offers.length === 1 ? 'a command' : 'commands'} it could gate on:`;
  return `${head}\n${offers.map((o) => `- ${o.hint}`).join('\n')}\nSet them at ${DASHBOARD_RULES_URL}`;
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
 * Evidence that a project actually HAS a tool of this category.
 *
 * Three independent signals, because one ecosystem's evidence is another's
 * absence: a script name, a dependency name, or a config file. Any one is
 * enough.
 */
const TOOL_EVIDENCE = {
  test: {
    scripts: /^(test|tests|test:.*)$/,
    deps: /^(vitest|jest|mocha|ava|tap|@jest\/core)$/,
    files: ['pytest.ini', 'tox.ini', 'jest.config.js', 'jest.config.ts', 'vitest.config.js', 'vitest.config.ts'],
  },
  lint: {
    scripts: /^(lint|lint:.*|format|fmt)$/,
    deps: /^(eslint|prettier|stylelint|oxlint|@biomejs\/biome)$/,
    files: ['.eslintrc', '.eslintrc.js', '.eslintrc.json', '.eslintrc.cjs', 'eslint.config.js',
      'eslint.config.mjs', 'biome.json', '.prettierrc', 'ruff.toml', '.flake8', '.stylelintrc'],
  },
  typecheck: {
    scripts: /^(typecheck|type-check|types|tsc)$/,
    deps: /^(typescript|mypy|pyright)$/,
    files: ['tsconfig.json', 'mypy.ini', 'pyrightconfig.json'],
  },
  build: {
    scripts: /^(build|build:.*|compile)$/,
    deps: /^(vite|webpack|rollup|esbuild|tsup|parcel)$/,
    files: ['Makefile', 'Cargo.toml', 'go.mod', 'build.gradle', 'pom.xml'],
  },
};

/**
 * Does this project HAVE a tool of this category at all?
 *
 * WHY THIS IS NOT `canRemedy`. exp-20 ran the engine over real sessions and
 * found `lint-ran` firing on every one — because that repo has no linter. A
 * check enabled for a tool the project does not have is true on every turn
 * forever, and the agent can never clear it. Reporting that to the agent each
 * turn is the nagware failure mode ADR-004 calls product-killing.
 *
 * The first fix reused `canRemedy`, which asks whether the project DOCUMENTS
 * such a command. Right question for blocking (conservative: a gate declines to
 * fire), wrong one for suppressing — a repo with `npm test` in package.json but
 * not in its AGENTS.md would have a genuine "you changed code and ran no tests"
 * finding silently withheld. Five integration tests caught that, and they were
 * right: a miss is worse than a nag.
 *
 * So suppression requires POSITIVE EVIDENCE OF ABSENCE — a manifest this code
 * can read which does not mention the tool, and no config file for it either.
 * No manifest at all means UNKNOWN, and unknown is not absence: returning false
 * there would silence real findings for every Python, Go and Rust project, and
 * every monorepo package whose manifest sits at the root.
 */
function toolExists(category, cwd) {
  const evidence = TOOL_EVIDENCE[category];
  if (!evidence || !cwd) return true; // unknown category or no cwd -> never silence
  try {
    for (const f of evidence.files) {
      if (fs.existsSync(path.join(cwd, f))) return true;
    }
    const pkgPath = path.join(cwd, 'package.json');
    if (!fs.existsSync(pkgPath)) return true; // unknown, see doc comment
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    for (const name of Object.keys(pkg.scripts || {})) {
      if (evidence.scripts.test(name)) return true;
    }
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    for (const name of Object.keys(deps)) {
      if (evidence.deps.test(name)) return true;
    }
    return false; // readable manifest, no mention of the tool: real absence
  } catch {
    return true; // unreadable manifest is unknown, and unknown is not absence
  }
}

/** Families whose remedy is a command that must be known to exist. */
const NEEDS_COMMAND = { 'tests-ran': 'test', 'lint-ran': 'lint', 'typecheck-ran': 'typecheck', 'build-ran': 'build' };

/**
 * Can the agent actually FIX this violation on its own?
 *
 * This is the guard that keeps a blocking rule from becoming
 * anthropics/claude-code#55754, where a Stop hook demanded something the agent
 * was structurally unable to do and looped for ~50 minutes on a full session
 * quota. "Run the tests" is only a fair demand if a test command is known to
 * exist; in a repo with none, blocking on it can never be satisfied and the
 * only escape is the token cap.
 *
 * Unknown means NOT blockable — the same "unknown is not zero" discipline the
 * rest of this module follows, pointed at the safe direction.
 */
function canRemedy(violation, commands) {
  const needed = NEEDS_COMMAND[violation && violation.family];
  if (!needed) return true; // fixing a failing test or a stale run needs no new command
  return (commands || []).some((c) => c.category === needed);
}

/**
 * Does the final message explicitly say the agent is blocked or unable?
 *
 * Jason's observation from running a blocking gate for months: when the primary
 * model genuinely cannot do the thing, **it says so in the message before it
 * tries to stop again** — and his agy hook pipes that message to the reviewing
 * model, which then usually concedes and lets the stop complete.
 *
 * That is a better escape valve than predicting satisfiability in advance,
 * because the agent knows things this engine cannot: that the test script is
 * missing, that a dependency will not install, that the work needs a decision
 * only the user can make. Here it is done deterministically instead of with a
 * second model call, which is the same trade ADR-011 makes everywhere else.
 *
 * THE OBVIOUS OBJECTION, and why this is still right: an agent could learn to
 * type "I cannot run the tests" to escape a gate. Two things bound that. The
 * finding is not dropped — it is demoted to `inform`, so the model still
 * receives it and the user still sees it; only the power to halt the turn is
 * given up. And a gate that CAN be argued with beats a gate that loops for 50
 * minutes on a session quota (anthropics/claude-code#55754), because the first
 * failure costs a sentence and the second costs the session.
 */
const BLOCKED_STATEMENT =
  /\b(?:i (?:can'?t|cannot|am unable to|was unable to|could not|couldn'?t)|unable to|not able to|no (?:test|lint|build|typecheck)\s+(?:script|command|runner|setup)|there (?:is|are) no\b[^.\n]{0,40}\b(?:test|script|command)|blocked (?:on|by)|needs? (?:your|user) (?:input|decision|approval|permission)|requires? (?:your|user|manual)\b|only you can|out of my control|do not have (?:permission|access))\b/i;

function statesBlocked(finalMessage) {
  if (!finalMessage || typeof finalMessage !== 'string') return false;
  // Look at the tail only. A mention of an obstacle that was then OVERCOME
  // usually appears mid-narrative; a live blocker is stated at the hand-back.
  const tail = finalMessage.slice(-1200);
  return BLOCKED_STATEMENT.test(tail);
}

/**
 * Split violations by the channel each should travel on.
 *
 * A violation is only promoted to `block` when the user asked for it AND the
 * agent could plausibly act on it. Everything demoted for un-remediability
 * still travels as `inform`, so the finding is never lost — only its power to
 * halt the turn is.
 *
 * ALSO routes `evaluation.reports` (whole-branch review, finding 6) into the
 * SAME `informing`/`notifying` buckets `formatViolations` already renders --
 * before this fix, `evaluateRules`'s `reports` array (the FACTS `decide`
 * returns a `report` status for, e.g. `no-commit-without-permission`'s "a
 * commit ran this turn") was computed and then never read by anything, so a
 * user who turned that check on and expected the "Report commits and pushes"
 * label to mean something got total silence on every channel at every level.
 * A report NEVER reaches `blocking`, regardless of its own `enforcement`
 * value -- rulesDb.ts's catalog only ever offers `off`/`inform`/`notify` for a
 * report-shaped family (never `block`, enforced twice: dashboard.ts's CATALOG
 * and rulesDb.ts's NON_BLOCKABLE_FAMILIES), and even if that were somehow
 * bypassed, a report is a FACT ("a commit happened"), not a verdict on
 * whether it was authorised -- there is nothing here for `canRemedy`/`
 * conceded` to reason about, and halting a turn over an unverdicted fact
 * would attest a heuristic as a measurement, the exact thing `decide`'s
 * `no-commit-without-permission` branch exists to avoid.
 */
function routeFindings(evaluation, commands, finalMessage, cwd) {
  const blocking = [];
  const informing = [];
  const notifying = [];
  const unsatisfiable = [];
  const conceded = statesBlocked(finalMessage);
  for (const v of (evaluation && evaluation.violations) || []) {
    const level = v.enforcement || 'inform';
    // A check for a tool this project does not have can never be cleared, so
    // telling the AGENT every turn is noise (exp-20). Routed, never dropped:
    // it reaches the USER once, because an absent check must not look like a
    // passing one. Gated on toolExists, NOT canRemedy -- see toolExists.
    const needed = NEEDS_COMMAND[v.family];
    if (needed && cwd && !toolExists(needed, cwd)) {
      unsatisfiable.push(v);
      continue;
    }
    if (level === 'notify') notifying.push(v);
    else if (level === 'block' && !conceded && canRemedy(v, commands)) blocking.push(v);
    else informing.push(v);
  }
  for (const r of (evaluation && evaluation.reports) || []) {
    const level = r.enforcement || 'inform';
    if (level === 'notify') notifying.push(r);
    else informing.push(r); // never `blocking` -- see doc comment above
  }
  return { blocking, informing, notifying, unsatisfiable, conceded };
}

/**
 * The notice for checks this project cannot satisfy.
 *
 * Worded as a fact about the PROJECT, not an accusation about the turn — the
 * agent did nothing wrong; the check does not apply here. It goes to the user
 * because they are the only one who can resolve it.
 */
function formatUnsatisfiable(list) {
  if (!list || list.length === 0) return '';
  const one = list.length === 1;
  const names = list.map((v) => `\`${v.family}\``).join(', ');
  return [
    `Prooftrail: ${names} ${one ? 'is' : 'are'} switched on in your rules, but this project has ` +
      `no such tool — no script, no dependency, and no config file for it.`,
    `So the check can never pass, no matter what the agent does. Prooftrail has stopped ` +
      `reporting ${one ? 'it' : 'them'} rather than repeat ${one ? 'it' : 'them'} every turn.`,
    `Two ways to fix it: switch ${one ? 'it' : 'them'} off at ${DASHBOARD_RULES_URL}, or add the ` +
      `tool to this project. Either makes this message stop.`,
  ].join('\n');
}

/**
 * The same explanation, addressed to the AGENT.
 *
 * Jason, 2026-08-01: *"a demo should enable the user to be successful not bake
 * in hidden knowledge... if a loop is occurring because of a bad setting, the
 * hook should instruct the user and/or the AI on why it's happening and what to
 * do about it."*
 *
 * The agent has usually just been told about this rule on previous turns and is
 * the party that has been trying and failing to satisfy it. Silently dropping
 * the finding fixes the nag and leaves the agent guessing about a rule that
 * stopped being mentioned. So it is told once, plainly, that the check was
 * withdrawn and that the fix is the user's — which also stops it from
 * "helpfully" installing a linter nobody asked for.
 */
function formatUnsatisfiableForAgent(list) {
  if (!list || list.length === 0) return '';
  const names = list.map((v) => `\`${v.family}\``).join(', ');
  return (
    `Prooftrail: ${names} cannot be satisfied in this project — there is no such tool here — so ` +
    `${list.length === 1 ? 'it has' : 'they have'} been withdrawn and you are not expected to ` +
    `act on ${list.length === 1 ? 'it' : 'them'}. The user has been told how to resolve it. Do ` +
    `not install or configure the tool unless they ask.`
  );
}

/** One imperative line per violation, no preamble (ADR-001's feedback shape). */
function formatViolations(list) {
  if (!list || list.length === 0) return '';
  return list.map((v) => `- ${v.label}: ${v.detail}`).join('\n');
}

/**
 * The whole local pass, end to end. `parsed` is `parseTranscript`'s output;
 * `cached` is `readRulesCache()`'s output (Task 4) — the signed rule set the
 * service last delivered, or `null` when there is none.
 *
 * Rules come from the cache exclusively via `rulesFromCache` — nothing here
 * reads a project file to decide what to check. The project doc is still read,
 * for `extractCommands` alone, so an unconnected (or under-configured) install
 * can still offer a gate on a command it already documents.
 *
 * Never throws: a rules-engine failure must not break a Stop hook (ADR-004).
 */
function runLocalRules(cwd, parsed, cached) {
  try {
    const { rules, judgment, unknown } = rulesFromCache(cached);
    const doc = readProjectDoc(cwd);
    const commands = extractCommands((doc && doc.text) || '');
    const facts = collectFacts(parsed);
    const evaluation = evaluateRules(rules, facts);
    // Only offered when the engine can check NOTHING today. A user who already
    // has a working gate does not need to be told about another one every
    // turn: the Stop loop is exactly where a helpful suggestion becomes
    // nagware, and a false block is this product's killing failure mode
    // (ADR-004) -- an unwanted nag is the same mistake wearing a friendlier
    // face. `/prooftrail:rules` shows the full list on demand instead.
    const checkable = rules.filter((r) => r.computable).length;
    return {
      sources: (doc && doc.sources) || [],
      rules,
      // Judgment rules ride alongside, but never through `evaluation` --
      // `evaluateRules`/`decide` only ever see `rules` (the computable-or-
      // unchecked list `rulesFromCache` builds from `checks`). The caller
      // (review.js) hands `judgment` to `prependHouseRules` directly.
      judgment,
      commands,
      facts,
      evaluation,
      unknown,
      offers: checkable === 0 ? proposeGates(rules, commands) : [],
      allOffers: proposeGates(rules, commands),
    };
  } catch {
    return null; // fail-soft: an advisory check never breaks the session
  }
}

module.exports = {
  RULE_FAMILIES,
  readProjectDoc,
  rulesFromCache,
  extractCommands,
  collectFacts,
  decide,
  evaluateRules,
  routeFindings,
  toolExists,
  formatUnsatisfiable,
  formatUnsatisfiableForAgent,
  statesBlocked,
  formatViolations,
  canRemedy,
  proposeGates,
  formatOffers,
  formatFindings,
  runLocalRules,
};
