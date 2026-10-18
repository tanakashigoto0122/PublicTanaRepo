# CLAUDE.md

Guidance for Claude Code and other AI assistants working in this repository.

## Repository

| | |
|---|---|
| Remote | `https://github.com/tanakashigoto0122/PublicTanaRepo` |
| Visibility | Public |

Because the repo is public, treat everything committed here as world-readable.
Never commit secrets, API keys (Tripo keys start with `tsk_`), tokens, or personal data.

## Project overview

`tripo-export`: a Python CLI that bulk-downloads every 3D model generated through the
**Tripo API** and can also generate new models (text/image to 3D). The user-facing
README is in Japanese.

Key constraints of the Tripo API that shape the design:

- The API only sees tasks created through the API, not models made in Tripo Studio (the web app).
- API credits are separate from Studio credits.
- Result URLs are signed and expire about 5 minutes after they are issued.
- The v2 API (`api.tripo3d.ai/v2/openapi`) shuts down on 2026-10-31. Use only the v3 API,
  through the official `tripo3d>=1.0` SDK.

## Architecture

- `src/tripo_export/exporter.py`: all the logic. It takes any object with the
  `tripo3d.TripoClient` async methods, so tests pass a fake.
  - `list_history` pages through `GET /v3/account/usage` to find every task ID.
  - `export_all` queries tasks with `POST /v3/tasks/list` in batches of 20
    (`QUERY_BATCH_SIZE`) and downloads each batch before querying the next, so URLs
    don't expire.
  - Formats other than GLB go through `convert_model`, which costs credits.
  - `Manifest` (`manifest.json` in the output directory, keyed `<task_id>:<FORMAT>`)
    makes re-runs resumable. Downloads go to `*.part` first and are renamed when complete.
- `src/tripo_export/cli.py`: argparse front end (`balance`, `history`, `export`, `create text|image`).
  Commands that spend credits ask for confirmation unless `-y` is passed.

## Setup

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -e .
export TRIPO_API_KEY=tsk_...
```

## Common commands

```bash
PYTHONPATH=src python3 -m unittest discover -s tests -v   # tests; no deps, no network
tripo-export --help
```

There is no linter or formatter configured.

## Testing

Tests live in `tests/` and use stdlib `unittest` with a `FakeClient`. pytest is not a
dependency. The Tripo API hosts were not reachable from the cloud environment where this
was written, so the code has not been run against the live API. Verify against
the SDK source (`VAST-AI-Research/tripo-python-sdk`) when touching API calls.

## Branching and commits

Push with upstream tracking (`git push -u origin <branch>`), and never force-push a
branch you did not create. Write commit messages in the imperative mood.

## Working guidelines

- **Verify, don't assume.** Run the commands before documenting them, and report results faithfully.
- **Match surrounding style.**
- **Check dependencies before adding imports.** The only runtime dependency is `tripo3d`.
- **Keep scope tight.**

Update this file in the same commit as any change to commands, layout or conventions.
