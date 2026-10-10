"""Release versions: MAJOR.MM, taken from manifest.json (1.00, 1.01, ... 1.99, 2.00).

usage:
  python scripts/version.py bump     # manifest.json to the next version
  python scripts/version.py status   # will a push to main release the manifest's version?
  python scripts/version.py plan     # CI: the versions already released on stdin, one per line

`plan` prints `version=` and `release=` lines for $GITHUB_OUTPUT. Versions that
are already released, or tags in another format, are never released again; a
manifest version lower than the latest release fails.
"""

from __future__ import annotations

import json
from pathlib import Path
import re
import subprocess
import sys

MANIFEST = Path(__file__).parents[1] / "custom_components/iss_pass_prediction/manifest.json"
VERSION_RE = re.compile(r"(\d+)\.(\d{2})")


def parse(version: str) -> tuple[int, int]:
    """(major, minor) of a version like 1.07; anything else is an error."""
    match = VERSION_RE.fullmatch(version)
    if not match:
        raise ValueError(f"{version!r} is not a MAJOR.MM version such as 1.00")
    return int(match[1]), int(match[2])


def next_version(version: str) -> str:
    """The version after this one: 1.00 -> 1.01, 1.99 -> 2.00."""
    major, minor = parse(version)
    return f"{major + 1}.00" if minor == 99 else f"{major}.{minor + 1:02d}"


def manifest_version(path: Path = MANIFEST) -> str:
    return json.loads(path.read_text())["version"]


def latest(released: list[str]) -> str | None:
    """The highest release in this format; other tags (v0.1.0, say) are left out."""
    versions = [v for v in released if VERSION_RE.fullmatch(v)]
    return max(versions, key=parse, default=None)


def plan(version: str, released: list[str]) -> tuple[bool, str]:
    """Whether to release `version`, and why."""
    parse(version)
    newest = latest(released)
    if newest is None:
        return True, f"{version} is the first release"
    if parse(version) > parse(newest):
        return True, f"{version} follows the latest release, {newest}"
    if version == newest:
        return False, (
            f"{version} is already released; raise the version in manifest.json "
            f"(python scripts/version.py bump gives {next_version(version)}) to release again"
        )
    raise ValueError(f"manifest.json says {version}, lower than the latest release, {newest}")


def bump(path: Path = MANIFEST) -> tuple[str, str]:
    """Raise the manifest's version by one step, keeping the file's layout."""
    text = path.read_text()
    old = manifest_version(path)
    new = next_version(old)
    text, count = re.subn(r'("version":\s*")[^"]*(")', rf"\g<1>{new}\g<2>", text)
    if count != 1:
        raise ValueError(f"{path} has no single version field")
    path.write_text(text)
    return old, new


def _remote_tags() -> list[str]:
    out = subprocess.run(
        ["git", "ls-remote", "--tags", "--refs", "origin"],
        capture_output=True,
        text=True,
        check=True,
        cwd=MANIFEST.parent,
    ).stdout
    return [line.rsplit("refs/tags/", 1)[-1] for line in out.splitlines() if "refs/tags/" in line]


def main(argv: list[str]) -> int:
    command = argv[1] if len(argv) > 1 else ""
    try:
        if command == "bump":
            old, new = bump()
            print(f"manifest.json: {old} -> {new}")
        elif command == "status":
            release, why = plan(manifest_version(), _remote_tags())
            print(f"{why}." + (" CI releases it once the checks pass on main." if release else ""))
        elif command == "plan":
            version = manifest_version()
            release, why = plan(version, sys.stdin.read().split())
            print(f"::notice title=Release::{why}", file=sys.stderr)
            print(f"version={version}\nrelease={str(release).lower()}")
        else:
            print(__doc__, file=sys.stderr)
            return 2
    except (ValueError, subprocess.CalledProcessError) as err:
        print(f"::error title=Release::{err}" if command == "plan" else err, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
