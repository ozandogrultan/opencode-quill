# Releasing

[`.github/workflows/release.yml`](.github/workflows/release.yml) does the whole
job: run tests, publish to npm with provenance, and create the GitHub release.
There are two ways to trigger it.

Development uses [bun](https://bun.sh) (`bun install`, `bun run test`). Publishing
still uses the npm CLI: npm trusted publishing (OIDC) and provenance
attestations are only supported through `npm publish`, so `bun publish` is not
used here.

## One-click (recommended)

From the Actions tab (**Release → Run workflow**) or:

```bash
gh workflow run release.yml -f bump=patch   # or minor / major
```

That workflow checks out `main`, bumps the version, commits and tags it,
pushes, publishes to npm, and cuts the GitHub release using the new CHANGELOG section as its notes.
If publishing fails after the tag is pushed, use **Re-run failed jobs**: the
publish job retries the existing tag without cutting a new version.

Do this from a green `main` — it releases whatever is there.

## From a tag push

If you prefer to bump locally:

```bash
npm version minor          # patch / minor / major per the commit types
git push --follow-tags     # the tag push triggers the same release workflow
```

`prepublishOnly` runs the tests and typecheck again before uploading.

## Before you release

Pick the bump from the [Conventional Commits](CONTRIBUTING.md#commit-messages)
since the last release — the highest impact wins: `feat` → minor,
`fix`/`perf` → patch, `!`/`BREAKING CHANGE` → major.

The workflow drafts notable Conventional Commits since the last release tag,
then runs `scripts/changelog.sh release` to write the new version section in
[CHANGELOG.md](CHANGELOG.md). `changelog.sh draft` previews the next release;
`changelog.sh check` validates links, and `changelog.sh notes` reads the latest
released body. A dispatch with no notable new commits does nothing.

## One-time setup

npm uses [trusted publishing][trusted], so no token is stored in the repo. On
npmjs.com, under `opencode-quill` → Settings → Trusted Publishers, the GitHub
Actions publisher must point at:

- owner: `ozandogrultan`
- repository: `opencode-quill`
- workflow filename: `release.yml`

Renaming that workflow file breaks publishing; update the npm setting too.

[trusted]: https://docs.npmjs.com/trusted-publishers

## Verifying

- npm: `npm view opencode-quill version` and
  `npm view opencode-quill dist.attestations` (provenance present).
- GitHub: a release exists for the tag, with the CHANGELOG section as its body.

## Manual fallback

Only if CI is unavailable:

```bash
npm login
npm publish --access public
```

Manual publishes do not get provenance attestations.
