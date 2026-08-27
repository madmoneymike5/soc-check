from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path

from soc_check import PolicyError, check, effective_line_count


def git(root: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(root), *args], check=True, capture_output=True)


def policy(root: Path, extra: str = "") -> None:
    (root / "soc-policy.toml").write_text("limit = 300\ninclude = [\"**/*.py\"]\n" + extra, encoding="utf-8")


class CheckerTests(unittest.TestCase):
    def repo(self) -> tempfile.TemporaryDirectory[str]:
        directory = tempfile.TemporaryDirectory()
        root = Path(directory.name)
        git(root, "init", "-q")
        policy(root)
        (root / "small.py").write_text("x = 1\n", encoding="utf-8")
        git(root, "add", ".")
        git(root, "-c", "user.email=test@example.com", "-c", "user.name=test", "commit", "-qm", "base")
        return directory

    def test_new_and_changed_files_fail_and_report_count(self) -> None:
        with self.repo() as directory:
            root = Path(directory)
            (root / "new.py").write_text("x = 1\n" * 301, encoding="utf-8")
            report = check(root, mode="changed")
            self.assertFalse(report["ok"])
            self.assertEqual(report["violations"][0]["path"], "new.py")
            self.assertEqual(report["violations"][0]["effective_lines"], 301)
            (root / "small.py").write_text("x = 1\n" * 301, encoding="utf-8")
            self.assertEqual({item["path"] for item in check(root, mode="changed")["violations"]}, {"new.py", "small.py"})

    def test_lexical_count_handles_comments_blanks_strings_and_blocks(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "sample.py"
            path.write_text("\n# comment\nvalue = (\n  1 +\n  2\n)\ntext = '''\n# string content\ntext\n'''\n", encoding="utf-8")
            self.assertEqual(effective_line_count(path), 8)
            c_path = Path(directory) / "sample.c"
            c_path.write_text("/* one\ncomment */ int y = 2;\nint x = 1; // code\n// only comment\n", encoding="utf-8")
            self.assertEqual(effective_line_count(c_path), 2)

    def test_grandfathering_and_exception_rules(self) -> None:
        with self.repo() as directory:
            root = Path(directory)
            content = "x = 1\n" * 301
            (root / "legacy.py").write_text(content, encoding="utf-8")
            policy(root, '\n[[grandfathered]]\npath = "legacy.py"\nbaseline = 301\n')
            git(root, "add", ".")
            self.assertTrue(check(root, mode="all")["ok"])
            (root / "legacy.py").write_text(content + "x = 2\n", encoding="utf-8")
            self.assertEqual(check(root, mode="no-growth")["violations"][0]["reason"], "grandfathered file growth")
            (root / "legacy.py").write_text(content, encoding="utf-8")
            policy(root, '\n[[grandfathered]]\npath = "legacy.py"\nbaseline = 301\n\n[[exceptions]]\npath = "small.py"\nreason = "temporary split"\nowner = "codie"\nexpires = "2099-01-01"\n')
            (root / "small.py").write_text(content, encoding="utf-8")
            self.assertTrue(check(root, mode="changed")["ok"])

    def test_broken_policy_and_missing_git_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaises(PolicyError):
                check(root)
            git(root, "init", "-q")
            (root / "soc-policy.toml").write_text("limit = nope\n", encoding="utf-8")
            with self.assertRaises(PolicyError):
                check(root)


if __name__ == "__main__":
    unittest.main()
