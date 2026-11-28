# Contributing

Thanks for wanting to help. `opencode-quill` is a small, opinionated tool —
issues and pull requests are welcome.

## Getting started

```bash
git clone https://github.com/ozandogrultan/opencode-quill.git
cd opencode-quill
bun install
```

There is no build step. `src/` holds the V2 plugin and its pure helpers,
`test/` holds the bun tests, `tests/changelog.sh` and `scripts/changelog.sh` own the
release bookkeeping, and `opencode` transpiles the TSX source at load time.

## Before you open a PR

Run the full check suite and make sure it passes:

```bash
bun run test         # bun test plus the changelog-tooling tests
bun run typecheck    # tsc --noEmit
bun run lint:sh      # bash -n on every script
```

CI runs the same checks plus ShellCheck on the scripts.

For changes to prediction, `bun run eval` measures quality on your local
OpenCode history. Compare before and after on the default test split and tune
only against `--split val`. Pruning sessions shrinks that history, so freeze a
benchmark once with `bun run eval --freeze <file>` and compare against it with
`--prompts <file>`. The frozen file holds raw prompt text: keep it outside the
repository; it is written with owner-only permissions. It also records each
prompt's session and time; older frozen files without them load in file order
with no session grouping.

Recommended workflow: freeze a benchmark, tune on `--split val --online`
(score-then-learn, as the plugin learns after every prompt), compare before and
after with `--alternatives --per-prompt <file>` on each branch followed by
`bun run eval --bootstrap <before.json> <after.json>` (paired 95% intervals),
and report the test split once. Both files must come from the same prompts, `--split`
and `--online` setting; the bootstrap refuses mismatches. Per-prompt files hold counts
only, never text.

## Guidelines

- Read [AGENTS.md](AGENTS.md) first. It documents the layout and the hard-won
  rules — in particular, changes that regress them will not be merged.
- Keep PRs focused. One concern per PR, with a clear description of the *why*.
- Match the surrounding style. TypeScript is formatted by hand; no formatter is
  enforced.
- Keep suggestions separate from the text buffer until explicitly accepted.
- Keep `Tab`/`→` capture scoped to a visible suggestion in the focused normal
  composer. Acceptance inserts a completion or replaces only the active word,
  preserves native undo, and never submits the draft.
- Keep prediction local and preserve Ghost's empty-composer suggestions.
- New behaviour should come with a test in `test/` where practical.

## Commit messages

This project follows [Conventional Commits](https://www.conventionalcommits.org/):

```text
<type>(<optional scope>): <description>
```

| Type | Use for | Version impact |
| --- | --- | --- |
| `feat` | a new feature | minor |
| `fix` | a bug fix | patch |
| `perf` | a performance improvement | patch |
| `docs` | documentation only | none |
| `refactor` | behaviour-preserving change | none |
| `test` | tests only | none |
| `build` | build system or dependencies | none |
| `ci` | CI configuration | none |
| `chore` | other maintenance | none |

- Write the subject in the imperative mood, lower case, no trailing period.
- Add a body when the *why* is not obvious from the subject.
- Flag incompatible changes with `!` after the type/scope (`feat!:`) and/or a
  `BREAKING CHANGE:` footer; that maps to a major version.

Examples:

```text
feat(completion): rank word suffixes by preceding words
fix(tui): stop capturing tab when no suggestion is visible
docs: document the caveats
feat!: raise the minimum supported opencode version
```

This is enforced locally by Git hooks that `bun install` installs (via husky):

- `commit-msg` runs commitlint over your message.
- `pre-commit` runs `bun run lint:sh`, `bun run typecheck`, and `bun run test`.

Never bypass hooks. Fix failures before committing.

## Releases

Releases are cut from the **Release** workflow (`workflow_dispatch`), which asks
for a `patch`, `minor` or `major` bump and then:

1. bumps `package.json` to the next version,
2. drafts notable commits since the last release and writes a dated version
   section with a compare link in [CHANGELOG.md](CHANGELOG.md),
3. commits and tags `vX.Y.Z`, publishes to npm with provenance, and creates the
   GitHub release with the new version section as its body.

Write Conventional Commits for notable changes. A release with no notable
commits since the previous tag is a no-op; pushing a tag by hand still works,
and a tag without a matching section uses GitHub-generated notes.

`scripts/changelog.sh` performs the same steps locally:

```bash
scripts/changelog.sh draft              # classify commits since the last tag (prints only)
scripts/changelog.sh release <version>  # create a dated section and compare link
scripts/changelog.sh notes <version>    # the release-notes body for a version
scripts/changelog.sh notes              # the latest released version
scripts/changelog.sh check              # structure: headings and compare links
```

`bun run test:changelog` covers the tooling, and `check` also runs in CI: every
released heading needs its link definition. See [RELEASING.md](RELEASING.md)
for the npm trusted-publisher setup.

## Reporting bugs

Use the issue templates. For bugs, include your OS, `opencode` version, and the
steps to reproduce.

## Security

Please do not file public issues for security problems. See
[SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
