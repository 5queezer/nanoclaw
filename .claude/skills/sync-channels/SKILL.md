---
name: sync-channels
description: Fetch and merge all channel remotes (telegram, gmail, etc.) into main, then push to origin. Handles package-lock.json conflicts automatically.
---

# About

Channel code lives in separate upstream repos (e.g., `nanoclaw-telegram`, `nanoclaw-gmail`) added as git remotes. This skill fetches all remotes, merges any new commits from each channel's `main` branch into your local `main`, and pushes to origin.

Run `/sync-channels` in Claude Code.

## How it works

**Step 1 — Preflight**:
- Verify working tree is clean (`git status --porcelain`). If dirty, ask user to commit or stash first.
- Verify current branch is `main`. If not, ask to switch.

**Step 2 — Fetch**:
- Run `git fetch --all` to pull latest from every remote.

**Step 3 — Identify channel remotes**:
- List all remotes (`git remote -v`).
- Exclude `origin` and `upstream` — everything else is a channel remote.
- For each channel remote, check if `<remote>/main` exists.

**Step 4 — Check for updates**:
- For each channel remote with a `main` branch, run `git log --oneline main..<remote>/main`.
- If no new commits, skip that remote.
- Show the user a summary of which channels have updates and how many commits.

**Step 5 — Merge**:
- For each channel with new commits, merge `<remote>/main` into `main`:
  ```bash
  git merge <remote>/main --no-edit -m "Merge <remote>/main: <summary>"
  ```
- If merge conflicts occur:
  - For `package-lock.json`: resolve with `git checkout --theirs package-lock.json && git add package-lock.json`
  - For other files: stop and show the user the conflicting files, ask how to proceed.
- After all merges, run `npm install` if `package-lock.json` was updated, to ensure it's consistent.

**Step 6 — Push**:
- Push `main` to `origin`: `git push origin main`
- Report success with a summary of what was merged.

## Important

- Never remove channel remotes — they're kept for future syncing.
- All remotes besides `origin` and `upstream` are treated as channel remotes.
- Only merges `main` branches from channel remotes, not feature/fix branches.
