#!/usr/bin/env python3
"""One-command Vultr provisioning + source deployment. Python stdlib only."""
from __future__ import annotations

import argparse
import base64
import getpass
import hashlib
import ipaddress
import json
import os
import platform
import re
import secrets
import shlex
import shutil
import socket
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TF_ROOT = ROOT / "terraform" / "vultr"
PRIVATE = ROOT / ".deploy" / "vultr"
TF_VERSION = "1.17.1"


def run(args, *, capture=False, input=None, check=True, cwd=ROOT):
    return subprocess.run([str(arg) for arg in args], cwd=cwd, input=input, text=True,
                          stdout=subprocess.PIPE if capture else None, check=check)


def download(url):
    # macOS framework Python may not have a CA bundle configured. System curl
    # uses the OS trust store; it still performs normal certificate validation.
    if shutil.which("curl"):
        return subprocess.run(["curl", "--fail", "--silent", "--show-error", "--location", "--max-time", "30", url],
                              check=True, stdout=subprocess.PIPE).stdout
    with urllib.request.urlopen(url, timeout=30) as response:
        return response.read()


def terraform_binary():
    supplied = os.getenv("ARK_TERRAFORM_BIN")
    if supplied or shutil.which("terraform"):
        return supplied or shutil.which("terraform")
    system = {"Darwin": "darwin", "Linux": "linux"}.get(platform.system())
    arch = {"arm64": "arm64", "aarch64": "arm64", "x86_64": "amd64", "AMD64": "amd64"}.get(platform.machine())
    if not system or not arch:
        raise ValueError("Install Terraform 1.7+ manually on this OS/architecture.")
    destination = PRIVATE / "tools" / TF_VERSION / "terraform"
    if destination.exists():
        return str(destination)
    name = f"terraform_{TF_VERSION}_{system}_{arch}.zip"
    base = f"https://releases.hashicorp.com/terraform/{TF_VERSION}"
    print(f"Downloading Terraform {TF_VERSION} from HashiCorp and verifying SHA-256…", flush=True)
    data = download(f"{base}/{name}")
    checksums = download(f"{base}/terraform_{TF_VERSION}_SHA256SUMS").decode()
    expected = next((line.split()[0] for line in checksums.splitlines() if line.split()[-1].lstrip('*') == name), None)
    if not expected or hashlib.sha256(data).hexdigest() != expected:
        raise ValueError("Terraform checksum verification failed.")
    destination.parent.mkdir(parents=True, exist_ok=True)
    import io
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        destination.write_bytes(archive.read("terraform"))
    destination.chmod(0o700)
    return str(destination)


def terraform(binary, *args, capture=False):
    return run([binary, f"-chdir={TF_ROOT}", *args], capture=capture)


def load_settings():
    path = PRIVATE / "settings.json"
    return json.loads(path.read_text()) if path.exists() else {}


def save_settings(settings):
    path = PRIVATE / "settings.json"
    path.write_text(json.dumps(settings, indent=2) + "\n")
    path.chmod(0o600)


def validate_settings(settings):
    if not re.fullmatch(r"[a-z][a-z0-9-]{0,40}", settings["name"]):
        raise ValueError("Deployment name must use lowercase letters, digits and hyphens.")
    for field in ("region", "plan"):
        if not re.fullmatch(r"[a-z0-9-]+", settings[field]):
            raise ValueError(f"Invalid {field}.")
    network = ipaddress.ip_network(settings["ssh_cidr"], strict=False)
    if network.version != 4 or network.prefixlen < 8:
        raise ValueError("SSH requires an IPv4 CIDR /8 or narrower, normally your IP/32.")
    settings["ssh_cidr"] = str(network)
    if not re.fullmatch(r"[a-zA-Z0-9_-]{1,32}", settings["username"]):
        raise ValueError("Invalid dashboard username.")
    if settings.get("domain"):
        host = settings["domain"].lower().rstrip('.')
        if len(host) > 253 or '.' not in host or not all(re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label) for label in host.split('.')):
            raise ValueError("Use a DNS hostname without https://, a port, or a path.")
        settings["domain"] = host
    return settings


