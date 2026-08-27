#!/usr/bin/env python3
"""Deterministic source-file separation-of-concerns checker."""

from __future__ import annotations

import argparse
import fnmatch
import json
import subprocess
import sys
from dataclasses import dataclass
from datetime import date
from pathlib import Path, PurePosixPath
from typing import Any
import tomllib


DEFAULT_LIMIT = 300
DEFAULT_POLICY = "soc-policy.toml"
SOURCE_SUFFIXES = frozenset({
    ".c", ".cc", ".cpp", ".css", ".cxx", ".go", ".h", ".hpp", ".html",
    ".java", ".js", ".jsx", ".json", ".kt", ".kts", ".mjs", ".cjs", ".php", ".py", ".rb",
    ".rs", ".sh", ".sql", ".swift", ".toml", ".ts", ".tsx", ".vue", ".yaml", ".yml",
})
BINARY_SUFFIXES = frozenset({
    ".7z", ".avi", ".bin", ".class", ".dll", ".eot", ".exe", ".gif", ".gz", ".ico",
    ".jpeg", ".jpg", ".mp3", ".mp4", ".otf", ".pdf", ".png", ".pyc", ".so", ".tar",
    ".ttf", ".wav", ".webm", ".woff", ".woff2", ".zip",
})
DEFAULT_EXCLUDES = (
    ".git/**", ".venv/**", "venv/**", "build/**", "dist/**", "node_modules/**",
    "vendor/**", "generated/**", "coverage/**", "*.lock", "*.min.js", "*.map",
)


class PolicyError(ValueError):
    """Raised when policy, Git state, or source input cannot be trusted."""


@dataclass(frozen=True)
class ExceptionRule:
    path: str
    reason: str
    owner: str
    expires: date


@dataclass(frozen=True)
class PolicyConfig:
    limit: int
    include: tuple[str, ...]
    exclude: tuple[str, ...]
    exceptions: dict[str, ExceptionRule]
    grandfathered: dict[str, int]

    @classmethod
    def load(cls, path: Path) -> "PolicyConfig":
        try:
            with path.open("rb") as stream:
                raw = tomllib.load(stream)
        except FileNotFoundError as exc:
            raise PolicyError(f"policy configuration not found: {path}") from exc
        except (OSError, tomllib.TOMLDecodeError) as exc:
            raise PolicyError(f"cannot read policy configuration {path}: {exc}") from exc
        if not isinstance(raw, dict):
            raise PolicyError("policy configuration must be a TOML table")
        limit = raw.get("limit", DEFAULT_LIMIT)
        include = raw.get("include", ["**/*"])
        configured_exclude = raw.get("exclude", [])
        if isinstance(limit, bool) or not isinstance(limit, int) or limit < 1:
            raise PolicyError("limit must be a positive integer")
        if not _strings(include) or not _strings(configured_exclude):
            raise PolicyError("include and exclude must be string arrays")
        exceptions = _rules(raw.get("exceptions", []), _exception)
        grandfathered = _grandfather_rules(raw.get("grandfathered", []), limit)
        return cls(limit, tuple(include), tuple(DEFAULT_EXCLUDES) + tuple(configured_exclude), exceptions, grandfathered)


@dataclass(frozen=True)
class FileResult:
    path: str
    effective_lines: int | None
    included: bool
    reason: str
    violation: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {"path": self.path, "effective_lines": self.effective_lines, "included": self.included, "reason": self.reason, "violation": self.violation}


def _strings(value: Any) -> bool:
    return isinstance(value, list) and all(isinstance(item, str) and item.strip() for item in value)


def _rules(value: Any, parser: Any) -> dict[str, Any]:
    if not isinstance(value, list):
        raise PolicyError("policy rule collections must be arrays of tables")
    result: dict[str, Any] = {}
    for item in value:
        if not isinstance(item, dict):
            raise PolicyError("each policy rule must be a table")
        rule = parser(item)
        if rule.path in result:
            raise PolicyError(f"duplicate policy rule path: {rule.path}")
        result[rule.path] = rule
    return result


