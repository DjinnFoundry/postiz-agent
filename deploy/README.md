# Postiz deployment

The bundled Compose pins Postiz **v2.23.0** and includes PostgreSQL, Redis, Temporal and Temporal's PostgreSQL/Elasticsearch stores. Temporal is required by current Postiz releases. The service layout was checked against the [official Compose repository](https://github.com/gitroomhq/postiz-docker-compose/tree/dd4969e5e694cd009619a0d53cff14c21104580b) and [installation guide](https://docs.postiz.com/installation/docker-compose) on 2026-09-06. Configuration validation and a local startup with all six services healthy passed. A real social publication still needs operator credentials and verification.

## Configure and start

1. In `deploy/`, copy `.env.example` to `.env` if it does not already exist. Fill `POSTIZ_JWT_SECRET` and `POSTIZ_DB_PASSWORD` with separate random values generated with `openssl rand -hex 32` and `openssl rand -hex 24`. Restrict the file with `chmod 600 .env`. Preserve existing values when configuring an existing database.
2. Set `POSTIZ_PUBLIC_URL` to your public HTTPS origin, without a trailing slash. Local inspection can use `http://localhost:4007`. OAuth callbacks and remotely fetched media need an address reachable by the platforms; localhost alone is not a production deployment.
3. Add platform credentials to the matching variables in `.env`. Register callbacks using the public origin and the path shown by Postiz. Verify provider approvals and account requirements with each platform.
4. Validate and start:

   ```sh
   docker compose config --quiet
   docker compose up -d
   docker compose ps
   docker compose logs --tail=100 postiz temporal
   ```

5. Open `http://localhost:4007` or your public origin. To create the initial admin, temporarily set `POSTIZ_DISABLE_REGISTRATION=false`, recreate Postiz with `docker compose up -d`, create the account, then restore `true` and recreate it again.
6. Connect your social accounts through Postiz and obtain the Public API key from its developer settings.

The host listener is `127.0.0.1:4007`, forwarding to container port 5000. Put your TLS reverse proxy in front of that listener. Database, queue and Temporal ports stay internal. Budget resources for the full stack, including Elasticsearch, and verify health on the target machine.

## Connect this agent

Self-hosted API URLs include `/api`, such as `http://localhost:4007/api/public/v1` or `https://your-domain/api/public/v1`. Postiz cloud uses `https://api.postiz.com/public/v1`. See the [API contract](https://docs.postiz.com/public-api/posts/create).

For multiple products, create a named tenant with `node dist/cli.js init` and configure `tenants/<product>/config.json`. Bind networks to their account IDs with `postiz.integrationIds`; multiple active accounts otherwise produce an ambiguity error. See [the launch guide](../docs/production-readiness.md) for an example.

From the project root:

```sh
pnpm build
node dist/cli.js integrations --tenant <product> --json
node dist/cli.js doctor --tenant <product> --json
node dist/cli.js publish --tenant <product> --bundle-file ./tmp/post.json --platforms x --dry-run --json
```

Review the caption and media before a real post. A successful create response means **accepted by Postiz**, not confirmation that the social network finished publishing. Check the queue and actual account before enabling unattended runs.

## Updates and backups

The image is pinned so restarting or pulling does not silently change versions. Before changing the tag, check upstream release/migration instructions, back up `postiz-data/`, the agent's `data/` and tenant configurations, then test on a separate instance. Do not reset volumes to fix an upgrade.

Persistent data lives under `postiz-data/`: `postgres`, `redis`, `uploads`, `config`, `temporal-postgres`, and `temporal-elasticsearch`. Use consistent database backups or stop services for a filesystem snapshot. Keep uploads and database state together. Agent decision archives are part of duplicate prevention and must also be retained.
