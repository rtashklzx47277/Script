# Repository Guidelines

## Scope

These rules apply to this public `Script` repository (`origin/main`).
- Do **not** include, modify, commit, or push anything inside `Script-Private/` (managed by a separate private repository).
- Do **not** stage or commit unrelated pre-existing untracked files in the working tree (for example, temporary `.png` screenshots).

## Verification & Versioning

- When modifying any `.user.js` behavior, increment its `@version` metadata header and update `README.md` when user-facing behavior or documentation changes.
- Before committing, run the full test suite and verify all tests pass:
  ```sh
  node --test tests/*.test.cjs
  ```
- All test suites in this repository complete within a few seconds; if any test command stalls past 10 seconds or falls back to a background task with no new output, do not wait passively—kill it immediately and diagnose the stuck test or command.
- In unit test harnesses that mock `setTimeout` without auto-firing (e.g., `boot()` in `tests/twitch-chat.test.cjs` and `tests/youtube-chat-filter.test.cjs`), always pair mocked timers with a deterministic default clock (`performance.now`) so time-budgeted yield loops (`restoreHistory`) cannot deadlock on real wall-clock delays under parallel load.
- Commands that require outbound network access (such as `npx.cmd -y modern-web-guidance@latest ...`) can hang waiting on network timeouts inside an offline sandbox; run them with network access (or `--offline` when cached) instead of waiting on an offline sandboxed call.

## Git Workflow

- After completing and verifying changes in this repository, stage only the files edited/created for the task (avoid `git add -A`), commit with a concise single-line imperative English commit message matching the existing git history, and push directly to `origin/main` on GitHub without waiting for a separate commit/push prompt (unless the user explicitly asks not to push).
- Run `git add <files>`, `git commit -m "<message>"`, and `git push origin main` as separate, single commands (do not chain them with `&&`, `;`, or command substitutions) so each subcommand stays prefix-matchable by terminal command allowlists.
- Keep verification (`node --test tests/*.test.cjs`) and read-only git checks (`git status`, `git diff`, `git log`) sandboxed. When `.git/` write protection or network isolation blocks `git add`, `git commit`, or `git push` inside the sandbox, run each blocked git command individually outside the sandbox (`BypassSandbox: true`); if a security policy or approval check still denies `BypassSandbox: true`, stop and report the pending files and exact git commands to the user.
