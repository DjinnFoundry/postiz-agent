# Scheduling `postiz-agent dispatch`

`dispatch` is the autonomous entry point: it picks the oldest AudioKids story that
has not yet been fully published to all target platforms in the last 30 days, then
drives the pipeline end-to-end. It exits 0 with `{"dispatched": false, "reason":
"nothing pending"}` when there is nothing to do, retries only pending platforms. A story can become eligible again after 30 days;
remove it from the input directory if it must never be republished.

Use these examples only after `pnpm build`, tenant setup, and a verified real post.
Replace the Node executable, repository path, tenant `product`, and platform list.
Create `data/` first. Ensure the scheduler PATH includes ffmpeg, ffprobe, Whisper
and npx when rendering audio stories. Product bundles from other sources use
`publish --bundle-file`; this dispatcher scans AudioKids.

## Linux / macOS (crontab)

See `crontab.example`. Short version:

```bash
crontab -e
# paste and adjust the path:
0 8 * * * cd /path/to/postiz-agent && /usr/local/bin/node dist/cli.js dispatch --tenant product --platforms x,instagram --json >> data/cron.jsonl 2>> data/cron-errors.log
```

## macOS (launchd, preferred, survives reboots)

```bash
cp deploy/cron/com.djinnfoundry.postiz-agent.plist ~/Library/LaunchAgents/
# edit the plist: replace /path/to/postiz-agent with your absolute path
launchctl load ~/Library/LaunchAgents/com.djinnfoundry.postiz-agent.plist

# verify
launchctl list | grep postiz-agent
tail -f /path/to/postiz-agent/data/cron.jsonl
```

## Linux (systemd timer, preferred for servers)

Create or select the service user and grant it access to the repository, tenant configuration and data directories. Save `/etc/systemd/system/postiz-agent.service`:

```ini
[Unit]
Description=postiz-agent daily dispatch
Wants=postiz-agent.timer

[Service]
Type=oneshot
User=postiz-agent
WorkingDirectory=/opt/postiz-agent
ExecStart=/usr/local/bin/node dist/cli.js dispatch --tenant product --platforms x,instagram --json
StandardOutput=append:/opt/postiz-agent/data/cron.jsonl
StandardError=append:/opt/postiz-agent/data/cron-errors.log
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
without tailing `data/cron.jsonl`.

## Testing your cron entry without waiting a day

```bash
# One-shot: verify the exact invocation works
cd /path/to/postiz-agent
node dist/cli.js dispatch --tenant product --platforms instagram --dry-run --json

# Inspect the last N decisions the agent made
node dist/cli.js decisions --tenant product | tail -20
```

stdout contains JSON reports and stderr contains diagnostics. For an uncertain
publication or a retained lock, follow [recovery](../../docs/production-readiness.md)
before resetting attempts. Do not automate `--force` or lock deletion.
