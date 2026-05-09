# Local Path Notice

This machine's project folders were organized on 2026-05-09.

- Canonical local workspace root: `~/Projects`.
- Some older paths under `~/Desktop`, `~/Documents`, and the home folder are preserved with symlinks.
- Do not delete, replace, or flatten those symlinks unless the user explicitly asks. They keep existing scripts and apps working.
- Prefer repository-relative paths in scripts and docs. Use `git rev-parse --show-toplevel` to find the repo root when needed.
- When a tool behaves differently through a symlink, compare `pwd` with `pwd -P` and use the physical path only for that local troubleshooting step.
- Avoid hardcoded absolute paths from old locations such as `~/Desktop/...` or `~/Documents/...`; keep new automation relative to the repo root.
- Local migration map: `~/Projects/PROJECTS_MIGRATION_2026-05-09.md`.
