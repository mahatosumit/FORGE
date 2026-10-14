# Git Integration in FORGE v1.1

FORGE includes native Git support designed for professional software engineering.

## Non-Destructive Principles

1. **Governed Git Mutations**:
   Git operations are governed capabilities. The model cannot run rogue `git push --force` or unapproved commits outside granted policies.
2. **Before / After Diff Inspection**:
   Every changed file, staged hunk, and untracked file is tracked in real-time.
3. **Clean-Tree Verification**:
   Strict verification levels can require that the workspace working tree is completely clean and all changes are accounted for in the mission receipt.

## Git Operations in UI and CLI

### In Web UI:
- Click **Git Status** in the sidebar.
- Inspect the active branch, modified files, and untracked files.
- View colored unified diffs with line-by-line additions and deletions.
- Commit working changes with a single click.

### In CLI:
```bash
# Check git branch and modified files
forge git status

# Inspect full unified diff
forge git diff

# Commit verified changes
forge git commit "feat: implemented user authentication middleware"
```