def _policy_path(value: Any, label: str = "path") -> str:
    if not isinstance(value, str):
        raise PolicyError(f"{label} must be an exact relative path")
    path = value.replace("\\", "/").strip()
    parts = PurePosixPath(path).parts
    if not path or path.startswith("/") or ".." in parts or any(char in path for char in "*?["):
        raise PolicyError(f"{label} must be an exact relative path: {value!r}")
    return path


def _exception(item: dict[str, Any]) -> ExceptionRule:
    path = _policy_path(item.get("path"), "exception path")
    reason, owner, expiry = (item.get(name) for name in ("reason", "owner", "expires"))
    if not all(isinstance(value, str) and value.strip() for value in (reason, owner, expiry)):
        raise PolicyError(f"exception {path} needs reason, owner, and expires")
    try:
        expires = date.fromisoformat(expiry)
    except ValueError as exc:
        raise PolicyError(f"exception {path} has invalid expiry: {expiry!r}") from exc
    if expires < date.today():
        raise PolicyError(f"exception {path} expired on {expires.isoformat()}")
    return ExceptionRule(path, reason.strip(), owner.strip(), expires)


def _grandfather_rules(value: Any, limit: int) -> dict[str, int]:
    if isinstance(value, dict):
        value = [{"path": path, "baseline": baseline} for path, baseline in value.items()]
    if not isinstance(value, list):
        raise PolicyError("grandfathered must be a table or an array of tables")
    result: dict[str, int] = {}
    for item in value:
        if not isinstance(item, dict):
            raise PolicyError("each grandfathered rule must be a table")
        path = _policy_path(item.get("path"), "grandfathered path")
        baseline = item.get("baseline")
        if isinstance(baseline, bool) or not isinstance(baseline, int) or baseline <= limit:
            raise PolicyError(f"grandfathered {path} needs an integer baseline above the limit")
        if path in result:
            raise PolicyError(f"duplicate policy rule path: {path}")
        result[path] = baseline
    return result


def _matches(path: str, patterns: tuple[str, ...]) -> bool:
    for pattern in patterns:
        normalized = pattern.replace("\\", "/")
        if fnmatch.fnmatchcase(path, normalized) or PurePosixPath(path).match(normalized):
            return True
        if normalized.startswith("**/") and fnmatch.fnmatchcase(path, normalized[3:]):
            return True
    return False


def _comment_markers(path: str) -> tuple[str, ...]:
    suffix = Path(path).suffix.lower()
    if suffix in {".py", ".rb", ".sh", ".yaml", ".yml", ".toml"} or Path(path).name.lower() in {"dockerfile", "makefile"}:
        return ("#",)
    if suffix == ".sql":
        return ("--", "/*")
    if suffix in {".html", ".vue"}:
        return ("<!--", "/*", "//")
    return ("//", "/*")


def effective_line_count(path: Path) -> int:
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        raise PolicyError(f"cannot read source file {path}: {exc}") from exc
    markers = _comment_markers(path.name)
    block_end = "-->" if "<!--" in markers else "*/"
    block_start = "<!--" if "<!--" in markers else "/*"
    quote: str | None = None
    block = False
    count = 0
    for raw_line in text.splitlines():
        line_has_code = False
        index = 0
        while index < len(raw_line):
            if block:
                end = raw_line.find(block_end, index)
                if end < 0:
                    index = len(raw_line)
                    continue
                block = False
                index = end + len(block_end)
                continue
            if quote:
                if raw_line[index] not in " \t\r":
                    line_has_code = True
                if raw_line.startswith(quote, index) and (index == 0 or raw_line[index - 1] != "\\"):
                    index += len(quote)
                    quote = None
                else:
                    index += 1
                continue
            if raw_line[index] in " \t\r":
                index += 1
                continue
            if any(raw_line.startswith(marker, index) for marker in markers if marker not in {"/*", "<!--"}):
                break
            if raw_line.startswith(block_start, index):
                block = True
                index += len(block_start)
                continue
            if raw_line[index] in "'\"`":
                quote_char = raw_line[index]
                quote = quote_char * (3 if raw_line.startswith(quote_char * 3, index) else 1)
                line_has_code = True
                index += len(quote)
                continue
            line_has_code = True
            index += 1
        if line_has_code:
            count += 1
    return count


def _git(root: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True, check=False)


