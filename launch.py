"""
launch.py — start the FastAPI backend + Next.js frontend together.

Usage:
    python launch.py            # dev mode (Next.js dev + uvicorn --reload)
    python launch.py --prod     # production (next start + uvicorn)

Browser opens automatically to http://localhost:3000 once both are up.
"""
import argparse
import os
import sys
import time
import signal
import shutil
import subprocess
import threading
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WEB  = ROOT / "web"


def ensure_node_modules():
    if (WEB / "node_modules").exists():
        return
    print("[launch] First run — installing Next.js deps. This takes ~2 min.")
    npm = shutil.which("npm")
    if not npm:
        print("[launch] ERROR: npm not found on PATH. Install Node.js first.")
        sys.exit(2)
    rc = subprocess.call([npm, "install"], cwd=str(WEB))
    if rc != 0:
        print(f"[launch] npm install failed (exit {rc})")
        sys.exit(rc)


def stream_prefixed(proc, prefix):
    """Stream stdout/stderr of a subprocess with a colored prefix."""
    for raw in iter(proc.stdout.readline, b""):
        try:
            line = raw.decode("utf-8", errors="replace").rstrip()
        except Exception:
            line = str(raw)
        print(f"{prefix} {line}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prod", action="store_true", help="Run Next.js in production mode")
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()

    ensure_node_modules()

    # Backend: FastAPI on :8000
    uvicorn_args = [
        sys.executable, "-m", "uvicorn", "backend.server:app",
        "--host", "127.0.0.1", "--port", "8000",
    ]
    if not args.prod:
        uvicorn_args.append("--reload")
    print(f"[launch] backend: {' '.join(uvicorn_args)}")
    backend = subprocess.Popen(
        uvicorn_args, cwd=str(ROOT),
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )

    # Frontend: Next.js on :3000
    npm = shutil.which("npm")
    front_cmd = [npm, "run", "build"] if args.prod else None
    if args.prod:
        print("[launch] building production bundle…")
        rc = subprocess.call(front_cmd, cwd=str(WEB))
        if rc != 0:
            backend.terminate()
            sys.exit(rc)
        front_args = [npm, "run", "start"]
    else:
        front_args = [npm, "run", "dev"]
    print(f"[launch] frontend: {' '.join(front_args)}")
    frontend = subprocess.Popen(
        front_args, cwd=str(WEB),
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        shell=(os.name == "nt"),  # Windows needs shell for npm.cmd resolution
    )

    threading.Thread(target=stream_prefixed, args=(backend,  "[api ]"), daemon=True).start()
    threading.Thread(target=stream_prefixed, args=(frontend, "[web ]"), daemon=True).start()

    # Open browser after frontend has had a chance to start.
    if not args.no_browser:
        def _open():
            time.sleep(4)
            webbrowser.open("http://localhost:3000")
        threading.Thread(target=_open, daemon=True).start()

    def shutdown(*_):
        print("\n[launch] shutting down…")
        for p in (frontend, backend):
            try: p.terminate()
            except Exception: pass
        for p in (frontend, backend):
            try: p.wait(timeout=5)
            except Exception:
                try: p.kill()
                except Exception: pass
        sys.exit(0)

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    try:
        while True:
            time.sleep(1)
            if backend.poll() is not None:
                print(f"[launch] backend exited (code {backend.returncode}); stopping frontend.")
                shutdown()
            if frontend.poll() is not None:
                print(f"[launch] frontend exited (code {frontend.returncode}); stopping backend.")
                shutdown()
    except KeyboardInterrupt:
        shutdown()


if __name__ == "__main__":
    main()
