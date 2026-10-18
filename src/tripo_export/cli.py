"""Command-line interface: ``tripo-export <command> ...``."""

import argparse
import asyncio
import os
import sys
from typing import List, Optional

from . import __version__
from .exporter import FORMATS, export_all, generate, list_history

DEFAULT_OUT_DIR = "tripo_models"
DEFAULT_MODEL_VERSION = "v3.1-20260211"


def _client(args: argparse.Namespace):
    try:
        from tripo3d import TripoClient
    except ImportError:
        sys.exit("The tripo3d package is missing. Install it with: pip install -e .")
    api_key = args.api_key or os.environ.get("TRIPO_API_KEY")
    if not api_key:
        sys.exit("Set your API key in the TRIPO_API_KEY environment variable (or pass --api-key).")
    return TripoClient(api_key=api_key, IS_GLOBAL=not args.china)


def _confirm_credits(args: argparse.Namespace, message: str) -> None:
    if args.yes:
        return
    if not sys.stdin.isatty():
        sys.exit(f"{message} Re-run with --yes to confirm.")
    if input(f"{message} Continue? [y/N] ").strip().lower() not in ("y", "yes"):
        sys.exit("Cancelled.")


def _read_ids(path: str) -> List[str]:
    with open(path, encoding="utf-8") as handle:
        # One task ID per line; anything after the first comma or whitespace is ignored,
        # so a CSV with the ID in the first column works too.
        ids = [line.replace(",", " ").split()[0] for line in handle if line.strip()]
    return [i for i in ids if not i.startswith("#") and i.lower() != "task_id"]


async def cmd_balance(args: argparse.Namespace) -> None:
    async with _client(args) as client:
        balance = await client.get_balance()
    print(f"Credits: {balance.balance:g} (frozen: {balance.frozen:g})")


async def cmd_history(args: argparse.Namespace) -> None:
    async with _client(args) as client:
        items = await list_history(client, limit=args.limit)
    for item in items:
        credits = "" if item.credits_consumed is None else f"{item.credits_consumed:g}"
        print(f"{item.created_at or '-':<26} {item.status or '-':<10} {item.type or '-':<24} {credits:>6}  {item.task_id}")
    print(f"{len(items)} tasks")


async def cmd_export(args: argparse.Namespace) -> None:
    task_ids = _read_ids(args.ids_file) if args.ids_file else (args.task_ids or None)
    if args.format != "GLB":
        _confirm_credits(args, f"Converting to {args.format} creates one conversion task per model and uses credits.")
    async with _client(args) as client:
        summary = await export_all(
            client, args.out, fmt=args.format, task_ids=task_ids,
            with_preview=args.preview, concurrency=args.concurrency,
        )
    print()
    print(f"Exported: {len(summary.exported)}  Skipped (already done): {len(summary.skipped)}  "
          f"No model: {len(summary.no_model)}  Failed: {len(summary.failed)}")
    for task_id, reason in summary.failed.items():
        print(f"  failed {task_id}: {reason}")
    print(f"Files are in {os.path.abspath(args.out)}")
    print(f"Browse them with: tripo-export view {args.out}")
    if summary.failed:
        sys.exit(1)


async def cmd_create(args: argparse.Namespace) -> None:
    _confirm_credits(args, "Generating a model uses credits.")
    options = {}
    if args.face_limit:
        options["face_limit"] = args.face_limit
    if args.no_texture:
        options["texture"] = False
        options["pbr"] = False
    if args.detailed:
        options["texture_quality"] = "detailed"
        options["geometry_quality"] = "detailed"
    async with _client(args) as client:
        file_name = await generate(
            client, args.out,
            prompt=args.prompt if args.source == "text" else None,
            image=args.image if args.source == "image" else None,
            model_version=args.model_version, fmt=args.format,
            with_preview=args.preview, options=options,
        )
    print(f"Saved {os.path.join(os.path.abspath(args.out), file_name)}")


async def cmd_view(args: argparse.Namespace) -> None:
    from .viewer import serve

    try:
        serve(args.directory, port=args.port, open_browser=not args.no_browser)
    except KeyboardInterrupt:
        print("\nViewer stopped.")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="tripo-export", description="Bulk export and generate Tripo AI 3D models.")
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--api-key", help="Tripo API key (default: TRIPO_API_KEY)")
    common.add_argument("--china", action="store_true", help="use the China endpoint (openapi.tripo3d.com)")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("balance", parents=[common], help="show remaining API credits").set_defaults(func=cmd_balance)

    p = sub.add_parser("history", parents=[common], help="list tasks in the account history")
    p.add_argument("--limit", type=int, help="show at most this many tasks")
    p.set_defaults(func=cmd_history)

    output = argparse.ArgumentParser(add_help=False)
    output.add_argument("-o", "--out", default=DEFAULT_OUT_DIR, help=f"output directory (default: {DEFAULT_OUT_DIR})")
    output.add_argument("-f", "--format", default="GLB", type=str.upper, choices=FORMATS,
                        help="file format; anything but GLB is converted via the API and uses credits")
    output.add_argument("--preview", action="store_true", help="also save the preview image")
    output.add_argument("-y", "--yes", action="store_true", help="do not ask before using credits")

    p = sub.add_parser("export", parents=[common, output], help="download every model in the account")
    p.add_argument("task_ids", nargs="*", help="export only these task IDs")
    p.add_argument("--ids-file", help="file with one task ID per line (or a CSV with IDs in the first column)")
    p.add_argument("--concurrency", type=int, default=4, help="parallel downloads (default: 4)")
    p.set_defaults(func=cmd_export)

    # Options live on the text/image subcommands only: argparse lets a subcommand's defaults
    # overwrite values parsed by its parent, so defining them on both would drop -o etc.
    p = sub.add_parser("create", help="generate a model and download it")
    src = p.add_subparsers(dest="source", required=True)
    gen = argparse.ArgumentParser(add_help=False)
    gen.add_argument("--model-version", default=DEFAULT_MODEL_VERSION,
                     help=f"Tripo model version (default: {DEFAULT_MODEL_VERSION})")
    gen.add_argument("--face-limit", type=int, help="maximum number of faces")
    gen.add_argument("--no-texture", action="store_true", help="geometry only, no texture")
    gen.add_argument("--detailed", action="store_true", help="detailed geometry and texture quality")
    t = src.add_parser("text", parents=[common, output, gen], help="from a text prompt")
    t.add_argument("prompt")
    i = src.add_parser("image", parents=[common, output, gen], help="from an image file or URL")
    i.add_argument("image")
    p.set_defaults(func=cmd_create)

    p = sub.add_parser("view", help="browse downloaded models in the web browser")
    p.add_argument("directory", nargs="?", default=DEFAULT_OUT_DIR,
                   help=f"folder with models (default: {DEFAULT_OUT_DIR})")
    p.add_argument("--port", type=int, default=8765, help="port on 127.0.0.1 (default: 8765, another if busy)")
    p.add_argument("--no-browser", action="store_true", help="do not open the browser automatically")
    p.set_defaults(func=cmd_view)
    return parser


def main(argv: Optional[List[str]] = None) -> None:
    args = build_parser().parse_args(argv)
    try:
        asyncio.run(args.func(args))
    except KeyboardInterrupt:
        sys.exit("\nInterrupted. Run the same command again to resume.")
    except Exception as exc:
        sys.exit(f"Error: {exc}")


if __name__ == "__main__":
    main()
