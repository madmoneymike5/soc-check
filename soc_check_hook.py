#!/usr/bin/env python3
"""Run the pinned shared checker from a repository hook or CI wrapper."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import tomllib
from pathlib import Path

from soc_check import PolicyError, main as checker_main


DEFAULT_CHECKER = Path("/home/sarah-taylor/Dev/soc-check/soc_check.py")


def _root() -> Path:
    result = subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True, check=False)
    if result.returncode != 0:
        raise PolicyError("cannot find the Git root")
    return Path(result.stdout.strip()).resolve()


def _policy(root: Path) -> dict[str, object]:
    path = root / "soc-policy.toml"
    try:
        with path.open("rb") as stream:
            value = tomllib.load(stream)
    except (FileNotFoundError, OSError, tomllib.TOMLDecodeError) as exc:
        raise PolicyError(f"cannot load enrolled repository policy {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise PolicyError("soc-policy.toml must contain a table")
    commit = value.get("checker_commit")
    if not isinstance(commit, str) or len(commit) < 7 or any(char not in "0123456789abcdef" for char in commit.lower()):
        raise PolicyError("soc-policy.toml must pin checker_commit to a hexadecimal commit")
    return value


_GIT_ENV_VARS = ("GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE", "GIT_PREFIX", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES")


def _clean_git_env() -> dict:
    """Git sets GIT_DIR/GIT_INDEX_FILE/... in the environment of running
    hooks; those must not leak into git calls made against the checker
    repository, or the status check is evaluated against the caller's
    repo and reports the checker files as untracked."""
    env = {k: v for k, v in os.environ.items() if k not in _GIT_ENV_VARS}
    return env


def _verify_checker(checker: Path, expected: str) -> None:
    if not checker.is_file():
        raise PolicyError(f"shared checker not found: {checker}")
    repo = checker.parent
    hook_source = repo / "soc_check_hook.py"
    if not hook_source.is_file():
        raise PolicyError(f"shared hook source not found: {hook_source}")
    result = subprocess.run(["git", "-C", str(repo), "rev-parse", "HEAD"], capture_output=True, text=True, check=False, env=_clean_git_env())
    if result.returncode != 0 or result.stdout.strip() != expected:
        actual = result.stdout.strip() or "unavailable"
        raise PolicyError(f"checker pin mismatch: expected {expected}, got {actual}")
    dirty = subprocess.run(
        ["git", "-C", str(repo), "status", "--porcelain", "--untracked-files=all", "--", checker.name, hook_source.name],
        capture_output=True,
        text=True,
        check=False,
        env=_clean_git_env(),
    )
    if dirty.returncode != 0:
        raise PolicyError(f"cannot verify checker worktree: {dirty.stderr.strip()}")
    if dirty.stdout.strip():
        raise PolicyError(f"checker worktree is dirty: {checker}")
    digest = hashlib.sha256(checker.read_bytes()).hexdigest()
    expected_digest = os.environ.get("SOC_CHECK_SHA256")
    if expected_digest and digest != expected_digest:
        raise PolicyError(f"checker digest mismatch: expected {expected_digest}, got {digest}")


def run(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--mode", default="changed")
    args, _ = parser.parse_known_args(argv)
    root = _root()
    policy = _policy(root)
    checker = Path(os.environ.get("SOC_CHECK_FILE", str(DEFAULT_CHECKER))).expanduser().resolve()
    expected = policy["checker_commit"]
    if not isinstance(expected, str):
        raise PolicyError("checker_commit must be a string")
    _verify_checker(checker, expected)
    return checker_main(["--root", str(root), "--policy", str(root / "soc-policy.toml"), "--mode", args.mode, "--json"])


if __name__ == "__main__":
    try:
        raise SystemExit(run(sys.argv[1:]))
    except PolicyError as exc:
        print(json.dumps({"ok": False, "error": str(exc)}))
        print(f"soc-check-hook: {exc}", file=sys.stderr)
        raise SystemExit(2)
