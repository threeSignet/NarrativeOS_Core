# Install Check

Goal
dry-run install verification

Allowed Scope
- AGENTS.md

Forbidden Actions
- Do not edit project files.
- Do not invoke nested delegate runs.

Acceptance Criteria
- Dry-run artifacts are written under the current project.

Verification
- verify_delegate_run for the emitted RunId
- verify_delegate_workflow for install-check

Report Requirements
- Status / Role / Summary / Changed Files / Verification / Findings / Final Result / Risks Or Follow-ups
