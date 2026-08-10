# CLAUDE.md — HisaabWiseBackend

Repo-level guidance. The workspace-level `CLAUDE.md` one directory up (`hisaabwise/CLAUDE.md`)
holds the project rules, stack decisions, and non-negotiable invariants for this backend — it
still applies and takes precedence. This file covers only per-repo agent-skill configuration.

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues (`makinananya-cyber/HisaabWiseBackend`), driven by the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles use their default label strings (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` and one `docs/adr/` at the repo root. See `docs/agents/domain.md`.
