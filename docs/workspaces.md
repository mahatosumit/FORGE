# Workspace Management in FORGE v1.1

A **Workspace** in FORGE represents the containment sandbox for an engineering project.

## Containment Guarantees

1. **Path Boundary Containment**:
   All filesystem reads, writes, and searches are confined to the workspace root. Any attempt to traverse upwards using `..` or follow symlinks escaping the workspace is blocked by the Authority Gate.
2. **Git Root Detection**:
   When opening a workspace, FORGE detects whether it is a Git repository, tracks active branch, modified/untracked files, and prepares Git diff inspection.
3. **Multi-Project Isolation**:
   Missions are tagged with their active workspace path and cannot mutate other registered workspaces.

## Managing Workspaces

### In Web UI:
- Click the **Workspace** pill in the top header or **Workspaces** in the sidebar.
- Switch between active workspaces with 1-click.
- Register new workspaces by providing project name and absolute directory path.

### In CLI:
```bash
# List workspaces
forge workspaces

# Add a workspace
forge workspace create "Web Backend" /home/developer/repos/backend

# Switch active workspace
forge workspace switch ws-xxxx

# Inspect workspace git state
forge workspace inspect
```