def settings_for(args):
    settings = {"name": "ark-echo", "region": "ewr", "plan": "vc2-2c-4gb", "username": "ark", "domain": "", **load_settings()}
    for field in ("name", "region", "plan", "username", "domain", "ssh_cidr", "ssh_key"):
        value = getattr(args, field)
        if value is not None:
            settings[field] = value
    if "ssh_cidr" not in settings:
        public_ip = str(ipaddress.IPv4Address(download("https://api.ipify.org").decode().strip()))
        settings["ssh_cidr"] = f"{public_ip}/32"
    settings = validate_settings(settings)
    key = Path(settings.get("ssh_key", str(PRIVATE / "id_ed25519"))).expanduser().resolve()
    if not key.exists():
        if args.ssh_key:
            raise ValueError(f"SSH key does not exist: {key}")
        run(["ssh-keygen", "-t", "ed25519", "-N", "", "-C", "ark-vultr-deploy", "-f", key], capture=True)
    public = Path(str(key) + ".pub")
    if not public.exists():
        raise ValueError(f"Public SSH key missing: {public}")
    settings["ssh_key"] = str(key)
    save_settings(settings)
    inputs = {field: settings[field] for field in ("name", "region", "plan", "ssh_cidr")}
    inputs["ssh_public_key"] = public.read_text().strip()
    (PRIVATE / "inputs.tfvars.json").write_text(json.dumps(inputs, indent=2) + "\n")
    return settings


def require_api_key():
    if not os.getenv("VULTR_API_KEY"):
        if not sys.stdin.isatty():
            raise ValueError("Export VULTR_API_KEY first (or run interactively for a hidden prompt).")
        os.environ["VULTR_API_KEY"] = getpass.getpass("Vultr API token (hidden; not saved): ").strip()
    if not os.environ["VULTR_API_KEY"]:
        raise ValueError("VULTR_API_KEY is required. Enable it and allowlist your IP in Vultr Account → API.")


def outputs(binary):
    result = json.loads(terraform(binary, "output", "-json", capture=True).stdout)
    if "server_ip" not in result:
        raise ValueError("No deployment state found. Run deploy first in this checkout.")
    return {key: value["value"] for key, value in result.items()}


def ssh_options(settings):
    return ["-i", settings["ssh_key"], "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes",
            "-o", "StrictHostKeyChecking=accept-new", "-o", f"UserKnownHostsFile={PRIVATE / 'known_hosts'}", "-o", "ConnectTimeout=8"]


def ssh(settings, ip, command, **kwargs):
    ip = str(ipaddress.IPv4Address(ip))
    return run(["ssh", *ssh_options(settings), f"root@{ip}", command], **kwargs)


def wait_for_ssh(settings, ip):
    print(f"Waiting for SSH at {ip} (SSH is restricted to {settings['ssh_cidr']})…", flush=True)
    for _ in range(60):
        if ssh(settings, ip, "true", check=False, capture=True).returncode == 0:
            return
        time.sleep(5)
    raise ValueError("SSH did not become ready. Check instance status, the allowlisted CIDR, and ssh-agent for passphrase-protected keys.")


def source_files():
    names = run(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], capture=True).stdout.split('\0')
    for name in sorted(set(filter(None, names))):
        path = ROOT / name
        if name.startswith((".deploy/", "terraform/")) or path.name == ".env" or path.suffix in {".env", ".pem", ".key", ".tfstate", ".tfplan", ".tfvars"} or ".tfstate." in name or name.endswith(".tfvars.json"):
            continue
        if path.is_symlink():
            raise ValueError(f"Refusing to package a symlink: {name}")
        if path.is_file():
            yield path, name


def package_source(target):
    with tarfile.open(target, "w:gz") as archive:
        for path, name in source_files():
            archive.add(path, arcname=name, recursive=False)


def local_secret(name, create):
    path = PRIVATE / name
    if not path.exists():
        path.write_text(create())
        path.chmod(0o600)
    return path.read_text().strip()


def upload_and_start(settings, ip):
    host = settings.get("domain") or f"{ip.replace('.', '-')}.sslip.io"
    addresses = {item[4][0] for item in socket.getaddrinfo(host, 443, socket.AF_INET)}
    if ip not in addresses:
        raise ValueError(f"DNS for {host} must point to {ip}. Set its A record, remove conflicting AAAA/proxy records, then rerun deploy.")
    password = local_secret("dashboard-password", lambda: os.getenv("ARK_DASHBOARD_PASSWORD") or secrets.token_urlsafe(24))
    token = local_secret("proxy-token", lambda: secrets.token_hex(32))
    if len(password) < 16 or len(password.encode()) > 72:
        raise ValueError("ARK_DASHBOARD_PASSWORD must be 16..72 bytes.")
    release = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + secrets.token_hex(3)
    remote = f"/opt/ark/releases/{release}"
    with tempfile.TemporaryDirectory(prefix="upload-", dir=PRIVATE) as temp:
        archive = Path(temp) / "source.tar.gz"
        package_source(archive)
        ssh(settings, ip, f"install -d -m 0700 {shlex.quote(remote)}")
        run(["scp", *ssh_options(settings), archive, f"root@{ip}:{remote}/source.tar.gz"])
        ssh(settings, ip, f"tar -xzf {remote}/source.tar.gz -C {remote} --no-same-owner")
    payload = {"host": host, "username": settings["username"], "password": password, "proxy_token": token, "release": release}
    ssh(settings, ip, f"python3 {remote}/deploy/vultr/configure-runtime.py", input=json.dumps(payload))
    ssh(settings, ip, f"bash {remote}/deploy/vultr/release.sh")
    verify_https(host, settings["username"], password)
    print(f"\nARK is online: https://{host}\nDashboard user: {settings['username']}\nDashboard password: {PRIVATE / 'dashboard-password'}")
    print("Sign in, link your LLM and ElevenLabs in Mission AI, then enable the microphone.")


