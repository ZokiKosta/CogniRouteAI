#!/usr/bin/env python3
"""Стартер за CogniRouteAI – го пушта Node.js серверот без да памтиш npm команди.

Примери:
    python3 start.py              # дев режим: веб + апликација на http://localhost:5173
    python3 start.py --phone      # исто, но преку HTTPS за тестирање на телефон
    python3 start.py --prod       # build + продукциски сервер на http://localhost:3000
    python3 start.py --seed       # прво внеси демо возења, па стартувај
    python3 start.py --port 8080  # друга порта (важи за --prod)

Скриптата проверува дали има Node.js, инсталира зависности ако недостасуваат
(npm install) и за --prod прави build ако недостасува dist/. Запри со Ctrl+C.
"""
import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
MIN_NODE = (22, 13)


def fail(message):
    print(f"\n✖ {message}", file=sys.stderr)
    sys.exit(1)


def find(cmd):
    """Finds an executable, also checking common install paths on macOS/Linux."""
    found = shutil.which(cmd)
    if found:
        return found
    for base in ("/usr/local/bin", "/opt/homebrew/bin", str(Path.home() / ".nvm")):
        candidate = Path(base) / cmd
        if candidate.exists():
            return str(candidate)
    return None


def run(args, **kwargs):
    """Runs a command, streaming its output; returns the exit code."""
    return subprocess.run(args, cwd=ROOT, **kwargs).returncode


def check_node():
    node = find("node")
    npm = find("npm")
    if not node or not npm:
        fail(
            "Node.js не е пронајден. Инсталирај Node.js 22.13 или понов од https://nodejs.org\n"
            "  (на Mac со Homebrew: brew install node), па пробај повторно."
        )
    try:
        version = subprocess.check_output([node, "--version"], text=True).strip().lstrip("v")
        major, minor = (int(x) for x in version.split(".")[:2])
        if (major, minor) < MIN_NODE:
            fail(f"Node.js {version} е престар. Потребен е 22.13 или понов.")
        print(f"✓ Node.js {version}")
    except Exception:
        print("⚠ Не можев да ја проверам верзијата на Node.js, продолжувам…")
    return node, npm


def ensure_deps(npm):
    if not (ROOT / "node_modules").exists():
        print("→ Инсталирам зависности (npm install)…")
        if run([npm, "install"]) != 0:
            fail("npm install не успеа.")


def ensure_build(npm):
    if not (ROOT / "dist" / "mobile" / "index.html").exists():
        print("→ Правам build (npm run build)…")
        if run([npm, "run", "build"]) != 0:
            fail("npm run build не успеа.")


def main():
    parser = argparse.ArgumentParser(
        description="Стартер за CogniRouteAI серверот.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("--prod", action="store_true", help="build + продукциски сервер (порта 3000)")
    parser.add_argument("--phone", action="store_true", help="дев режим преку HTTPS за телефон")
    parser.add_argument("--seed", action="store_true", help="внеси демо возења пред стартување")
    parser.add_argument("--port", type=int, help="порта за продукцискиот сервер")
    args = parser.parse_args()

    node, npm = check_node()
    ensure_deps(npm)

    env = dict(os.environ)
    if args.port:
        env["PORT"] = str(args.port)

    if args.seed:
        print("→ Внесувам демо возења (npm run seed)…")
        run([npm, "run", "seed"], env=env)

    if args.prod:
        ensure_build(npm)
        port = args.port or 3000
        print(f"\n▶ Продукциски сервер: http://localhost:{port}")
        print(f"   веб-страна  →  http://localhost:{port}/")
        print(f"   апликација  →  http://localhost:{port}/app/\n")
        script = "start"
    else:
        script = "dev:phone" if args.phone else "dev"
        print("\n▶ Дев режим (Ctrl+C за крај):")
        print("   веб-страна  →  http" + ("s" if args.phone else "") + "://localhost:5173/")
        print("   апликација  →  http" + ("s" if args.phone else "") + "://localhost:5173/app/")
        if args.phone:
            print("   (за телефон: отвори ја мрежната адреса што ќе се појави подолу)")
        print()

    try:
        sys.exit(run([npm, "run", script], env=env))
    except KeyboardInterrupt:
        print("\n⏹ Серверот е запрен.")
        sys.exit(0)


if __name__ == "__main__":
    main()