def _git_paths(root: Path, mode: str) -> list[str]:
    if _git(root, "rev-parse", "--show-toplevel").returncode != 0:
        raise PolicyError(f"not a Git repository: {root}")
    if mode != "changed":
        result = _git(root, "ls-files", "--cached")
        if result.returncode != 0:
            raise PolicyError(f"git tracked-file query failed: {result.stderr.strip()}")
        untracked = _git(root, "ls-files", "--others", "--exclude-standard")
        if untracked.returncode != 0:
            raise PolicyError(f"git untracked-file query failed: {untracked.stderr.strip()}")
        deleted = _git(root, "ls-files", "--deleted")
        if deleted.returncode != 0:
            raise PolicyError(f"git deleted-file query failed: {deleted.stderr.strip()}")
        deleted_paths = {line.strip().replace("\\", "/") for line in deleted.stdout.splitlines() if line.strip()}
        paths = {line.strip().replace("\\", "/") for output in (result.stdout, untracked.stdout) for line in output.splitlines() if line.strip()}
        return sorted(paths - deleted_paths)
    changed = _git(root, "diff", "--name-only", "--diff-filter=ACMR", "HEAD")
    if changed.returncode != 0:
        changed = _git(root, "diff", "--cached", "--name-only", "--diff-filter=ACMR")
    new = _git(root, "ls-files", "--others", "--exclude-standard")
    if new.returncode != 0 or changed.returncode != 0:
        error = changed.stderr.strip() or new.stderr.strip()
        raise PolicyError(f"git changed-file query failed: {error}")
    return sorted({line.strip().replace("\\", "/") for output in (changed.stdout, new.stdout) for line in output.splitlines() if line.strip()})


def check(root: Path, *, mode: str = "all", policy_path: Path | None = None) -> dict[str, Any]:
    if mode not in {"all", "changed", "no-growth", "explain"}:
        raise PolicyError("mode must be all, changed, no-growth, or explain")
    root = root.resolve()
    config = PolicyConfig.load((policy_path or root / DEFAULT_POLICY).resolve())
    paths = _git_paths(root, "changed" if mode == "changed" else "all")
    results: list[FileResult] = []
    for name in paths:
        source = Path(name).suffix.lower() in SOURCE_SUFFIXES and Path(name).suffix.lower() not in BINARY_SUFFIXES
        included = source and _matches(name, config.include) and not _matches(name, config.exclude)
        if not included:
            results.append(FileResult(name, None, False, "excluded by source, include, or exclude rule"))
            continue
        count = effective_line_count(root / name)
        exception = config.exceptions.get(name)
        baseline = config.grandfathered.get(name)
        violation: str | None = None
        reason = "within limit"
        if exception:
            reason = f"exception until {exception.expires.isoformat()} owned by {exception.owner}: {exception.reason}"
        elif count > config.limit and baseline is None:
            violation = f"{count} effective lines exceeds limit {config.limit}"
            reason = "new or non-grandfathered over-limit file"
        elif baseline is not None and count > baseline:
            violation = f"{count} effective lines grew beyond grandfathered baseline {baseline}"
            reason = "grandfathered file growth"
        results.append(FileResult(name, count, included, reason, violation))
    violations = [result.as_dict() for result in results if result.violation]
    return {"ok": not violations, "mode": mode, "limit": config.limit, "violations": violations, "files": [result.as_dict() for result in results]}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Check a repository's deterministic source-file policy")
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--policy", type=Path)
    parser.add_argument("--mode", choices=("all", "changed", "no-growth", "explain"), default="changed")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    try:
        report = check(args.root, mode=args.mode, policy_path=args.policy)
    except PolicyError as exc:
        report = {"ok": False, "error": str(exc)}
        print(json.dumps(report, sort_keys=True))
        print(f"soc-check: {exc}", file=sys.stderr)
        return 2
    if args.json or args.mode == "explain":
        print(json.dumps(report, indent=2, sort_keys=True))
    elif report["ok"]:
        print(f"soc-check: OK ({report['mode']}, limit {report['limit']})")
    else:
        for item in report["violations"]:
            print(f"soc-check: {item['path']}: {item['violation']}", file=sys.stderr)
        print(f"soc-check: {len(report['violations'])} violation(s)", file=sys.stderr)
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
