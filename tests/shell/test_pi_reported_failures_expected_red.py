"""Expected-red reproductions for user-reported Pi integration failures.

This file intentionally captures the failing contracts without changing product
code.  The tests are narrow anchors for the two reported live failures:

* slash autocomplete must not hand Pi editor a non-string candidate value; and
* initial persona startup must not fail before the TUI is usable because tool
  enumeration used an unavailable/unsupported Pi tool-list surface.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Final


ROOT: Final = Path(__file__).resolve().parents[2]
EXTENSION: Final = ROOT / "contrib" / "pi-extension" / "larva.ts"


def _source() -> str:
    return EXTENSION.read_text(encoding="utf-8")


def test_slash_autocomplete_candidates_expose_string_value_for_pi_editor() -> None:
    """Expected red: Pi editor calls candidate.value.startsWith(...).

    The live crash is ``TypeError: value.startsWith is not a function`` from
    ``@earendil-works/pi-tui/dist/components/editor.js`` after typing ``/``.
    A safe command-completion contract must therefore expose suggestions whose
    ``value`` field is a string (or use Pi's documented equivalent), not a raw or
    structurally ambiguous completion shape.
    """

    source = _source()

    assert "complete?: (prefix: string) => Promise<string[]>" not in source
    assert re.search(r"value\s*:\s*persona\.id|value\s*:\s*id", source), (
        "slash autocomplete candidates must carry a string value field consumed "
        "by Pi editor matching"
    )


def test_initial_persona_startup_does_not_fail_closed_on_absent_tool_enumerator() -> None:
    """Expected red for the reported ``--persona vectl-planner`` startup crash.

    The live process exits while loading the extension with
    ``LARVA_TOOL_ENUMERATION_FAILED: Unable to enumerate Pi tools``.  Until the
    implementation uses Pi's actual tool enumeration surface or a safe baseline,
    this static fixture exposes the fail-closed path that prevents startup.
    """

    source = _source()
    enumerate_body = re.search(
        r"async function enumerateTools\(pi: PiApi\): Promise<string\[]> \{(?P<body>[\s\S]*?)\n\}",
        source,
    )
    assert enumerate_body is not None

    body = enumerate_body.group("body")
    assert "pi.getAllTools?.()" not in body
    assert "Pi tool enumeration did not return an array" not in body
    assert "LARVA_TOOL_ENUMERATION_FAILED" not in body
