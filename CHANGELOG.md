# Changelog

All notable changes are documented in this file using
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/).

## [0.6.2] - 2026-10-27

### Fixed

- **engines:** Require OpenCode >=2.2.0

## [0.6.1] - 2026-10-22

### Fixed

- **prediction:** Correct sentence-start casing, trigram scoring, and next-word filtering

## [0.6.0] - 2026-10-22

### Added

- **completion:** Learn hyphenated words, brand names, filenames and shell commands

## [0.5.2] - 2026-10-22

### Fixed

- **prediction:** Restore personal completion weight, next-word predictions, and slash-command prose

## [0.5.1] - 2026-10-22

### Fixed

- Harden learning persistence and release safety

## [0.5.0] - 2026-10-22

### Added

- **prediction:** Complete learned slash tokens and preserve prior weight

## [0.4.0] - 2026-10-21

### Added

- Add logical-line-end completion and suggestion cycling

## [0.3.4] - 2026-10-21

### Fixed

- Preserve learning exclusions across sync and restart

## [0.3.3] - 2026-10-21

### Fixed

- Keep learning when full, honor clear, and skip subagent sessions
- Hide suggestions that do not fit the cursor row

## [0.3.2] - 2026-10-21

### Added

- Predict words in composers holding attachments or pasted-text chips

## [0.3.1] - 2026-10-20

### Fixed

- **deps:** Require opentui 0.6 for opencode 2.1

## [0.3.0] - 2026-10-15

### Added

- **prediction:** Learn casing, hide fragments, and decay old counts

### Changed

- **learning:** Stop re-sorting sessions once the backfill is seeded

## [0.2.2] - 2026-10-15

### Changed

- **learning:** Read stored snapshots without store proxies

## [0.2.1] - 2026-10-13

### Fixed

- **prediction:** Guard typo corrections and learning races

## [0.2.0] - 2026-10-13

### Added

- **prediction:** Add safe typo correction and context repair

## [0.1.5] - 2026-10-10

### Fixed

- **tui:** Skip history-learning warning for opportunistic syncs

## [0.1.4] - 2026-10-10

### Fixed

- **tui:** Depend on opentui 0.5.x so npm cannot resolve 0.6.0

## [0.1.3] - 2026-10-10

### Fixed

- **tui:** Pin opentui peer dependencies to ^0.5.17 for arborist compatibility

## [0.1.2] - 2026-10-10

### Fixed

- Align peer dependencies with opencode to resolve npm ERESOLVE

## [0.1.1] - 2026-10-10

### Fixed

- **ci:** Handle root commit in commitlint range
- Add `@jsxImportSource @opentui/solid` pragma to the TUI entrypoint so npm cache compilation doesn't fall back to React.
- Constrain `@opentui/core` and `@opentui/solid` peer dependencies to `<0.6.0` with `peerDependenciesMeta` set to optional, preventing conflicting nested OpenTUI versions.
- Support `/quill clear` and `/quill reset` to wipe learned vocabulary and n-gram state.

## [0.1.0] - 2026-10-10

### Added

- Local word autocomplete and next-word prediction plugin for OpenCode V2.
- High-frequency English vocabulary prior derived from SUBTLEX word frequencies.
- Online absolute-discounting n-gram model learning from submitted session prompts.
- Inline ghost-text rendering at visual cursor with matching Ghost dim level (`0.55`).
- Safe acceptance (<kbd>Tab</kbd>, <kbd>→</kbd>) and dismissal (<kbd>Esc</kbd>) without draft submission.
- Prose-aware filtering suppressing suggestions in code, paths, URLs, and shell commands.
- `/quill` command and command palette action to toggle autocomplete.
- Local installer script, full test suite, CI workflows, and release tooling.

[0.6.2]: https://github.com/ozandogrultan/opencode-quill/compare/v0.6.1...v0.6.2
[0.6.1]: https://github.com/ozandogrultan/opencode-quill/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/ozandogrultan/opencode-quill/compare/v0.5.2...v0.6.0
[0.5.2]: https://github.com/ozandogrultan/opencode-quill/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/ozandogrultan/opencode-quill/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/ozandogrultan/opencode-quill/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/ozandogrultan/opencode-quill/compare/v0.3.4...v0.4.0
[0.3.4]: https://github.com/ozandogrultan/opencode-quill/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/ozandogrultan/opencode-quill/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/ozandogrultan/opencode-quill/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/ozandogrultan/opencode-quill/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/ozandogrultan/opencode-quill/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/ozandogrultan/opencode-quill/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/ozandogrultan/opencode-quill/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/ozandogrultan/opencode-quill/compare/v0.1.5...v0.2.0
[0.1.5]: https://github.com/ozandogrultan/opencode-quill/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/ozandogrultan/opencode-quill/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/ozandogrultan/opencode-quill/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/ozandogrultan/opencode-quill/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/ozandogrultan/opencode-quill/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/ozandogrultan/opencode-quill/releases/tag/v0.1.0
