#!/usr/bin/env python3
"""Runs on the VM. Read secrets over SSH stdin; write only a private env file."""
import json
import os
import re
import sys
from pathlib import Path

import bcrypt


def runtime_values(data):
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}", data["host"]):
        raise ValueError("Invalid hostname")
    if not re.fullmatch(r"[a-zA-Z0-9_-]{1,32}", data["username"]):
        raise ValueError("Invalid dashboard username")
    if len(data["password"]) < 16 or len(data["password"].encode()) > 72:
        raise ValueError("Dashboard password must be 16..72 bytes")
    if not re.fullmatch(r"[a-f0-9]{64}", data["proxy_token"]):
        raise ValueError("Invalid proxy token")
    if not re.fullmatch(r"[a-zA-Z0-9-]+", data["release"]):
        raise ValueError("Invalid release")
    return {
        "ARK_PUBLIC_HOST": data["host"],
        "ARK_PUBLIC_ORIGIN": f'https://{data["host"]}',
        "ARK_DASHBOARD_USER": data["username"],
        "ARK_DASHBOARD_HASH": bcrypt.hashpw(data["password"].encode(), bcrypt.gensalt()).decode(),
        "ARK_PROXY_TOKEN": data["proxy_token"],
        "ARK_RELEASE": data["release"],
    }


def main():
    os.umask(0o077)
    values = runtime_values(json.load(sys.stdin))
    target = Path(__file__).resolve().parents[2] / "runtime.env"
    # Single quotes preserve bcrypt's dollar signs during Compose env loading.
    target.write_text("".join(f"{key}='{value}'\n" for key, value in values.items()))
    target.chmod(0o600)


if __name__ == "__main__":
    main()
