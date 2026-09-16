#!/usr/bin/env python3
"""Install a managed UI block, preserving unrelated config and keeping a backup."""
import datetime
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import tomllib

BEGIN = "# BEGIN herdr-btc-status"
END = "# END herdr-btc-status"


def configure_text(original, command):
    clean = re.sub(r"(?m)^" + re.escape(BEGIN) + r"\n.*?^" + re.escape(END) + r"\n?", "", original, flags=re.S)
    parsed = tomllib.loads(clean)
    if "tab_bar_right" in parsed.get("ui", {}):
        raise ValueError("Existing ui.tab_bar_right found: merge the README entries manually to preserve your status bar.")
    block = (f'{BEGIN}\ntab_bar_right = [\n'
             f'  {{ type = "command", command = {json.dumps(command)}, interval_seconds = 60, timeout_seconds = 10 }},\n'
             '  { type = "datetime", format = "%H:%M" },\n]\n')
    if "tab_bar_right_separator" not in parsed.get("ui", {}):
        block += 'tab_bar_right_separator = " "\n'
    block += END + "\n"
    match = re.search(r"(?m)^\s*\[ui\][ \t]*(?:#[^\n]*)?\n", clean)
    if match:
        result = clean[:match.end()] + block + clean[match.end():]
    elif "ui" in parsed:
        raise ValueError("Nonstandard ui table: merge the README entries manually.")
    else:
        result = clean.rstrip() + "\n\n[ui]\n" + block
    tomllib.loads(result)
    return result


if __name__ == "__main__":
    path = Path.home() / ".config/herdr/config.toml"
    command = shlex.join([sys.executable, str(Path(__file__).resolve().with_name("btc_status.py"))])
    original = path.read_text() if path.exists() else ""
    updated = configure_text(original, command)
    if updated != original:
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists():
            stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S-%f")
            shutil.copy2(path, path.with_name(f"config.toml.btc-backup-{stamp}"))
        temporary = path.with_suffix(".btc-tmp")
        temporary.write_text(updated)
        if path.exists():
            shutil.copymode(path, temporary)
        temporary.replace(path)
    subprocess.run([os.environ.get("HERDR_BIN_PATH", "herdr"), "server", "reload-config"], check=True)
    print(f"BTC price and local clock enabled: {path}")
