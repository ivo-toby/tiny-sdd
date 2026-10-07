# TinySDD releases

Releases are driven by `.github/workflows/release.yml`. It runs for pushes to
`main` and for a manual dispatch on `main`, but publication is enabled only
when the repository variable `NPM_RELEASES_ENABLED` is exactly `true`. An
unset variable keeps the checks and package smoke available while reporting
that npm publication has not been configured.

The workflow uses Node 24 with npm **>=11.5.1**, GitHub hosted OIDC and no
long-lived npm token. Only the release job receives `contents: write` and
`id-token: write`; the package tests, `npm pack` and the isolated global
install smoke run with inherited npm authentication removed. The trusted
publisher is configured for direct `npm publish` by the GitHub Actions
workflow.

## First package bootstrap

The first package and trusted publisher setup require the npm account owner.
Do these steps manually from a clean, reviewed checkout; the workflow does
not invent an initial version or create the first tag:

1. Review the current `package.json` version and run the test and package
   smoke checks. For the current bootstrap, that reviewed version is `0.1.0`.
2. Create the matching immutable tag at the reviewed `main` commit and push
   that tag before the first npm publication:

   ```sh
   git tag -a v0.1.0 HEAD -m 'TinySDD v0.1.0'
   git push origin v0.1.0
   ```

3. Use Ivo's npm account to create/own `tinysdd` and publish that initial
   reviewed package from the tagged checkout. Confirm that the public package
   version matches the tag.
4. Configure npm Trusted Publishing with GitHub Actions using exactly:
   `ivo-toby` as the owner, `tiny-sdd` as the repository, and `release.yml` as
   the workflow file. Allow direct `npm publish` and do not add a permanent
   npm token to GitHub.
5. A newly configured trusted publisher must complete its first successful
   publish within two days, as required by npm. Coordinate this setup with a
   genuine qualifying `feat`, `fix` or `chore` change (the unchanged bootstrap
   tag produces no release), set the repository variable
   `NPM_RELEASES_ENABLED=true`, and run the workflow while that window is open.

The first tagged package is the history baseline. Later releases use all
reachable commits since the highest reachable stable `vX.Y.Z` tag, including
commits from merged branches; they do not depend on squash merges.

## Version policy

Conventional Commit types and scopes are case-insensitive. `feat` selects a
minor release. `fix` and `chore` select a patch release. A `!` marker or an
uppercase `BREAKING CHANGE` or `BREAKING-CHANGE` footer selects a major
release. The largest selected change wins; `docs`, `test` and other unrelated
types produce no release. Generated `chore(release): vX.Y.Z` commits are
excluded from the next plan.

Each normal release first prepares a detached candidate, bumps only
`package.json`, runs the complete offline suite, packs the candidate and runs
the isolated installed-package smoke. The candidate's package integrity and
commit are recorded in an annotated immutable tag. The commit and tag are
pushed atomically after a fresh `origin/main` check. The versioned Git archive,
package metadata, draft GitHub release asset and npm artifact are checked
before publication.

## Retry and race behavior

The release job is globally serialized and never cancels an in-progress run.
A concurrent `main` movement makes the atomic push fail without a half-pushed
tag. Tags and artifacts are never moved, deleted or overwritten.

If a run stops after the tag push, rerun `release.yml` from `main`. The script
first reuses the retained draft asset, checking its tag integrity and the
installed CLI against the exact tagged source. It rebuilds and verifies the
artifact from that exact tag only when the draft asset is absent, then resumes
the draft release and npm publication. It never uses a newer `main` commit or
computes a second bump for the pending tag. An existing npm version is accepted
only when its immutable integrity matches the tag; it is then not published
again and missing GitHub release metadata is completed.
Registry, archive, GitHub and authentication failures remain errors and must
be retried or investigated.

The local release planner and lifecycle tests use temporary Git and bare
repositories plus injected registry/GitHub/archive adapters. Live npm OIDC,
GitHub release publication and the initial account bootstrap are operator
steps and are not claimed by the offline test results.
