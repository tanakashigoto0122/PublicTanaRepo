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
  The page can change the folder: drag & drop adds files (`PUT /__viewer/upload?name=`), and the
  detail panel renames (`POST /__viewer/rename`) and deletes (`POST /__viewer/delete`) a model.
  These need the per-server token (`ViewerServer.token`, written into the page in place of
  `__VIEWER_TOKEN__`) in `X-Viewer-Token` and a `127.0.0.1`/`localhost` Host header, so other web
  pages cannot change the folder. `PUT /__viewer/thumbnail?model=` saves the current view (WebP from
  `toBlob`) as `<stem>_preview.webp`, and `PUT /__viewer/screenshot?name=` saves a PNG to
  `screenshots/`. `POST /__viewer/meta` sets a model's favorite flag and memo, stored in
  `.tripo-viewer.json` in the folder and keyed by the model's main file (`key` in the index;
  `library` moves the keys on rename and drops them on delete). `GET /__viewer/stats?model=` reads
  triangle/vertex/material/texture counts from the glTF JSON (`library.glb_stats`; for a .glb only
  the header and JSON chunk are read). Each index entry also has `folder` for the folder filter
  and `tags` (stored in the same meta file, cleaned by `library.clean_tags`).
  `GET /__viewer/duplicates` groups model files with identical content (`library.find_duplicates`:
  only same-size files are hashed, hashes cached by path/size/mtime). `GET /__viewer/textures?model=`
  lists a model's images with their uses and pixel size (`library.image_size` reads PNG/JPEG/WebP
  headers), `GET /__viewer/texture?model=&index=` serves one, and `POST /__viewer/textures/export`
  writes them to `textures/<model>/`.
  `POST /__viewer/move` moves one model's files into a subfolder (`library.move_model`, which
  updates the manifest and meta). The page has a selection mode (the "選択" button or Ctrl+click)
  for favoriting, moving, deleting, and comparing two models side by side with synced cameras.
  A dropped or imported `.zip` is unpacked into its own folder (`library.extract_zip`, which
  checks every member stays inside before writing anything). Background, lighting, exposure, light direction and gloss of the 3D view are
  kept in localStorage. model-viewer cannot rotate its environment, so "light direction" turns the
  model (`orientation` yaw) and the camera (`theta`) by the same angle. Gloss scales each material's
  `roughnessFactor` and "metal" its `metallicFactor` (display only; files are not changed).
  A background can be an image stored in `.backgrounds/` (`PUT /__viewer/background`,
  `GET /__viewer/backgrounds`), used as both `skybox-image` and `environment-image`.
  "Dimension lines" are model-viewer hotspots on bounding-box edges plus an SVG overlay redrawn on
  `camera-change`. "Turntable video" records the shown shadow canvas (`canvas.show`; model-viewer
  keeps two) composited onto a 2D canvas via `MediaRecorder`, uploaded with `PUT /__viewer/video`.
  In model-viewer 4, `auto-rotate` turns the model (`turntableRotation`), not the camera. The page re-reads the index every 3 s and re-renders when it changed, unless a
  dialog is open, so files added in Explorer show up on their own.
- `src/tripo_export/library.py`: the file operations behind those endpoints and the app's
  "import from Downloads". Paths from the page go through `safe_path`. Renaming keeps the
  exporter's `<date>_` prefix and the `_preview` suffix and updates `manifest.json`. Deleting
  moves files to the Recycle Bin on Windows (`SHFileOperationW`) and to `<folder>/.trash` elsewhere.
  It also owns the file-type constants and the `<date>_<task_id>` pattern that `viewer.py` uses.
- `src/tripo_export/convert.py`: free GLB/glTF → STL/OBJ conversion with the standard library only
  (`POST /__viewer/convert`). `Gltf.accessor` reads any accessor (strides, normalized ints),
  `read_parts` walks the default scene applying node transforms. STL is binary, mm, Z-up, centred
  on X/Y and resting on Z = 0; OBJ goes to `<stem>_obj/` with an MTL and base color textures.
  Draco/meshopt-compressed files are refused. About 2.5 s for 500k triangles.
  "Lightweight" (`POST /__viewer/lite`): the page scales textures down on a canvas and sends them
  base64-encoded; `library.replace_images` rebuilds the BIN chunk into `<stem>_lite.glb`.
  Polygon reduction (`POST /__viewer/simplify`, `convert.simplify`) runs gltfpack `-si <ratio> -noq`
  into `<stem>_lite.glb`; texture shrinking can then rewrite that lite file in place
  (`replace_images(..., in_place=True)`, refused for anything not named `_lite`). gltfpack.exe is
  not committed: CI and `build.ps1` download meshoptimizer v1.3 (SHA-256 pinned) into `vendor/`, and
  `--self-test` fails without it. Locally, put it in `vendor/` or set `TRIPO_GLTFPACK`.
  "View on phone" (`POST /__viewer/share`, `/__viewer/share/stop`): `viewer.start_share` runs a
  second server on 0.0.0.0 that serves only one .glb, a small AR page and model-viewer under a
  random path, for 30 minutes or until the dialog closes; the page shows a QR from `qr.py` (own
  encoder: byte mode, level M, versions 1-6). Tests bind it to 127.0.0.1 (`host=`) so no firewall
  prompt appears.
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
dependency. `test_app.py` drives `AppApi` with the same fake client. `test_library.py` covers the file
operations and the token-protected endpoints; its real Recycle Bin test runs only with
`TRIPO_TEST_RECYCLE=1` on Windows, because it leaves a file in the Recycle Bin. The viewer page itself
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
