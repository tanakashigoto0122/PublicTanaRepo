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

`tripo-export`: a Python CLI and a Windows desktop app ("Tripo Model Manager") that
bulk-download every 3D model generated through the **Tripo API**, generate new models
(text/image to 3D), and browse a folder of models in a 3D gallery. The user-facing README
and UI text are in Japanese.

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
    don't expire. If a download still fails (e.g. the URL expired during a slow batch),
    `_download_output` re-fetches the task with `get_task` and retries once.
  - Formats other than GLB go through `convert_model`, which costs credits. Conversion
    tasks in the history (`is_conversion`) are left out of `export_all`, so they are never
    downloaded or converted again. The preview is saved before converting.
  - `Manifest` (`manifest.json` in the output directory, keyed `<task_id>:<FORMAT>`)
    makes re-runs resumable. Downloads go to `*.part` first and are renamed when complete.
- `src/tripo_export/viewer.py` + `viewer.html`: `tripo-export view`. It runs a stdlib
  `ThreadingHTTPServer` on 127.0.0.1 that serves the model folder, the single-page viewer at `/`,
  and a JSON index at `/__viewer/models.json`. `build_index` groups files by task, using
  `manifest.json` when present and otherwise the file stem, and includes stray model files
  in subfolders (e.g. manual Studio downloads). `@google/model-viewer` 4.3.1 is vendored in
  `src/tripo_export/vendor/` (Apache-2.0, license alongside it) and served at
  `/__viewer/model-viewer.min.js`, so the viewer works offline. Models without a
  `*_preview.*` image get a thumbnail rendered client-side by a hidden `<model-viewer>`,
  cached in localStorage. `viewer.html` and `vendor/*` ship as package data (see
  `pyproject.toml`). `ViewerServer.root` can be changed while the server runs (the app does this).
  Assets are cached in memory (`_asset`), so restart the server after editing `viewer.html`.
- `src/tripo_export/app.py`: the desktop app. A pywebview window (Edge WebView2 on Windows)
  shows the same viewer page with `?app=1`. The page detects `window.pywebview` and adds
  `body.app`, which reveals the toolbar, dialogs and job bar (`.app-only`). The page calls
  public methods of `AppApi`. Long jobs (`start_export`, `start_generate`) run on a worker
  thread, and the page polls `get_job`. Settings go in `%APPDATA%\TripoModelManager\settings.json`;
  the API key goes in the OS keychain via `keyring`. `--self-test <report>` and
  `--smoke-window <report>` are CI checks for the packaged exe.
- `src/tripo_export/cli.py`: argparse front end (`balance`, `history`, `export`, `create text|image`, `view`).
  Commands that spend credits ask for confirmation unless `-y` is passed.

## Windows app packaging

- Optional deps: `pip install -e ".[app]"` (pywebview, keyring). GUI entry point: `tripo-model-manager`.
- `packaging/windows/build.ps1` builds `dist\TripoModelManager.exe` locally with PyInstaller
  (`--onefile --windowed --collect-data tripo_export`).
- `.github/workflows/windows-app.yml` runs on push. It runs the unit tests on Windows,
  builds the exe, runs `--self-test` and `--smoke-window` against it, and uploads the
  `TripoModelManager-windows` artifact.

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

Tests live in `tests/` and use stdlib `unittest`. `test_exporter.py` uses a `FakeClient`;
`test_viewer.py` covers the index and starts a real server on port 0. pytest is not a
dependency. `test_app.py` drives `AppApi` with the same fake client. The viewer page itself
has no automated test. To check it by hand, run `tripo-export view <folder of .glb files>` and
open it in Playwright/Chromium. For the app UI, inject a mock `window.pywebview.api` with
`addInitScript` and load `/?app=1`. The real window can only be checked on Windows (CI smoke
test). The Tripo API hosts were not reachable from the cloud environment where this
was written, so the code has not been run against the live API. Verify against
the SDK source (`VAST-AI-Research/tripo-python-sdk`) when touching API calls.

## Branching and commits

Push with upstream tracking (`git push -u origin <branch>`), and never force-push a
branch you did not create. Write commit messages in the imperative mood.

## Working guidelines

- **Verify, don't assume.** Run the commands before documenting them, and report results faithfully.
- **Match surrounding style.**
- **Check dependencies before adding imports.** The CLI's only runtime dependency is `tripo3d`.
  The app adds `pywebview` and `keyring` (optional `app` extra), imported lazily.
- **Keep scope tight.**

Update this file in the same commit as any change to commands, layout or conventions.
