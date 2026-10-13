# Local execution notes

## Windows sandbox recovery

On 2026-10-13, sandboxed shell execution and node_repl failed before running commands with:
`helper_unknown_error: setup refresh had errors`.

The sandbox log at `C:/Users/kylel/.codex/.sandbox/sandbox.2026-10-13.log` reported that granting a write ACE to this repository failed while opening the ACL target for update. The user configuration already had `[windows] sandbox = "elevated"`.

For future sessions:
- Try normal sandboxed execution first; the environment may have been repaired.
- If the same setup failure recurs, retry the necessary shell command with `sandbox_permissions: "require_escalated"` and a specific justification, subject to the active approval policy. This succeeded for reading, editing, and frontend verification in this session.
- Use `login: false` for PowerShell to avoid unrelated profile warnings.
- Do not repeatedly switch to node_repl for this error; it failed through the same sandbox setup path.
- This note does not grant blanket permission or override approval policy. Keep commands within the user's requested task and honor any approval rejection.
- Do not change Windows ACLs, delete sandbox state, or disable sandboxing automatically. Read sandbox diagnostics when investigating recovery.
