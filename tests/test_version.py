"""The release version scheme and the decision CI makes after the checks pass."""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

_SPEC = importlib.util.spec_from_file_location(
    "release_version", Path(__file__).parents[1] / "scripts/version.py"
)
version = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(version)


def test_manifest_version_is_in_the_release_format() -> None:
    version.parse(version.manifest_version())


@pytest.mark.parametrize(
    ("current", "following"),
    [("1.00", "1.01"), ("1.09", "1.10"), ("1.98", "1.99"), ("1.99", "2.00"), ("9.99", "10.00")],
)
def test_next_version(current: str, following: str) -> None:
    assert version.next_version(current) == following


@pytest.mark.parametrize("bad", ["1.0", "1.000", "v1.00", "1.0.0", "1.1a", ""])
def test_other_formats_are_refused(bad: str) -> None:
    with pytest.raises(ValueError):
        version.parse(bad)


def test_release_only_a_higher_version() -> None:
    assert version.plan("1.00", [])[0] is True
    assert version.plan("1.01", ["1.00"])[0] is True
    assert version.plan("2.00", ["1.99", "1.10", "1.09"])[0] is True
    # Unchanged: wait for the version to go up.
    release, why = version.plan("1.10", ["1.09", "1.10"])
    assert release is False
    assert "1.11" in why
    # 1.10 is newer than 1.9x only by number, not by text.
    assert version.latest(["1.09", "1.10", "1.02"]) == "1.10"
    # Tags in another format are not releases of this scheme.
    assert version.plan("1.00", ["v0.1.0", "0.1.0"])[0] is True
    with pytest.raises(ValueError, match="lower than the latest release"):
        version.plan("1.05", ["1.06"])


def test_bump_changes_only_the_version(tmp_path: Path) -> None:
    manifest = tmp_path / "manifest.json"
    original = version.MANIFEST.read_text()
    manifest.write_text(original.replace(version.manifest_version(), "1.99"))
    assert version.bump(manifest) == ("1.99", "2.00")
    assert manifest.read_text() == original.replace(version.manifest_version(), "2.00")
