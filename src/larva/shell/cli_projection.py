"""Shared CLI projection helpers.

This module centralizes transport-neutral intermediate projection derived from
``ValidationReport`` so CLI text and JSON adapters can stay aligned without
changing adapter-local wording.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, TypedDict, cast

from returns.result import Result, Success

if TYPE_CHECKING:
    from larva.core.validate import ValidationReport


class ValidationReportProjection(TypedDict):
    """Shared validation facts reused by CLI projections."""

    report: ValidationReport
    primary_message: str | None
    warnings: list[str]


def project_validation_report(
    report: ValidationReport,
) -> Result[ValidationReportProjection, object]:
    """Project reusable validation facts without choosing an envelope."""

    errors = cast("list[dict[str, object]]", report.get("errors", []))
    primary_message: str | None = None
    if errors:
        candidate = errors[0].get("message", "validation failed")
        primary_message = candidate if isinstance(candidate, str) else str(candidate)
    return Success(
        {
            "report": report,
            "primary_message": primary_message,
            "warnings": cast("list[str]", report.get("warnings", [])),
        }
    )


def render_validation_report_text(report: ValidationReport) -> Result[str, object]:
    """Render the current CLI text projection for validation results."""

    projection = project_validation_report(report).unwrap()
    if report["valid"]:
        if not projection["warnings"]:
            return Success("valid\n")
        return Success(
            "valid\n"
            + "\n".join(f"warning: {warning}" for warning in projection["warnings"])
            + "\n"
        )
    if projection["primary_message"] is None:
        return Success("invalid\n")
    return Success(f"invalid: {projection['primary_message']}\n")


__all__ = [
    "ValidationReportProjection",
    "project_validation_report",
    "render_validation_report_text",
]
