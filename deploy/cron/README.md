# Scheduling `postiz-agent dispatch`

`dispatch` is the autonomous entry point: it picks the oldest AudioKids story that
has not yet been fully published to all target platforms in the last 30 days, then
drives the pipeline end-to-end. It exits 0 with `{"dispatched": false, "reason":
"nothing pending"}` when there is nothing to do, so running it more often than your
content cadence is safe.

## Linux / macOS (crontab)

See `crontab.example`. Short version:

```bash
crontab -e
# paste and adjust the path:
0 8 * * * cd /path/to/postiz-agent && /usr/local/bin/pnpm dev dispatch --platforms x,tiktok,instagram,youtube --json >> data/cron.log 2>&1
```

## macOS (launchd — preferred, survives reboots)

```bash
cp deploy/cron/com.djinnfoundry.postiz-agent.plist ~/Library/LaunchAgents/
# edit the plist: replace /path/to/postiz-agent with your absolute path
launchctl load ~/Library/LaunchAgents/com.djinnfoundry.postiz-agent.plist

# verify
launchctl list | grep postiz-agent
tail -f /path/to/postiz-agent/data/cron.log
```

## Linux (systemd timer — preferred for servers)

Save `/etc/systemd/system/postiz-agent.service`:

```ini
[Unit]
Description=postiz-agent daily dispatch
Wants=postiz-agent.timer

[Service]
Type=oneshot
User=audiokids
WorkingDirectory=/opt/postiz-agent
ExecStart=/usr/local/bin/pnpm dev dispatch --platforms x,tiktok,instagram,youtube --json
StandardOutput=append:/opt/postiz-agent/data/cron.log
StandardError=inherit
Environment="PATH=/usr/local/bin:/usr/bin:/bin"
```

Save `/etc/systemd/system/postiz-agent.timer`:

```ini
[Unit]
Description=Daily postiz-agent dispatch

[Timer]
OnCalendar=*-*-* 08:00:00
Persistent=true

[Install]
WantedBy=timers.target
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now postiz-agent.timer
sudo systemctl list-timers postiz-agent.timer
```

## Recommended companion

Set `ALERT_WEBHOOK_URL` in `.env`. When `dispatch` runs unattended and a platform
fails all retries, the agent fires a JSON payload to that URL so you hear about it
without tailing `data/cron.log`.

## Testing your cron entry without waiting a day

```bash
# One-shot: verify the exact invocation works
cd /path/to/postiz-agent
pnpm dev dispatch --platforms tiktok --dry-run --json

# Inspect the last N decisions the agent made
pnpm dev decisions | tail -20
```
