# VSGit

WebStorm-style Git workflows for VS Code, built on the built-in Git extension's API.

## Features

- **Branches popup**: click the branch in the status bar. It shows Update Project…, Commit…, Push…, New Branch… and Checkout Tag or Revision…, followed by Recent, Local, Remote and Tags. The current branch is listed first in Recent and Local, followed by favorites. Each branch shows its incoming (↓) and outgoing (↑) commit counts. You can mark favorites with the star button, and Fetch from the title bar.
- **Per-branch actions**, as in WebStorm: Checkout, Checkout and Update, New Branch from…, Checkout and Rebase onto current, Compare with current (includes cherry-pick), Show Diff with Working Tree, Rebase current onto…, Merge … into current, Update (fast-forwards a branch without checking it out), Push…, Pull into current Using Rebase/Merge, Rename…, Delete (with Restore).
- **Hover shortcuts** on each branch in the popup: Update (without checkout), Compare with Current (commit list with **Show Files Diff** and cherry-pick), compare the open file with that branch, and **…** for all actions.
- **Compare a file with a branch or tag**: use the editor title icon, right-click → **Git** in the editor or Explorer, or the branch popup. The Git submenu also has Show History and Annotate with Git Blame.
- **Git menu**: the icon in the Source Control title bar. It contains Commit, Push, Update Project (Merge / Rebase / Reset), Pull with options, Fetch, Merge/Rebase with options, Abort/Continue for interrupted operations, Resolve Conflicts (opens the merge editor), Branches, New Branch, New Tag, Reset HEAD (Soft/Mixed/Hard/Keep), Show Git Log, Uncommitted Changes (Stash/Unstash/Rollback), Current File, Manage Remotes and Clone.

## Settings

| Setting | Default | Description |
|---|---|---|
| `vsgit.updateMethod` | `merge` | How Update integrates incoming changes (`merge` or `rebase`). |
| `vsgit.branches.showRecent` | `true` | Show recently checked-out branches. |
| `vsgit.branches.showTags` | `true` | Show tags in the Branches popup. |
| `vsgit.statusBar.enabled` | `true` | Show the branch status bar item. |

Incoming and outgoing counts compare each branch with its remote-tracking branch, so they are only as fresh as the last fetch. Enable `git.autofetch` to keep them current. To keep only VSGit's branch item in the status bar, right-click the status bar and uncheck **Source Control**.

## Requirements

VS Code 1.140+, the built-in Git extension enabled, Git 2.27+ and a trusted workspace.
