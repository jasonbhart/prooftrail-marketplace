#!/usr/bin/env node
// UserPromptSubmit hook: capture the FIRST prompt of the session for the reviewer.
// Never blocks, never emits output, always exits 0 (failure matrix: capture is
// best-effort; review.js fast-paths when no capture exists).
'use strict';
const fs = require('node:fs');
const { readStdinJson, firstPromptPath } = require('./lib');

(async () => {
  try {
    const evt = await readStdinJson();
    if (!evt.session_id || typeof evt.prompt !== 'string') return;
    const file = firstPromptPath(evt.session_id);
    if (fs.existsSync(file)) return; // first prompt only
    fs.writeFileSync(
      file,
      JSON.stringify({ prompt: evt.prompt, prompt_id: evt.prompt_id ?? null, ts: new Date().toISOString() }),
    );
  } catch {}
  process.exit(0);
})();
