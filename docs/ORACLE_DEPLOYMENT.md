# Deploy RailGuard to Oracle Cloud

This guide uses one Ubuntu 24.04 LTS Oracle Ampere A1 server. Docker Compose runs the existing Next.js website, Python/FastAPI models and Caddy HTTPS gateway. A password protects both pages and APIs. This is one shared judging workspace: authorised visitors see the same saved runs. It is not a private account system.

**Status:** deployment files are prepared locally. No Oracle account, server, public URL or PostgreSQL database has been created by this work. Windows model checks are separate from the Linux/ARM and public-browser checks required below.

The current JSON job records and original inputs remain on a persistent Docker volume. PostgreSQL is not required for this first deployment. The laptop can be off once the hosted services are running.

## 1. Create the Oracle account yourself

Open [Oracle Cloud signup](https://signup.cloud.oracle.com/). Complete email, phone and payment verification directly with Oracle. Keep account credentials, payment details and SSH private keys out of chat and GitHub.

Choose your home region carefully, such as an available Singapore region if that is where you intend to host. Always Free compute and disk must be in your home region. Account verification and regional capacity are controlled by Oracle.

As checked on 19 September 2026, Oracle documents A1 allowances equivalent to **2 OCPUs and 12 GB RAM total**, plus **200 GB combined boot/block storage**. Use Always Free resources, not resources that are merely covered temporarily by trial credit. These are account-wide allowances, not per-server allowances. If capacity is unavailable, try another availability domain in that home region or retry later; a paid shape is not an automatic substitute. Oracle can reclaim idle free instances. [Current limits and availability](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm).

## 2. Create one Ubuntu server

In the Console, open **Compute → Instances → Create instance**.

| Setting | Value for this deployment |
| --- | --- |
| Name | `railguard-demo` |
| Image | Ubuntu 24.04 LTS, compatible with the selected ARM shape |
| Shape | `VM.Standard.A1.Flex`, Ampere |
| Compute | 2 OCPUs, 12 GB memory, assuming the allowance is otherwise unused |
| Boot disk | 50 GB initially; leave free-eligible performance settings unchanged |
| Network | VCN with internet connectivity and a public subnet |
| Public IPv4 | Assign an address |
| SSH keys | Generate a key pair and save the private key locally before creating |

The VCN wizard can create the network, internet gateway and routing. Wait for **Running**, then note the public IP. Save the SSH key outside the project. [Oracle instance creation](https://docs.oracle.com/en-us/iaas/Content/Compute/Tasks/launchinginstance.htm).

For this server's security list or network security group, allow inbound **TCP 22 from your own public IP/32**, and **TCP 80 and 443 from 0.0.0.0/0**. Preserve the SSH rule before changing access. Do not open 3000, 8000 or database ports. The compose file publishes only the HTTPS gateway's 80/443; do not add other published ports. Host firewall policy also needs to permit web traffic. Docker manages its own forwarding rules, so a UFW rule alone is not a substitute for the OCI ingress rules.

## 3. Connect from Windows PowerShell

Replace the example key path and `SERVER_IP` with your actual values:

```powershell
ssh -i "C:\path\to\oracle-private.key" ubuntu@SERVER_IP
```

For Ubuntu the username is `ubuntu`. If OpenSSH rejects the key's Windows permissions, follow [Oracle's key-permission instructions](https://docs.oracle.com/en-us/iaas/Content/Compute/Tasks/connect-to-linux-instance.htm). Verify the server identity when first connecting. Keep a working SSH session open while configuring network rules.

## 4. Give the server a DNS name

Use a domain you own, or create an available free subdomain at [DuckDNS](https://www.duckdns.org/). Point its IPv4/A record to the Oracle server's public IP. A name such as `YOUR-CHOSEN-NAME.duckdns.org` is an example, not a reserved or deployed address. Avoid setting an IPv6/AAAA record unless you also configure IPv6 correctly.

Verify the DNS record from your computer:

```powershell
Resolve-DnsName YOUR-CHOSEN-NAME.duckdns.org
```

Caddy obtains and renews a public HTTPS certificate when DNS resolves correctly and ports 80/443 are reachable. Its certificate data is persistent. [Caddy HTTPS requirements](https://caddyserver.com/docs/automatic-https).

## 5. Install Docker on the Ubuntu server

Run these in the SSH session on a fresh Ubuntu 24.04 server. This uses Docker's signed package repository. If Docker is already installed, check `sudo docker compose version` and follow the official upgrade guidance instead of replacing an existing installation.

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
sudo tee /etc/apt/sources.list.d/docker.sources > /dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: noble
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo docker compose version
```

Keep using `sudo docker`; adding your login to the Docker group grants root-equivalent access and is not needed here. [Official Ubuntu Docker installation](https://docs.docker.com/engine/install/ubuntu/).

## 6. Transfer the prepared release

The packager creates `output/deploy/railguard-oracle.tar.gz` and checksum/manifest files on your laptop. It includes the app, locked dependencies, four frozen models, their provenance and the approved documentation. With `--include-test-data`, it also includes all 86 official Test inputs. It excludes credentials, raw Train data, this laptop's saved jobs, uploads, caches and dependency installations. A cloud workspace starts empty; use **Run official examples** to create saved results there.

To create the first package, run from the project folder in **Windows PowerShell**:

```powershell
.\.venv\Scripts\python.exe scripts/package_oracle.py --include-test-data
```

The prepared package may already exist. The packager intentionally refuses to overwrite it. After an intentional source change, use a new name, for example `--output output/deploy/railguard-oracle-v2.tar.gz`, and use that name and its `.sha256` sidecar in the transfer/extraction commands below.

Transfer the archive and SHA-256 sidecar over SSH:

```powershell
scp -i "C:\path\to\oracle-private.key" .\output\deploy\railguard-oracle.tar.gz .\output\deploy\railguard-oracle.tar.gz.sha256 ubuntu@SERVER_IP:~/
```

In the **Ubuntu SSH session**, verify it and extract into a new directory:

```bash
cd ~
sha256sum -c railguard-oracle.tar.gz.sha256
mkdir railguard-release
tar -xzf railguard-oracle.tar.gz -C railguard-release
cd ~/railguard-release/railguard
```

The `mkdir` deliberately fails if that release directory already exists. Use a new release directory for updates; do not unpack over private configuration. Never upload the deployment archive as public GitHub source: it contains organiser Test files and executable trusted model artifacts. GitHub submission preparation is a separate source-only step.

## 7. Configure the domain and judge access

From the extracted project root on Ubuntu:

```bash
umask 077
cp deploy/oracle/.env.example deploy/oracle/.env
chmod 600 deploy/oracle/.env
sudo docker run --rm -it caddy:2-alpine caddy hash-password
```

The last command prompts for your chosen judge password without putting it in shell history. Copy the resulting bcrypt hash into the deployment environment file:

```bash
nano deploy/oracle/.env
```

Set `DOMAIN` to your actual hostname, `JUDGE_USER` to a simple username, and `JUDGE_PASSWORD_HASH` to the generated hash. Preserve the **single quotes** around the bcrypt hash so Compose does not interpret its dollar signs. The example file documents all supported settings. Do not paste a plain password in the hash field.

AI starts disabled. To enable it, put the intended key into `OPENAI_API_KEY` directly in this server file and set `RAILGUARD_AI_ENABLED=true`. Use the supported model shown in the example, or your configured supported model. This key is passed only to the Python backend, not the frontend build. API charges are separate from Oracle hosting. Shared password access and existing concurrency limits are not a daily spending cap; enable paid AI only for the intended judging audience and monitor provider usage. Predictions, graphs, exports and local summaries work without an AI key.

Do not print `docker compose config` or container environment inspection output into a public log: resolved configuration can contain credentials. The scripts validate quietly.

## 8. Build and start

```bash
sudo bash deploy/oracle/start.sh
```

This validates the configuration, builds Linux images from the dependency locks and checks the trusted model artifacts. When all four check samples are present, it also checks prediction parity before starting the services. The first build downloads dependencies and can take several minutes. It does not copy the Windows virtual environment or train on Test inputs. A failed dependency build must be resolved explicitly; do not silently change model-library versions to make installation pass.

The service containers restart after a reboot unless intentionally stopped. Model assets and official inputs are read-only; new jobs are written to the named runtime volume. One backend process retains the existing two inference threads. This design has not yet been benchmarked on the Oracle machine.

## 9. Verify before sharing with judges

```bash
sudo bash deploy/oracle/verify.sh
```

The verification checks services and runs one official Test recording for each model against a reference generated on the development machine. Door/ACV/Rail outputs must match; SHM permits small floating-point rounding differences. Model and input hashes are checked. These are **compatibility checks, not hidden-Test accuracy measurements**. The script also checks that unauthenticated pages and APIs return 401, then prompts for judge credentials to check authenticated access.

Open your HTTPS address in a fresh browser and complete this hosted acceptance check:

1. Enter the judge credentials; confirm the dashboard and Singapore map load.
2. Run official examples for Door, ACV, Rail and SHM; confirm results, measured charts and 3D views.
3. Upload representative files, switch Current file/All files, and compare results.
4. Test AI only if intentionally enabled; confirm its local fallback when disabled.
5. Export selected results; inspect the expected prediction filenames and schemas.
6. Restart the backend after jobs finish, reload, and confirm saved results remain.
7. Visit from another device/network with this laptop's local services unavailable.

Give judges the HTTPS URL and shared login through the submission channel. Anyone with that login can access the shared workspace. Do not claim private-user isolation.

## Backups, updates and rollback

Run `sudo bash deploy/oracle/backup.sh` after active analyses finish. It briefly stops the backend for a consistent runtime backup and then restarts it. Download the generated backup off the server; a backup left only on the same disk does not survive disk loss. Store the private environment file separately and securely. Keep the previous release archive and Docker images until an update passes verification.

For updates, extract to a new release directory, copy the server's private deployment `.env` into that release with mode 600, and run its start/verify scripts. The fixed Compose project/volume names preserve runtime data across release directories. Deploy during an idle period: interrupted jobs are marked failed and must be rerun; the executor is not a durable distributed queue.

To roll back an application change, return to the previous release directory and run its start script; no database migration is involved. Back up runtime data before updating. Never use `docker compose down -v`, remove Docker volumes, or prune volume storage to update the app.

## Common blockers

| Symptom | Next check |
| --- | --- |
| Oracle has no A1 capacity | Try another availability domain in the same home region or retry later. |
| SSH timeout | Correct public IP, subnet route/internet gateway, and TCP22 rule for your current IP. |
| HTTPS unavailable | DNS points to the server, no wrong AAAA record, TCP80/443 open, gateway logs. |
| Browser requests a password | Expected access gate; use the configured judge account. |
| API or webpage bypasses the password | Do not share the URL; check Caddy and remove direct service port exposure. |
| Model check fails on ARM | Preserve the failure log; check exact dependency versions and artifacts before changing anything. |
| Official examples missing | Repackage with `--include-test-data`; uploads alone do not install the example library. |
| AI gives a local response | Check intentional AI setting, server key and provider availability; do not expose the key in logs. |
| Disk nearly full | Back up and review retained uploads; do not delete model/runtime directories blindly. |

No cloud deployment, public DNS verification or Linux/ARM validation is implied by the presence of these files. Record those results after the actual server has been provisioned.