def verify_https(host, username, password):
    print("Waiting for the public HTTPS certificate and authenticated API…", flush=True)
    encoded = base64.b64encode(f"{username}:{password}".encode()).decode()
    for _ in range(60):
        try:
            if shutil.which("curl"):
                # Pass Basic credentials on stdin, never in process arguments.
                result = subprocess.run(["curl", "--fail", "--silent", "--show-error", "--max-time", "10", "--config", "-", f"https://{host}/api/health"],
                    input=f'header = "Authorization: Basic {encoded}"\n', text=True, capture_output=True, check=True)
                health = json.loads(result.stdout)
            else:
                request = urllib.request.Request(f"https://{host}/api/health", headers={"Authorization": f"Basic {encoded}"})
                with urllib.request.urlopen(request, timeout=10) as response:
                    health = json.load(response)
            if health.get("status") == "ok":
                return
        except (OSError, ValueError, subprocess.CalledProcessError):
            time.sleep(5)
    raise ValueError("Containers started, but public HTTPS verification failed. Check DNS, inbound ports 80/443 and Caddy logs with the logs command. The VM still incurs charges.")


def main(argv=None):
    parser = argparse.ArgumentParser(description="Deploy ARK to Vultr with Terraform, HTTPS and authenticated dashboard access.")
    parser.add_argument("command", nargs="?", default="deploy", choices=["deploy", "plan", "check", "status", "logs", "destroy"])
    for flag in ("name", "region", "plan", "domain", "username", "ssh-cidr", "ssh-key"):
        parser.add_argument(f"--{flag}")
    parser.add_argument("--yes", action="store_true", help="Skip Terraform's confirmation prompt (may create/delete billable resources).")
    args = parser.parse_args(argv)
    os.umask(0o077)
    PRIVATE.mkdir(parents=True, exist_ok=True)
    PRIVATE.chmod(0o700)
    binary = terraform_binary()
    if args.command == "check":
        terraform(binary, "fmt", "-check", "-recursive")
        terraform(binary, "init", "-backend=false", "-input=false")
        terraform(binary, "validate")
        terraform(binary, "test", "-no-color")
        return
    for program in ("git", "ssh", "scp", "ssh-keygen"):
        if not shutil.which(program):
            raise ValueError(f"Required local program missing: {program}")
    run(["git", "rev-parse", "--is-inside-work-tree"], capture=True)
    if args.command in {"status", "logs"}:
        settings = load_settings()
        state = outputs(binary)
        ip = str(ipaddress.IPv4Address(state["server_ip"]))
        host = settings.get("domain") or f"{ip.replace('.', '-')}.sslip.io"
        if args.command == "status":
            print(f"https://{host}\nInstance: {state['instance_id']}\nBase VM price: ${state['plan_monthly_usd']}/month\nPassword file: {PRIVATE / 'dashboard-password'}")
        else:
            ssh(settings, ip, "docker compose --env-file /opt/ark/shared/runtime.env -p ark -f /opt/ark/current/deploy/vultr/compose.yaml logs --tail 100")
        return
    require_api_key()
    settings = settings_for(args)
    terraform(binary, "init", "-input=false", f"-backend-config=path={PRIVATE / 'terraform.tfstate'}")
    terraform(binary, "validate")
    variables = f"-var-file={PRIVATE / 'inputs.tfvars.json'}"
    if args.command == "destroy":
        print("Destroy deletes the VM, including server-side saved LLM keys/data. Back up first.", flush=True)
        terraform(binary, "destroy", variables, *(["-auto-approve"] if args.yes else []))
        return
    plan = PRIVATE / "deployment.tfplan"
    terraform(binary, "plan", variables, f"-out={plan}")
    if args.command == "plan":
        print("Plan only. No billable resources were created.")
        return
    if not args.yes:
        reply = input("Apply this Vultr plan and start the billable VM? Type 'yes': ")
        if reply != "yes":
            print("Deployment cancelled before applying infrastructure.")
            return
    terraform(binary, "apply", "-input=false", str(plan))
    state = outputs(binary)
    ip = str(ipaddress.IPv4Address(state["server_ip"]))
    wait_for_ssh(settings, ip)
    ssh(settings, ip, "cloud-init status --wait")
    upload_and_start(settings, ip)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print(f"Deployment stopped: {error}", file=sys.stderr)
        sys.exit(1)
