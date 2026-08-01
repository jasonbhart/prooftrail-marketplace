'use strict';
/**
 * The signed rule-set cache.
 *
 * WHY A CACHE AT ALL. The Stop hook runs every turn and must never wait on a
 * network fetch, and a service outage must not silently disable every check --
 * a review judged on nothing looking identical to one that never had anything
 * is the exact shape of the 15/15 false-flag bug.
 *
 * WHY ED25519 AND NOT AN HMAC. The client holds no secret (C5: the client is
 * untrusted), so a symmetric MAC gives it nothing to check -- it could only
 * compare a stored value against itself, and an attacker editing the rules
 * recomputes that value too. The first draft of this module did exactly that
 * and the seal was decorative. With an asymmetric signature the client verifies
 * using a PUBLIC key it may safely ship, and cannot forge.
 *
 * The honest claim, stated narrowly: an agent can DELETE this cache (which
 * reads as "no rules" and is visible), and cannot ALTER one -- no forged rule,
 * no downgraded `block`, no silent removal of a check. An agent that rewrites
 * the PLUGIN could swap the key below; nothing client-side can stop the code
 * doing the verifying from being the code subverted, and we do not claim
 * otherwise.
 */
const fs = require('node:fs');
const path = require('node:path');
const { verify, createPublicKey } = require('node:crypto');
const { stateDir } = require('./lib');

/**
 * The service's Ed25519 verification key. Committed deliberately: publishing a
 * PUBLIC key is the point of asymmetric signing, and it is the TRUST ROOT for
 * everything in this file -- unconditional, with no runtime override.
 *
 * CRITICAL FIX (whole-branch review, finding 1): this used to be
 * `process.env.PROOFTRAIL_RULES_PUBKEY || <committed key>`, with the env var
 * winning whenever set. That is a workspace-writable seam, not a test-only
 * one: a repo's `.claude/settings.json` carries an `env` block (this project
 * already treats env vars as attacker-controlled elsewhere -- see review.js's
 * REVIEWSVC_URL handling and lib.js's resolveBaseUrl/TM-4), so an agent could
 * set this var, sign a cache with a keypair of its own choosing, and turn
 * every check off with no tamper notice -- and the forged cache is STICKY,
 * since the genuine envelope then fails verification against the attacker's
 * key and can never win the version race back. There must be exactly one
 * trust root, reachable from nowhere a workspace/repo can reach.
 *
 * Tests inject a different key via `__setTestPubkeyPem` below -- a plain JS
 * function export, not an env var or a repo file. Calling it requires code
 * already running INSIDE this process with the ability to `require()` this
 * module directly, which is a strictly larger capability than "control an env
 * var or a repo file" and is never reachable from hook input, `.claude/
 * settings.json`, or anything else a workspace supplies.
 */
