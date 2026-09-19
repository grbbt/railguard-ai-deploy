Docker deployment (Proxmox / Portainer)
Replaces the removed `deploy/oracle/` package. Same backend + frontend
containers, but:
No bundled Caddy — your existing reverse proxy handles TLS.
No `JUDGE_USER`/`JUDGE_PASSWORD_HASH` basic auth — if you still want a
gated judging workspace, configure basic auth on your existing edge proxy
instead (examples below).
Backend and frontend ports are published (`8000:8000`, `3000:3000`),
not just `expose`d, so a reverse proxy running on a different host on your
LAN can reach them by the Docker VM's IP.
Dropped the `check_deployment_models.py` / `model-reference.json`
pre-flight check from the old `start.sh` — those files no longer exist in
this repo. Startup now relies on the backend's own healthcheck instead.
Dropped the `data/ps3` bind mount for official Test examples — that
directory is gitignored (too large for git) and won't exist in a
Portainer git-clone. Predictions and exports still work without it
(per the main README). If you want it, fetch it onto the Docker VM
separately and add it as an extra volume in the Portainer stack.
Deploying via Portainer
In the stack you already created, update Compose path to:
```
deploy/docker/compose.yaml
```
and set `RAILGUARD_AI_ENABLED` / `OPENAI_API_KEY` / `RAILGUARD_AI_MODEL` in
the stack's environment variables (see `.env.example`).
Pointing your existing reverse proxy at it
Route `/api*` to the backend, everything else to the frontend — replace
`DOCKER_VM_IP` with the Docker VM's LAN address.
Caddy:
```caddy
railguard.yourdomain.com {
    @api path /api /api/*
    handle @api {
        reverse_proxy DOCKER_VM_IP:8000
    }
    handle {
        reverse_proxy DOCKER_VM_IP:3000
    }
    # Optional judging gate:
    # basic_auth {
    #     judge $2a$14$replace-with-a-bcrypt-hash
    # }
}
```
Nginx:
```nginx
server {
    server_name railguard.yourdomain.com;

    location /api/ {
        proxy_pass http://DOCKER_VM_IP:8000;
        proxy_set_header Host $host;
    }

    location / {
        proxy_pass http://DOCKER_VM_IP:3000;
        proxy_set_header Host $host;
    }

    # Optional judging gate:
    # auth_basic "Judging workspace";
    # auth_basic_user_file /etc/nginx/.htpasswd;
}
```
