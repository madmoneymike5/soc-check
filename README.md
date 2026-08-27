# soc-check

`soc-check` enforces a deterministic 300-effective-line source-file policy.
Blank lines and comment-only lines do not count. Every nonblank physical line
inside a multiline string counts. Existing oversized files may be listed in
`soc-policy.toml` with an exact baseline; growth fails. Exceptions name one
exact path and require an owner, reason, and unexpired date.

Enrolled repositories use the shared checker at a pinned Git commit:

```toml
checker_commit = "<soc-check commit>"
```

Local hooks call `bin/soc-check-hook`. CI should fetch `soc_check.py` from the
same commit and run `--mode all`. A missing policy, broken policy, missing
checker, or pin mismatch is an error. The checker has no network or package
dependencies beyond Python 3.11's standard library.

To enroll a project, first confirm its Git root and get approval if it is an
unknown or upstream repository. Add `soc-policy.toml`, pin `checker_commit`,
add a `.soc-enrolled` marker, and install tracked `pre-commit` and `pre-push`
hooks under `.githooks/`. Set `core.hooksPath` to `.githooks` locally. Add the
CI workflow that fetches this repository's checker source at the pinned commit.
Do not enroll temporary worktrees, snapshots, generated checkouts, or publish
staging directories.

Codex uses a global `PostToolUse` check plus a `Stop` check. Pi uses the
separate `~/.pi/agent/extensions/soc-check` extension: read-only inspection is
allowed while blocked, but unrelated tool calls are blocked until the listed
files are repaired. The Pi extension does not modify the auto-reviewer.
