# Oracle VM deployment

Follow [the deployment guide](../../docs/ORACLE_DEPLOYMENT.md) for account setup,
Ubuntu 24.04 prerequisites, DNS/networking, packaging, launch, checks and backups.

On the prepared VM, copy `.env.example` to `.env`, set a real hostname, username
and single-quoted bcrypt hash, then run from the extracted `railguard` directory:

```bash
bash deploy/oracle/start.sh
bash deploy/oracle/verify.sh
```

Docker Engine with the Compose plugin must already be installed. These commands
do not create Oracle resources or install host software. Only Caddy publishes
ports 80 and 443; it requires judge authentication for all application pages and
APIs. Runtime jobs/uploads and TLS certificates persist in named Docker volumes.

The optional `--include-test-data` package contains the four inference check
samples and built-in Test examples. Startup verifies their prediction parity
before launching when available; `verify.sh` requires them for its full check.
Without them, startup checks frozen model loading and supports uploaded data.

Take a consistent private runtime backup during an idle period:

```bash
bash deploy/oracle/backup.sh
```

This briefly stops the backend and saves an archive under `deploy/oracle/backups`.
Keep that archive, the VM `.env`, models and TLS state private. Updates use
`start.sh` again and retain named volumes. Never use `docker compose down -v` or
volume pruning for an update. Linux and ARM64 compatibility require verification
on the selected VM; local checks are not proof of a successful hosted deployment.
