# ARK on Vultr

From the inner `ARK` project directory, run:

```bash
./scripts/deploy-vultr.sh
```

The launcher prompts for your Vultr API token without displaying or saving it, shows a Terraform plan and the current base VM price, and asks you to type `yes` before applying billable infrastructure changes. It then installs Docker on the VM, uploads this checkout, builds the app, starts it, and checks the authenticated public HTTPS endpoint. There is no need to install Node, Python dependencies, Docker, Caddy or the Vultr CLI locally. Python 3.10+, Git, OpenSSH (`ssh`, `scp`, `ssh-keygen`) and normal outbound HTTPS access are required. System `curl` is recommended, including for macOS's native certificate trust store.

Terraform is used directly through the official `vultr/vultr` provider **2.33.2**. If no Terraform is installed, the launcher downloads **1.17.1** from HashiCorp, verifies its SHA-256 manifest and keeps it in the ignored `.deploy/vultr/tools` folder. An existing Terraform must meet the configuration's version constraint (1.7+).

## First-time Vultr setup

1. Sign in to [Vultr](https://my.vultr.com/) and ensure the account has billing enabled and permission to create Cloud Compute VMs.
2. Open **Account → API**, enable API access, and create/copy an API token with the permissions needed to manage instances, firewall groups/rules and SSH keys, plus read OS/plan metadata.
3. Allowlist the public IP of the computer running Terraform in Vultr's API access controls. API requests come from your computer, not the new VM.
4. Run the command above and paste the token into its hidden prompt. For automation, export `VULTR_API_KEY` instead. The token is read from the process environment by the provider; never put it into `.tfvars`, cloud-init, a repository file or a shell command argument.

Defaults: one Ubuntu 24.04 x64 VM, region `ewr`, plan `vc2-2c-4gb`, label `ark-echo`. Four GB is recommended because the production frontend is built on the VM. The actual plan price and availability come from Vultr during planning. Backups and additional paid protection are not enabled; taxes, bandwidth overages and external AI API usage are separate. **This implementation has not provisioned a live VM or validated your account quota.**

The launcher creates a dedicated ed25519 SSH key under `.deploy/vultr/` and restricts port 22 to your detected public IPv4 `/32`. It registers only the public key with Terraform/Vultr. You may supply an existing key and a specific allowlist:

```bash
./scripts/deploy-vultr.sh --region ewr --plan vc2-2c-4gb \
  --ssh-key "$HOME/.ssh/id_ed25519" --ssh-cidr 203.0.113.10/32
```

An existing passphrase-protected key needs to be unlocked in `ssh-agent` before deploying. First SSH contact uses OpenSSH `accept-new`, recording the host key in the deployment's own `known_hosts`; changed host keys are rejected. The instance IP comes from Terraform. Verify the first host fingerprint through Vultr's console when your security requirements call for that.

## Domain and HTTPS

Without `--domain`, the launcher uses `<server-ip-with-hyphens>.sslip.io`. This supplies a public DNS hostname without purchasing a domain. Caddy obtains and renews a publicly trusted certificate automatically. Microphone access requires HTTPS, so a plain public IP over HTTP is not used.

For your own hostname:

```bash
./scripts/deploy-vultr.sh --domain ark.example.com
```

The VM IP is shown while SSH becomes ready. Point your domain's **A record** at it. The launcher checks DNS before deploying the app; if it does not match, set the record and rerun the same command. Remove conflicting AAAA records, since this deployment does not enable IPv6. If using Cloudflare, initially use DNS-only mode. Domain registration and custom-domain DNS records are not managed by Terraform in this configuration.

The automatic hostname depends on sslip.io DNS availability and public ACME issuance/rate limits. Use a domain you control for sustained production use. Both TCP ports 80 and 443 must remain reachable for certificate issuance/renewal. The launcher does not report success until the public certificate validates and the authenticated backend health check returns `ok`.

## Dashboard and API keys

The entire web UI and `/api/*` are protected by Caddy HTTP Basic authentication over HTTPS. Default username: **ark**. A strong random dashboard password is generated and saved locally at:

```text
.deploy/vultr/dashboard-password
```

Retrieve it locally, then enter it in your browser's sign-in prompt. It is not printed in deployment logs, passed on command lines, stored in Terraform or sent in cloud-init. Only its bcrypt hash is stored on the VM. You can choose a password for the first deployment by setting `ARK_DASHBOARD_PASSWORD` (16..72 bytes). Repeated deployments reuse the saved local password. `--username` changes the login name.

Once signed in, open **Mission AI**:

- **Agent Link**: select Gemini, Anthropic or Muse and paste that provider's key. The existing backend stores it in its private persistent data directory.
- **ElevenLabs connection**: paste the ElevenLabs key and optionally a voice ID. It stays in backend memory; reconnect ElevenLabs after a backend/container restart.
- Click **Enable Hi ARK**, allow the microphone, say “Hi ARK,” and talk to your linked LLM. Simulation action approvals still apply.

Application provider keys are never passed through Terraform. A private gateway-to-backend token is generated locally and sent over SSH stdin into a mode-600 runtime file. Caddy replaces the proxy header after authenticating the user. The backend checks that token, the public Host and the exact HTTPS Origin. Mutating API calls without the correct Origin are denied. CORS alone is not relied on for authentication.

This is a password-protected deployment for a trusted operator/team, sharing one backend's AI keys and approved capabilities. It is not an anonymous service or a multi-tenant product. Use a separate identity/account model and per-user quotas before offering unrelated users their own accounts. The backend deliberately runs **one worker** because voice configuration and pending capability approvals are in process memory.

## Files and runtime layout

```text
scripts/deploy-vultr.sh           One-command entry point
terraform/vultr/*.tf              VM, SSH key, firewall and outputs
terraform/vultr/cloud-init.yaml   Docker installation; no app secrets
terraform/vultr/tests/            Mocked Terraform tests; no cloud resources
deploy/vultr/deploy.py            Provision/upload/start/verify orchestration
deploy/vultr/Dockerfile           Frontend, agent and Caddy image targets
deploy/vultr/compose.yaml         Two containers, persistent data and health checks
deploy/vultr/Caddyfile            HTTPS, login, static files and streaming API proxy
deploy/vultr/configure-runtime.py Read secrets from SSH stdin; write private config
deploy/vultr/release.sh           Build, health check, promote or restore containers
```

Only ports **80/443** are public; SSH is allowlisted. Backend port 8000 and the gateway readiness probe are never published. Python runs as a non-root user with a read-only image filesystem and a writable private data mount. The static frontend calls same-origin `/api` rather than a user's `localhost:8000`. Voice capture and Rapier rendering/stepping remain in each user's browser; the VM runs the existing Mission Control backend, not server-side 3D rendering or RL training.

Remote layout:

```text
/opt/ark/releases/<release>/      Uploaded source + release-specific runtime.env
/opt/ark/current                  Last successfully started release
/opt/ark/shared/agent/            LLM .env, CSP planner/approved capability state
/opt/ark/shared/runtime.env       Last successful private gateway/runtime config
Docker volumes ark_caddy_*       Persistent HTTPS account/certificate data
```

`.deploy/vultr/` contains your local Terraform state, SSH private key, dashboard password and proxy token. Its directory is mode 700, generated files are private, and it is gitignored. **Back it up securely** so you can update/destroy the same VM from a future checkout. Terraform state can contain Vultr's generated root password even though SSH password login is disabled. Keep it private. Do not lose state and blindly redeploy: that can create another billable VM.

Uploads are assembled from Git's tracked/non-ignored source files, including new uncommitted deployment files. Actual `.env`, private keys, Terraform state, `.deploy`, node_modules and local virtualenvs are excluded from the source payload/build context. Uploaded source does not require GitHub credentials on the VM.

## Update, inspect and remove

Run the same deploy command to build a new release on the existing VM. The prior containers keep running during the build. If new containers fail their health checks, the helper attempts to restore the previous release's tagged images and runtime config. Old images/releases are retained for recovery; monitor disk use. No database/data rollback is performed. HTTPS/DNS verification runs after container promotion, so an external DNS/certificate failure needs diagnosis/retry rather than automatic data or infrastructure destruction.

```bash
./scripts/deploy-vultr.sh plan       # Show infra changes; do not create a VM
./scripts/deploy-vultr.sh status     # URL, instance ID, current base price, password-file location
./scripts/deploy-vultr.sh logs       # Recent backend/gateway container logs over SSH
./scripts/deploy-vultr.sh check      # Format/validate + mocked Terraform test; no API token
./scripts/deploy-vultr.sh destroy    # Terraform asks for confirmation; deletes VM and its disk/data
```

Flags/settings persist under `.deploy/vultr/settings.json`. If your public IP changes, update both Vultr API access and the SSH firewall with `--ssh-cidr NEW_IP/32`. `--yes` skips the apply/destroy confirmation for intentional automation. Infrastructure creation, boot, remote package/image downloads and the first certificate may take several minutes. If a step fails after the VM is created, it still exists and can incur charges; rerun to recover or use `destroy` after backing up data.

Troubleshooting:

- API 401/403: check the token, account permissions and API IP allowlist.
- Plan/region unavailable: choose another `--plan`/`--region`; review the replacement implications before applying.
- SSH timeout: inspect Vultr instance status, your IP/CIDR and the loaded SSH key. Host key changes are not bypassed automatically.
- Boot failure: use the Vultr console and inspect `/var/log/cloud-init-output.log` or `cloud-init status --long`.
- HTTPS failure: check A/AAAA records, DNS proxying and ports 80/443, then inspect gateway logs. Never bypass browser certificate warnings to enter keys.
- Browser API 401/403: use the exact HTTPS hostname, sign in, and ensure the generated proxy token/public origin match the running release.

## Verification and limits

Validation includes real Terraform configuration validation against the official provider, a mocked Terraform network plan, deployment helper tests (archive exclusions, checksums, billing confirmation, secret handling and release recovery), backend public-access tests, frontend regressions and a production build. Caddy/Compose syntax can be checked locally without creating a VM. Mock tests do not prove actual account capacity, cloud-init success or ACME issuance.

At implementation time, there was no local Docker daemon or Vultr token/domain to perform an actual image build/VM deployment. No live Vultr deployment, external microphone conversation or billable provisioning is claimed. The launcher performs real container/public-HTTPS checks when you run `deploy` with your credentials.

Run helper tests using temporary test dependencies (no project dependency changes):

```bash
uv run --no-project --with bcrypt --with pyyaml python -m unittest discover -s scripts/tests -p test_deploy_vultr.py -v
./scripts/test.sh backend
./scripts/test.sh web
```

References: [Vultr Terraform + cloud-init](https://docs.vultr.com/provision-a-vultr-cloud-server-with-terraform-and-cloud-init), [instance schema](https://docs.vultr.com/reference/terraform/resources/instance), [firewall rules](https://docs.vultr.com/reference/terraform/resources/firewall_rule), [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https), [Caddy authentication](https://caddyserver.com/docs/caddyfile/directives/basic_auth).
