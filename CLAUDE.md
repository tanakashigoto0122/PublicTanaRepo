# CLAUDE.md

Guidance for Claude Code and other AI assistants working in this repository.

## ⚠️ Current state: uninitialized

**This repository contains no source code yet.** As of the last update to this
file, the repo held zero commits and zero files — this document was the first
content added.

That means there is deliberately **no** description below of the architecture,
build system, test commands, or code conventions: none exist yet, and inventing
them would send future sessions down the wrong path.

**Before relying on anything in this file, verify the repo is still empty:**

```bash
git log --oneline -10     # any real commits yet?
ls -A                     # any source files?
```

If code has landed and the sections below are still placeholders, **updating
this file is part of the job** — see [Maintaining this file](#maintaining-this-file).

## Repository

| | |
|---|---|
| Remote | `https://github.com/tanakashigoto0122/PublicTanaRepo` |
| Visibility | Public |
| Default branch | Not yet established (no branches existed before this commit) |

Because the repo is public, treat everything committed here as world-readable.
Never commit secrets, API keys, tokens, or personal data.

## Branching and commits

Automated/AI work is done on descriptive prefixed branches rather than directly
on the default branch:

```
claude/<short-description>-<suffix>
```

Push with upstream tracking, and never force-push a branch you did not create:

```bash
git push -u origin <branch-name>
```

Write commit messages in the imperative mood with a short subject line, and a
body explaining *why* when the reason is not obvious from the diff.

## Sections to fill in once code exists

The following are placeholders. Each should be replaced with concrete,
**verified** content — commands actually run successfully, paths that actually
exist — not assumptions based on the tech stack's typical layout.

### Project overview
_What this project does, who it is for, and the problem it solves._

### Architecture
_The handful of things a newcomer cannot infer by reading a single file:
module boundaries, how data flows through the system, where the entry points
are, and any non-obvious design decisions with their rationale._

### Directory layout
_Top-level directories and what belongs in each._

### Setup
_Exact commands to get from a fresh clone to a working environment, including
runtime/language versions and how dependencies are installed._

### Common commands
_Verified commands for build, run, test (full suite and a single test), lint,
and format. Include the fastest inner-loop command for iterating on a change._

### Conventions
_Naming, formatting, error handling, logging, typing strictness, testing style,
and anything a linter does not already enforce._

### Testing
_Where tests live, how they are named, what must be covered before a change is
considered done, and how to run them._

### CI
_What runs on push and on pull requests, and how to reproduce a CI failure
locally._

## Working guidelines

- **Verify, don't assume.** Read the code and run the commands before
  documenting or describing behavior. Report results faithfully — if tests
  fail or a step was skipped, say so plainly.
- **Match surrounding style.** New code should read like the code already
  around it: same naming, same idioms, same comment density.
- **Check dependencies before adding imports.** Confirm a library is already a
  project dependency rather than assuming its availability.
- **Keep scope tight.** Do what was asked; flag adjacent problems you notice
  instead of silently expanding the change.

## Maintaining this file

Update this file when any of the following changes, in the same commit as the
change itself:

- The build, test, or lint commands
- The directory layout or module boundaries
- Project-wide conventions or tooling
- Setup and dependency requirements

Keep it accurate over comprehensive. A stale instruction is worse than a
missing one, because an assistant will follow it. Delete the
[uninitialized notice](#️-current-state-uninitialized) at the top as soon as
real code and real commands take its place.
