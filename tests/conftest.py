"""Shared fixtures."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

pytest_plugins = "pytest_homeassistant_custom_component"

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(enable_custom_integrations: None) -> None:
    """Allow Home Assistant to load the integration in every test."""


@pytest.fixture(scope="session")
def reference() -> dict[str, Any]:
    """Skyfield results written by scripts/validate_against_skyfield.py."""
    return json.loads((FIXTURES / "skyfield_reference.json").read_text())


@pytest.fixture(scope="session")
def omm_xml(reference: dict[str, Any]) -> bytes:
    """CelesTrak OMM XML used to build the reference."""
    return reference["elements_xml"].encode()
