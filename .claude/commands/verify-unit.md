---
description: Run the verification checks for a BUILD_SEQUENCE.md unit and report UNIT VERIFIED or UNIT FAILED. Report only; never fixes anything.
argument-hint: <unit number 1-8>
allowed-tools: Bash(npm run typecheck), Bash(npm test:*), Bash(git diff:*), Bash(git status:*), Bash(git ls-files:*), Bash(git branch:*), Read
---

Verify build unit **$ARGUMENTS** of BUILD_SEQUENCE.md.

## Hard rule: report only

Do **not** fix, edit, create, delete, format, stage, commit or install anything, even when the fix is obvious. Do not re-run a check hoping for a different result. If a check fails, report it and stop at the report.

If `$ARGUMENTS` is empty or not a number from 1 to 8, report `UNIT FAILED: no valid unit number given` and stop.

## Check 1: type check

Run `npm run typecheck`. This is `tsc -p tsconfig.check.json`, the project's equivalent of `tsc --noEmit`. Never run bare `npx tsc`: `tsconfig.json` has `rootDir: ./src` and also includes `api/`, so bare `tsc` always fails with TS6059 (see CLAUDE.md).

- **Pass:** exit code 0.
- **Fail:** list every error as `file:line:col  TSxxxx  message`.

## Check 2: tests

Run `npm test -- --json --outputFile=jest-results.json`. This is `jest --ci --runInBand` plus a JSON report. Read `jest-results.json` and report:

- the pass count (`numPassedTests`) and the total (`numTotalTests`);
- the fail count (`numFailedTests`), with each failing test's full name and the first lines of its failure message;
- skipped (`numPendingTests`) and todo (`numTodoTests`).

The check passes only when the command exits 0 **and** `numFailedTests`, `numPendingTests` and `numTodoTests` are all 0. A leftover `.only` shows up as pending tests. If there is no Jest config or no tests, that is a failure, not a pass.

## Check 3: changed files vs. unit scope

Run:

- `git diff --name-only HEAD`, for tracked files modified since the last commit, staged or not;
- `git ls-files --others --exclude-standard`, for new untracked files. New files are most of a unit's work, and `git diff` does not show them.

List every file from both. Then compare each one against the expected scope for unit $ARGUMENTS below, and flag every file outside it.

**Always in scope, for any unit:**
- `tests/**`
- `CONTRACT.md` and `BUILD_SEQUENCE.md`. List these separately under "contract changes", because CONTRACT.md §7 requires a contract change to ship with the code that needs it.

**Never in scope on `main`:** `supabase/migrations/**` and `src/types/**`. They belong to the schema session (CONTRACT.md §6). Check the branch with `git branch --show-current`. On `schema`, the expected scope is exactly those two directories and nothing else, whatever the unit.

| Unit | Expected scope (besides the always-in-scope files) |
|---|---|
| 1. Provider abstraction interface | `src/providers/provider.ts` (no implementation), `jest.config.js`, `tsconfig.check.json` |
| 2. Gmail OAuth layer + token persistence | `src/middleware/`, `src/providers/gmail/`, `src/providers/provider.ts` (interface additions only), `src/db/`, `src/services/`, `src/config/`, `api/v1/auth/google/callback.ts`, `package.json`, `package-lock.json` |
| 3. Sync and read layer | `src/sync/`, `src/db/`, `src/providers/gmail/` |
| 4. Pub/Sub webhook receiver + cron renewal | `src/webhook/`, `src/cron/`, `src/sync/`, `src/db/`, `src/providers/gmail/` |
| 5. Send layer | `src/send/`, `src/db/`, `src/providers/gmail/` |
| 6. Mark-as-read layer | `src/db/`, `src/providers/gmail/`, plus one new module for the mark-read logic under `src/` (report its path) |
| 7. Vercel API function entry points | `api/**`, `src/middleware/`, `src/http/`, `vercel.json` |
| 8. Integration tests | `tests/**`, test configuration (`jest.config.*`, `tests/` fixtures), `package.json` |

A file outside the table's scope is an **unexpected modification**, even if the change looks harmless. `jest-results.json` is git-ignored and never counts.

## Report

Use exactly this structure:

```
## /verify-unit $ARGUMENTS: <unit name>

Check 1 (typecheck): PASS | FAIL
  <errors, if any>

Check 2 (tests): PASS | FAIL
  passed X / total Y, failed Z, skipped P, todo T
  <failure messages, if any>

Check 3 (changed files): PASS | FAIL
  in scope:          <files>
  contract changes:  <files, if any>
  UNEXPECTED:        <files, if any>

UNIT VERIFIED
or
UNIT FAILED
  - <each specific failure, one line each>
```

The result is **UNIT VERIFIED** only when Check 1 passes, Check 2 passes, and Check 3 shows no unexpected files. Otherwise it is **UNIT FAILED**, listing every failure. The checks are not a substitute for the unit's own **Verified** sentence in BUILD_SEQUENCE.md. Quote that sentence at the end so the human can confirm it against the results.
