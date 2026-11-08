"""Deployment tests use mocks/temp directories: no cloud account or VM required."""
import hashlib
import importlib.util
import io
import json
import os
import subprocess
import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

import bcrypt
import yaml

ROOT = Path(__file__).resolve().parents[2]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


deploy = load("ark_deploy", ROOT / "deploy/vultr/deploy.py")
runtime = load("ark_runtime", ROOT / "deploy/vultr/configure-runtime.py")


class DeploymentTests(unittest.TestCase):
    def test_config_rejects_shell_and_url_injection(self):
        base = dict(name="ark", region="ewr", plan="vc2-2c-4gb", ssh_cidr="203.0.113.9/32", username="ark", domain="ark.example.com")
        for field, value in [("name", "x; id"), ("region", "x\nother"), ("domain", "https://ark.example.com/path"), ("username", "a b"), ("ssh_cidr", "0.0.0.0/0")]:
            with self.subTest(field=field), self.assertRaises(ValueError):
                deploy.validate_settings({**base, field: value})

    def test_runtime_contains_hash_not_plaintext_password(self):
        values = runtime.runtime_values(dict(host="ark.example.com", username="ark", password="a-long-test-password", proxy_token="a" * 64, release="test-release"))
        self.assertNotIn("a-long-test-password", json.dumps(values))
        self.assertTrue(bcrypt.checkpw(b"a-long-test-password", values["ARK_DASHBOARD_HASH"].encode()))
        self.assertEqual(values["ARK_PUBLIC_ORIGIN"], "https://ark.example.com")

    def test_terraform_bootstrap_checks_the_download_before_executing(self):
        with tempfile.TemporaryDirectory() as temp:
            with patch.object(deploy, "PRIVATE", Path(temp)), patch.object(deploy.shutil, "which", return_value=None), patch.object(deploy, "download", side_effect=[b"corrupt", b"0" * 64 + b"  terraform_1.17.1_darwin_arm64.zip"]), patch.object(deploy.platform, "system", return_value="Darwin"), patch.object(deploy.platform, "machine", return_value="arm64"), patch.dict(os.environ, {"ARK_TERRAFORM_BIN": ""}):
                with self.assertRaisesRegex(ValueError, "checksum"):
                    deploy.terraform_binary()
                self.assertFalse((Path(temp) / "tools/1.17.1/terraform").exists())

    def test_source_archive_excludes_secrets_state_and_symlinks(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            names = ["app.ts", ".env", "services/agent/.env", "key.pem", "terraform/state.tfstate", ".deploy/private.json", "x.tfvars.json"]
            for name in names:
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("private" if name != "app.ts" else "source")
            listed = subprocess.CompletedProcess([], 0, stdout='\0'.join(names) + '\0')
            with patch.object(deploy, "ROOT", root), patch.object(deploy, "run", return_value=listed):
                target = root / "archive.tar.gz"
                deploy.package_source(target)
                with tarfile.open(target) as archive:
                    self.assertEqual(archive.getnames(), ["app.ts"])
                (root / "link").symlink_to(root / ".env")
                listed.stdout = "link\0"
                with self.assertRaisesRegex(ValueError, "symlink"):
                    list(deploy.source_files())

    def test_check_never_applies_or_needs_a_vultr_key(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(deploy, "PRIVATE", Path(temp)), patch.object(deploy, "terraform_binary", return_value="terraform"), patch.object(deploy, "terraform") as tf, patch.object(deploy, "require_api_key") as key:
            deploy.main(["check"])
            key.assert_not_called()
            self.assertEqual([call.args[1] for call in tf.call_args_list], ["fmt", "init", "validate", "test"])

    def test_plan_does_not_apply_or_contact_ssh(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(deploy, "PRIVATE", Path(temp)), patch.object(deploy, "terraform_binary", return_value="terraform"), patch.object(deploy, "terraform") as tf, patch.object(deploy, "require_api_key"), patch.object(deploy, "settings_for", return_value={}), patch.object(deploy, "run"), patch.object(deploy.shutil, "which", return_value="/bin/tool"), patch.object(deploy, "wait_for_ssh") as ssh:
            deploy.main(["plan"])
            self.assertEqual([call.args[1] for call in tf.call_args_list], ["init", "validate", "plan"])
            ssh.assert_not_called()

    def test_declining_plan_does_not_create_the_server(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(deploy, "PRIVATE", Path(temp)), patch.object(deploy, "terraform_binary", return_value="terraform"), patch.object(deploy, "terraform") as tf, patch.object(deploy, "require_api_key"), patch.object(deploy, "settings_for", return_value={}), patch.object(deploy, "run"), patch.object(deploy.shutil, "which", return_value="/bin/tool"), patch("builtins.input", return_value="no"):
            deploy.main(["deploy"])
            self.assertNotIn("apply", [call.args[1] for call in tf.call_args_list])

    def test_tls_probe_never_puts_dashboard_password_in_process_arguments(self):
        reply = subprocess.CompletedProcess([], 0, stdout='{"status":"ok"}')
        with patch.object(deploy.shutil, "which", return_value="/usr/bin/curl"), patch.object(deploy.subprocess, "run", return_value=reply) as run:
            deploy.verify_https("ark.example.com", "ark", "private-dashboard-password")
            args = run.call_args.args[0]
            self.assertNotIn("private-dashboard-password", ' '.join(args))
            self.assertNotIn("--insecure", args)
            self.assertIn("Authorization: Basic", run.call_args.kwargs["input"])

    def test_compose_does_not_publish_backend_and_persists_state(self):
        compose = yaml.safe_load((ROOT / "deploy/vultr/compose.yaml").read_text())
        agent = compose["services"]["agent"]
        self.assertNotIn("ports", agent)
        self.assertTrue(agent["read_only"])
        self.assertIn("/opt/ark/shared/agent:/app/services/agent/data", agent["volumes"])
        self.assertEqual(compose["services"]["gateway"]["ports"], ['80:80', '443:443'])
        cloud = yaml.safe_load((ROOT / "terraform/vultr/cloud-init.yaml").read_text())
        self.assertFalse(cloud["ssh_pwauth"])
        self.assertIn("python3-bcrypt", cloud["packages"])

    def test_remote_release_rolls_back_on_health_failure(self):
        self.check_release(fail=True)

    def test_remote_release_promotes_only_after_health_success(self):
        self.check_release(fail=False)

    def check_release(self, fail):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            new = root / "releases/new"
            old = root / "releases/old"
            shared = root / "shared"
            for directory in (new / "deploy/vultr", old / "deploy/vultr", shared, root / "bin"):
                directory.mkdir(parents=True, exist_ok=True)
            helper = new / "deploy/vultr/release.sh"
            helper.write_text((ROOT / "deploy/vultr/release.sh").read_text())
            (new / "runtime.env").write_text("new runtime")
            (shared / "runtime.env").write_text("old runtime")
            (root / "current").symlink_to(old)
            docker = root / "bin/docker"
            docker.write_text('#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$MOCK_LOG"\nif [[ "$MOCK_FAIL" == 1 && "$*" == *"releases/new"* && "$*" == *" up "* ]]; then exit 1; fi\n')
            docker.chmod(0o700)
            log = root / "docker.log"
            env = {**os.environ, "PATH": f"{root / 'bin'}:{os.environ['PATH']}", "ARK_INSTALL_ROOT": str(root), "MOCK_LOG": str(log), "MOCK_FAIL": str(int(fail))}
            result = subprocess.run(["bash", str(helper)], env=env, text=True, capture_output=True)
            if fail:
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual((root / "current").resolve(), old)
                self.assertIn("--no-build", log.read_text())
                self.assertEqual((shared / "runtime.env").read_text(), "old runtime")
            else:
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual((root / "current").resolve(), new)
                self.assertEqual((shared / "runtime.env").read_text(), "new runtime")


if __name__ == "__main__":
    unittest.main()