const COMMITTED_RULES_PUBKEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAULYgUomengpTEB9e6qi05mXk2iDiRmgH7m9BSnuwVHo=
-----END PUBLIC KEY-----
`;

// TEST-ONLY override. See the doc comment above for why this is safe where
// the env var was not: it has no env var name, no config key, no file path --
// it is set by calling a function, in-process, which only test code (and this
// module's own child-process preload fixtures under packages/client/test/)
// ever does. `null` means "use the committed key", the only state production
// code ever runs with.
let testPubkeyPemOverride = null;
function __setTestPubkeyPem(pem) {
  testPubkeyPemOverride = pem || null;
}

const rulesPubkeyPem = () => testPubkeyPemOverride || COMMITTED_RULES_PUBKEY_PEM;

const STALE_AFTER_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const cachePath = () => path.join(stateDir(), 'rules.json');

/**
 * The exhaustive, ORDERED list of fields this module signs/verifies. MUST
 * byte-match packages/service/convex/rulesSign.ts's own
 * `SIGNED_RULESET_FIELDS` -- see that constant's doc comment for why this
 * list exists at all (encoder-coverage, whole-branch review finding 4): a
 * field added to the rule set shape on one side and forgotten on the other
 * is exactly how `fetched_at`, and earlier `version`, shipped unsigned.
 */
const SIGNED_RULESET_FIELDS = [
  'checks',
  'judgment',
  'judgment_prose',
  'deep_check',
  'version',
  'updated_at',
  'updated_by',
  'issued_at',
];

/** Mirrors rulesSign.ts's RECORD_FIELDS -- these fields need key-sorted
 * serialization; everything else is a plain scalar written as-is. */
const RECORD_FIELDS = new Set(['checks', 'judgment', 'judgment_prose']);

/**
 * Canonical encoding. MUST byte-match packages/service/convex/rulesSign.ts's
 * `canonicalRuleJson` -- these two are a matched pair, and any divergence makes
 * every legitimate rule set read as tampered. Change one, change both.
 *
 * Maps over SIGNED_RULESET_FIELDS rather than a hand-written list, for the
 * same reason the service side does: the field list and the encoding can
 * never drift apart from each other.
 *
 * `sortedRecord` defaults a missing/undefined record field to `{}` (whole-
 * branch review, finding 4's "live divergence": this default used to exist
 * ONLY here, while rulesSign.ts's own `sortedRecord` had none and would throw
 * on the identical input -- two independent implementations of "the same"
 * encoding that actually disagreed on malformed data). Reconciled by giving
 * the service side the same default (see rulesSign.ts's `sortedRecord`)
 * rather than removing it here: this file parses a cache FILE ON DISK, which
 * can be hand-edited, truncated, or written by an older/different client
 * build, so failing via "produces different canonical bytes than what was
 * signed" (a clean, already-tested rejection path) is preferable to an
 * uncaught-exception route for a merely-incomplete record field.
 */
function canonicalRuleJson(rs) {
  const sortedRecord = (r) => Object.keys(r || {}).sort().map((k) => [k, r[k]]);
  return JSON.stringify(
    SIGNED_RULESET_FIELDS.map((field) => [
      field,
      RECORD_FIELDS.has(field) ? sortedRecord(rs[field]) : rs[field],
    ]),
  );
}

/**
 * Cryptographic verification: was THIS rule set signed by OUR private key?
 *
 * Fails closed on every error path -- a malformed key, a non-base64 signature,
 * a truncated file. An unverifiable rule set is treated exactly like no rule
 * set, never like a valid one.
 */
function verifyEnvelope(entry) {
  try {
    if (!entry || typeof entry !== 'object' || !entry.rules || typeof entry.sig !== 'string') return false;
    // The top-level `entry.version` is NOT part of the signed payload --
    // canonicalRuleJson signs `rules.version`, never the envelope wrapper.
    // An earlier version of this module trusted the top-level field directly
    // for the monotonic anti-rollback gate in writeRulesCache, which let an
    // attacker who had seen just ONE legitimately-signed (rules, sig) pair --
    // trivial, since rules are not secret -- repackage it with an inflated
    // top-level `version` (e.g. 999999999). The signature over `rules` was
    // still genuinely valid, so the envelope was accepted and returned
    // correct-looking rules, but the cache was then permanently poisoned:
    // every real future update has a lower top-level version and is silently
    // rejected forever by `current.version > incoming`, with no private key
    // needed. Chose to REJECT any mismatch here (rather than dropping the
    // top-level field) so the field can keep existing on disk/in the wire
    // format for convenience, but can never disagree with the value the
    // signature actually covers. Do not relax this to "informational only" --
    // that is exactly how this hole got reintroduced once already.
    if (entry.version !== entry.rules.version) return false;
    const key = createPublicKey(rulesPubkeyPem());
    return verify(null, Buffer.from(canonicalRuleJson(entry.rules)), key, Buffer.from(entry.sig, 'base64'));
  } catch {
    return false;
  }
}

function writeRulesCache(envelope) {
  try {
    if (!envelope || !envelope.rules || typeof envelope.sig !== 'string') return false;
    // Verify BEFORE persisting anything. Previously this function only
    // shape-checked (`typeof sig === 'string'`), so any envelope carrying
    // SOME string as `sig` -- forged, garbled, or simply unsigned -- would
    // overwrite a good cache. That silently deletes the user's rules (`block`
    // enforcement becomes nothing) until the next successful fetch. A bad
    // write must fail without touching the existing file.
    if (!verifyEnvelope(envelope)) return false;
    // Derive the monotonic gate's value from the SIGNED `rules.version`, not
    // the caller-supplied top-level `envelope.version`. verifyEnvelope above
    // already rejects any envelope where the two disagree, so in practice
    // these are equal by the time we get here -- but reading the signed
    // field directly means this gate can never again be fooled by an
    // unauthenticated top-level version, even if that check is ever weakened
    // elsewhere. See the comment in verifyEnvelope for the attack this closes.
    const incoming = Number(envelope.rules.version);
    if (!Number.isFinite(incoming)) return false;
    // Monotonic: keep the HIGHER version, so replaying an older, weaker rule
    // set cannot downgrade a client that has already seen a newer one.
    const current = readRulesCache();
    if (current && current.version > incoming) return false;
    fs.writeFileSync(
      cachePath(),
      JSON.stringify({
        rules: envelope.rules,
        version: incoming,
        sig: envelope.sig,
        // Kept as a local diagnostic only ("when did THIS machine last write
        // the cache") -- CRITICAL FIX (whole-branch review, finding 2): it
        // sits outside the signature (always has), so it must never again
        // influence any decision. Staleness is computed below from
        // `entry.rules.issued_at`, which IS signed. See that field's doc
        // comment in canonicalRuleJson/SIGNED_RULESET_FIELDS.
        fetched_at: Number(envelope.fetched_at) || Date.now(),
      }),
    );
    return true;
  } catch {
    return false;
  }
}

function readRulesCache(nowMs = Date.now()) {
  try {
    const entry = JSON.parse(fs.readFileSync(cachePath(), 'utf8'));
    // Unverifiable -> NO rules. Never a partial set, and never a fallback to a
    // repo file: that file is what this replaced.
    if (!verifyEnvelope(entry)) return null;
    // Staleness is derived from `rules.issued_at` -- a SIGNED field, part of
    // `canonicalRuleJson` -- never from the unsigned `fetched_at` above.
    // CRITICAL FIX (whole-branch review, finding 2): the old code used
    // `entry.fetched_at`, an ordinary unsigned JSON field an attacker could
    // edit directly on disk (e.g. set it to 0) without touching the
    // signature at all. rules.js's `rulesFromCache` demotes `block` to
    // `inform` once `stale` is true, so that one-field edit silently and
    // permanently downgraded every `block` rule on the account, with no
    // tamper notice, because verification still passed. An envelope signed
    // before `issued_at` existed (or otherwise missing it) is treated as
    // INFINITELY stale -- fail toward less trust, same discipline as every
    // other branch in this file.
    const issuedAt = Number(entry.rules && entry.rules.issued_at);
    const age_days = Number.isFinite(issuedAt) ? (nowMs - issuedAt) / MS_PER_DAY : Infinity;
    return {
      rules: entry.rules,
      version: entry.version,
      stale: age_days > STALE_AFTER_DAYS,
      age_days,
    };
  } catch {
    return null;
  }
}

module.exports = {
  STALE_AFTER_DAYS,
  canonicalRuleJson,
  verifyEnvelope,
  readRulesCache,
  writeRulesCache,
  cachePath,
  // TEST ONLY -- see its doc comment above `rulesPubkeyPem`. Never read from
  // env, config, or any workspace-controllable input.
  __setTestPubkeyPem,
};
