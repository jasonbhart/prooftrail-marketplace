#!/usr/bin/env node
// UserPromptSubmit hook: maintain a bounded rolling window of the session's
// asks for the reviewer -- the FIRST prompt (the session's goal) plus the two
// most recent (what the user is asking for right now).
//
// Was "first prompt only". That made every review in a session judge task
// fidelity against the opening ask forever: a continuation session captured the
// literal string "yes", and long sessions were flagged for "skipping" work that
// had been completed hours earlier in the same session. See
// docs/plans/2026-07-30-ask-window-design.md.
//
// Never blocks, never emits output, always exits 0 (failure matrix: capture is
// best-effort; review.js fast-paths when no capture exists).
'use strict';
const fs = require('node:fs');
const { readStdinJson, firstPromptPath } = require('./lib');

const MAX_PROMPT_CHARS = 6000; // 3 sections + labels stay under the 18k window cap
const MAX_PROMPT_ID_CHARS = 200; // ids are short; anything longer is not an id
const MAX_RECENT = 2;

(async () => {
  try {
    const evt = await readStdinJson();
    if (!evt.session_id || typeof evt.prompt !== 'string') return;
    const file = firstPromptPath(evt.session_id);

    // Capped and type-checked like `prompt` above: this value is mirrored up
    // to four times per write (top-level, first.prompt_id, and both
    // recent[].prompt_id entries), so an unbounded or non-string value would
    // defeat the growth bound that capping `prompt` establishes. A real
    // prompt_id is a short UUID, so this cap never truncates a genuine one.
    const promptId =
      typeof evt.prompt_id === 'string' && evt.prompt_id
        ? evt.prompt_id.slice(0, MAX_PROMPT_ID_CHARS)
        : null;

    const entry = {
      prompt: evt.prompt.slice(0, MAX_PROMPT_CHARS),
      prompt_id: promptId,
      ts: new Date().toISOString(),
    };

    // Read prior state. A missing OR corrupt file is treated as "no state" --
    // this hook must never throw, and a session is better served by a fresh
    // window than by a failed capture.
    let prior = null;
    try {
      prior = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      prior = null;
    }

    // Accept the legacy shape too: a file written by an older capture-prompt.js
    // has only the top-level prompt/prompt_id (the runtime can re-sync the
    // plugin MID-SESSION, so this really happens).
    const first =
      prior && prior.first && typeof prior.first.prompt === 'string'
        ? prior.first
        : prior && typeof prior.prompt === 'string'
          ? { prompt: prior.prompt, prompt_id: prior.prompt_id ?? null, ts: prior.ts ?? entry.ts }
          : entry;

    // Deliberate reference-identity check: true only when no usable prior
    // state existed, meaning "this prompt IS the session's first ever". It
    // relies on the ternary above returning the literal `entry` object (not
    // a copy) in that branch -- every other branch returns `prior.first` or
    // a freshly-built object instead. A future refactor (e.g. wrapping the
    // result in `{...entry}` for immutability) would silently break this and
    // make `recent` non-empty on a session's first prompt.
    const isFirstEver = first === entry;
    const priorRecent = Array.isArray(prior && prior.recent) ? prior.recent : [];
    const recent = isFirstEver ? [] : [...priorRecent, entry].slice(-MAX_RECENT);

    fs.writeFileSync(
      file,
      JSON.stringify({
        // Legacy keys, deliberately retained: an OLD review.js reads these and
        // must keep finding the FIRST prompt where it expects it. Do not remove.
        prompt: first.prompt,
        prompt_id: first.prompt_id,
        ts: first.ts,
        first,
        recent,
      }),
    );
  } catch {}
  process.exit(0);
})();
