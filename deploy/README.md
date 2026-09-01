# Running several of these on one VPS

Two different things live under `deploy/`, and the distinction matters:

- **This file** is the **per-project** contract — the settings and conventions
  that differ in every clone and are genuinely part of this project.
- **`deploy/host/`** is **shared host infrastructure**: Caddy, backups,
  monitoring. There is one of it per VPS regardless of how many projects run
  there, so it should live in its own repo rather than being duplicated into
  every clone. See [`deploy/host/README.md`](host/README.md) for the one-minute
  extraction — do it before you clone this boilerplate a second time.

Application deployment itself is unchanged and still lives in
`compose.prod.yml` and the root README.

Target shape, on a 4-core / 16 GB / 200 GB box:

```
                    internet
                       |  :80 :443
              +--------v---------+
              |   Caddy (edge)   |   one container, all TLS
              +--------+---------+
                       |  docker network "edge"
        +--------------+--------------+
        |                             |
  proj1-api:3000                proj2-api:3000
        |                             |
  proj1_default                 proj2_default     private, per project
        |                             |
    postgres                      postgres        never on "edge"
```

Every project keeps its own Postgres. On 16 GB that costs roughly 150 MB per
project under real load and buys the thing that actually matters: one project's
runaway query, bloated table or botched restore cannot touch another's. The
databases are on per-project private networks, so `proj2` cannot reach `proj1`'s
Postgres even by accident.

**No application port is published on the host at all** — not even on loopback.
Caddy reaches each api over the shared `edge` network by its alias. That is why
there is no port to allocate per project and nothing for a misconfigured
firewall to leak.

## One-time host setup

```bash
# 1. The shared network. Created by hand so no single project owns it.
docker network create edge

# 2. The edge proxy.
sudo mkdir -p /srv/edge
sudo cp -r deploy/host/caddy/. /srv/edge/
sudo $EDITOR /srv/edge/Caddyfile        # set `email`, add your site blocks
cd /srv/edge && docker compose up -d

# 3. Backups.
sudo mkdir -p /srv/edge/backup /var/backups/postgres
sudo cp deploy/host/backup/pg-backup.sh deploy/host/backup/pg-restore.sh /srv/edge/backup/
sudo chmod +x /srv/edge/backup/*.sh
sudo cp deploy/host/backup/pg-backup.env.example /etc/pg-backup.env
sudo chmod 600 /etc/pg-backup.env
sudo $EDITOR /etc/pg-backup.env

# rclone, for the offsite copy
sudo apt install rclone
rclone config                            # create the remote named in the config
sudo rclone config file                  # note the path; root's cron needs root's config

# 4. Schedules.
sudo crontab -e                          # paste deploy/host/backup/crontab.example

# 5. Prove the backup works BEFORE you need it.
sudo /srv/edge/backup/pg-backup.sh
sudo /srv/edge/backup/pg-restore.sh proj1
```

Then follow [`deploy/host/monitoring/README.md`](host/monitoring/README.md) — an uptime check per project and a
dead-man's switch on the backup. That step is the difference between "I have
backups" and "I know my backups are running".

## Adding a project

```bash
git clone <this-repo> /srv/proj2 && cd /srv/proj2
cp .env.example .env.production && $EDITOR .env.production
```

The settings that must be right for a shared box:

| Setting              | Value                           | Why                                                                                                                                                                                                                                                                                   |
| -------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PROJECT_SLUG`       | `proj2`                         | Namespaces the Compose project, the image tag, the volumes and the network alias. Two projects sharing it are treated as **one stack**: `up -d` on the second adopts the first's containers and its `pgdata` volume. The `:?` guard in `compose.prod.yml` makes that a startup error. |
| `TRUST_PROXY`        | `1`                             | Exactly one proxy hop (Caddy). Without it every request appears to come from Caddy's container IP — one rate-limit bucket for the whole internet, in front of sign-in and password reset. The app refuses to boot in production without it.                                           |
| `BETTER_AUTH_URL`    | `https://api.proj2.example.com` | The public origin. Google builds its redirect URI from it, so it must match the Cloud Console entry exactly.                                                                                                                                                                          |
| `CORS_ORIGINS`       | your frontend origins           | `*` is refused in production — CORS runs with `credentials: true`.                                                                                                                                                                                                                    |
| `PG_POOL_MAX`        | `10`                            | 20 is more idle backends than a 10k-user app will ever use. Not a capacity concern on this box, just tidiness.                                                                                                                                                                        |
| `PG_PASSWORD`        | distinct per project            | Separate databases with a shared password are one leak away from being one database.                                                                                                                                                                                                  |
| `BETTER_AUTH_SECRET` | `npm run auth:secret`           | Distinct per project, or a session minted for one is valid on the other.                                                                                                                                                                                                              |

Then:

```bash
# DNS: A record for api.proj2.example.com -> this box, and let it propagate
#      BEFORE the first request, or Caddy burns an ACME attempt on a name
#      that does not resolve yet.

docker compose --env-file .env.production -f compose.prod.yml up -d --build

# Add the site block and reload the proxy — no restart, no downtime for others.
sudo $EDITOR /srv/edge/Caddyfile
cd /srv/edge && docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile
```

Backups pick the new project up on their next run with no edit here: the
postgres service carries `backup.enable=true` and `backup.project=${PROJECT_SLUG}`
labels, and `pg-backup.sh` discovers containers by label. The one per-project
line you do have to add by hand is the weekly prune in the crontab.

## Log rotation for the cron logs

Docker's own logs are capped by the `json-file` options in each compose file.
The two cron logs are plain files and are not:

```
# /etc/logrotate.d/vps-cron
/var/log/pg-backup.log /var/log/pg-prune.log {
    weekly
    rotate 8
    compress
    missingok
    notifempty
}
```

## Deploys are not zero-downtime, and that is fine

`docker compose up -d --build` stops the old api container before the new one
is healthy, so there is a gap of a few seconds. The readiness drain in
`src/server.ts` is written for a load balancer with somewhere else to send
traffic, and with one container there isn't one — what the drain still buys you
is that in-flight requests finish instead of being reset.

For side projects at this scale, a few seconds on deploy is the right trade
against the complexity of blue/green. If it ever stops being the right trade,
the change is: run two api replicas with distinct aliases, put both in the
Caddy upstream, and turn on `health_uri /health/ready` (see the note at the
bottom of the Caddyfile for why it is off today). At that point the in-memory
rate limiter also needs to move to Redis — see the root README.
