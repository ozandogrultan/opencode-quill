# AGENTS.md — quill

## What this is

An OpenCode V2 TUI plugin for local word autocomplete and next-word prediction.
README.md is the user-facing contract — read it before changing behavior.

## Layout

- `src/tui.tsx` — V2 plugin entrypoint, lifecycle hooks, keymaps, storage, and session listeners.
- `src/prose.ts` — prose masking, tokenization, context extraction, query detection, and the `Grammar` type with `proseGrammar`.
- `src/shell.ts` — `shellGrammar`: shell-mode masking, tokenization, and secret filtering.
- `src/predictor.ts` — n-gram language model, SUBTLEX prior blending, learning, and candidate ranking.
- `src/ghost.ts` — OpenTUI buffer painting, cursor tracking, eligibility checks, and insertion.
- `src/options.ts` — option parsing and validation.
- `src/keymap.ts` — reactive keymap layer construction for accept and dismiss actions.
- `scripts/eval.ts` — `bun run eval`: replays your OpenCode history (read-only DB) through the predictor on a time split and prints aggregate metrics. `--split val|test`, `--json`, `--db <path>`, `--prompts <file>` (frozen benchmark), `--freeze <file>` (write one, owner-only, keep outside the repo), `--examples`.
- `test/` — Bun unit and installer tests.
- `bunfig.toml` — preloads the OpenTUI Solid transform for tests.
- `install.sh` — copies sources and registers a directory in global `cli.json`.
- `scripts/changelog.sh`, `tests/changelog.sh` — shared release tooling.
- `.github/workflows/` — CI and npm trusted-publisher releases.

## Learning, Prediction, and Storage

- **Learning Pipeline:** Learns from user prompts via the session lifecycle events
  (`session.execution.started`, `session.execution.succeeded`,
  `session.inbox.delivered`) and a startup/route backfill of recent sessions in
  `src/tui.tsx`. Messages are deduplicated by `<sessionID>:<messageID>`. Prose is
  masked against code, paths, URLs, shell commands, and large pastes.
- **Model Growth:** Counts words, bigrams (`u\0w`), trigrams (`u\0v\0w`), and
  mid-sentence casing forms. A word joins the vocabulary once it has been seen
  more than once, unless it is a prefix of a learned word used at least 3x as often.
  The model is pruned on persistence and halved past a total-count budget; limits
  live as constants in `src/predictor.ts`.
- **Shell Model:** A second `PersonalModel`/`WordPredictor` pair built on `shellGrammar`
  (case-sensitive, no typo correction, no prior). It learns from `shell` session messages
  (`command`) and is selected by the composer slot's `mode === "shell"`. It stays in
  `plugin.quill.shell.json`.
- **Storage Location:** Durable JSON state managed via OpenCode's `context.storage.store()`
  under `~/.local/state/opencode/<channel>/tui/plugin.quill.learning.json` and
  `plugin.quill.settings.json`. Raw prompt text is never written to disk or stored.

## Commands

```sh
bun install
bun run test
bun run typecheck
bun run lint:sh
bun run eval
```

## Hard-won rules

- Target OpenCode V2 and use documented plugin APIs or public OpenTUI APIs.
- Keep prediction local; do not add model calls, hidden sessions, or telemetry.
- Register local TUI plugin directories in `cli.json`, not individual files.
- Suggestions must not enter the text buffer until explicitly accepted.
- Acceptance inserts or replaces the active word and never submits, overwrites unrelated draft text, or uses the clipboard.
- Capture keys only with a visible suggestion in the focused normal composer.
- Preserve host handlers, hints, selections, attachments, undo state, and other plugins.
- Ghost owns empty-composer next-prompt suggestions; Quill targets non-empty prose drafts.
- Ghost text dim level must match Ghost (dimmed muted theme text; see `dimGhostColor` in `src/ghost.ts`).
- Remove listeners and render callbacks on unload; never write to destroyed editors.
- Keep `@opentui/core` and `@opentui/solid` as `dependencies` on the line OpenCode
  bundles; as peers, npm resolves `@opencode/plugin`'s optional peers to the newest release.
- Shell learning must skip secrets: any command matching the `SECRET` pattern in `src/shell.ts` is masked whole.
- Keep learned prompt data out of Git and package tarballs.
- Keep installed sources identical to this repository when installing updates.

## Verifying

```sh
bun run test && bun run typecheck && bun run lint:sh
bash scripts/changelog.sh check
shellcheck -x --severity=error install.sh tests/*.sh scripts/*.sh
npm pack --dry-run
```

## Conventions

Follow Conventional Commits and the shared project standard. Copy shared
release tooling verbatim from Sesh or Ghost. Do not add code comments.
