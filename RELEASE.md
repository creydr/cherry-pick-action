# Releasing

This project uses release branches and automated tagging to manage releases.

## Release branches

Each minor version has a dedicated branch named `release-<major>.<minor>` (e.g. `release-1.0`). Fixes are cherry-picked into these branches from `main`.

## Creating a new minor release

1. Create a release branch from `main`:
   ```
   git checkout main && git pull
   git checkout -b release-1.1
   git push origin release-1.1
   ```
2. The `manage-release-tags` workflow automatically detects the new branch, creates the `v1.1.0` tag, and triggers the `release` workflow to publish a GitHub release with auto-generated notes. The `v1` and `v1.1` floating tags are also updated.

## Patch releases

When fixes are cherry-picked into a release branch, a new patch release can be created by triggering the `manage-release-tags` workflow manually via `workflow_dispatch`. It will:

1. Scan all `release-*` branches for new commits since the latest tag
2. Create the next patch tag (e.g. `v1.0.2`) pointing at the branch head
3. Trigger the `release` workflow to publish the GitHub release

This workflow also runs on a weekly schedule (Tuesdays at 8:00 UTC) to automatically pick up any unreleased changes.

## Floating tags

The `release` workflow maintains floating major (`v1`) and minor (`v1.0`) tags that always point to the latest patch release in their series. Users referencing `@v1` in their workflows automatically get the latest fixes.
