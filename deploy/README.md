# Postiz self-hosted deployment

This is the steps any operator runs ONCE per project to make the agent able to publish. Until you finish step 8 below, every `publish` call will fail with HTTP 403 and `doctor` will flag `postiz integrations: needs-config`. Allow ~30 minutes the first time; mostly it's waiting on platform OAuth approvals.

## First run, in order

1. Copy env template:
   ```
   cd deploy
   cp .env.example .env
   ```

2. Generate the required secrets (both are mandatory — the compose file will
   refuse to start without them):
   ```
   echo "POSTIZ_JWT_SECRET=$(openssl rand -hex 32)" >> .env
   echo "POSTIZ_DB_PASSWORD=$(openssl rand -hex 24)" >> .env
   ```

3. Add your platform credentials to `deploy/.env`. Each platform needs a redirect URL pointing back at the local Postiz (or your public domain if you're hosting):
   - **X / Twitter**: create a Developer App at developer.x.com (Native App, Read+Write)
     - Callback URL: `http://localhost:5000/integrations/social/x`
     - Copy `X_API_KEY` and `X_API_SECRET`
   - **TikTok**: register at developers.tiktok.com and request production review (5–10 days)
     - Callback URL: `http://localhost:5000/integrations/social/tiktok`
     - Copy `TIKTOK_CLIENT_KEY` and `TIKTOK_CLIENT_SECRET`
   - **Instagram**: create a Meta App (Business type) at developers.facebook.com
     - Requires an Instagram Business/Creator account linked to a Facebook Page
     - Callback URL: `http://localhost:5000/integrations/social/instagram`
     - Copy `INSTAGRAM_APP_ID` and `INSTAGRAM_APP_SECRET`

4. Start the Postiz stack:
   ```
   docker compose up -d
   docker compose logs -f postiz   # wait until you see the "ready" line
   ```

5. Open http://localhost:5000 and create an admin account.

   **First-time admin creation:** the default `POSTIZ_DISABLE_REGISTRATION=true`
   blocks the signup page. To create your admin, temporarily set
   `POSTIZ_DISABLE_REGISTRATION=false` in `.env`, restart with
   `docker compose up -d`, register, then flip it back to `true` and restart.

6. In the Postiz UI → Integrations, connect each platform via OAuth. You'll get redirected to X/TikTok/Meta, log in, approve the scopes, and bounce back. Verify the green "connected" dot for each.

7. Settings → Developers → Public API: create an API key. Copy it.

8. Wire the agent to this Postiz:
   - For the `default` tenant: add to the project root's `.env`:
     ```
     POSTIZ_API_URL=http://localhost:5000/public/v1
     POSTIZ_API_KEY=<the key>
     ```
   - For a named tenant (recommended for production), edit `tenants/<slug>/config.json`:
     ```json
     {
       "postiz": { "apiUrl": "http://localhost:5000/public/v1", "apiKey": "<the key>" }
     }
     ```

9. Verify everything end-to-end:
   ```
   pnpm dev doctor                          # default tenant
   pnpm dev doctor --tenant <slug>          # named tenant
   pnpm dev integrations --tenant <slug>    # should list 4 platforms with ● dots
   ```
   Both should report `postiz integrations: ok` and at least one `<platform> integration: ok`. If you see `403`, the API key in `.env` / `tenants/<slug>/config.json` doesn't match what step 7 generated.

10. First real publish (one platform, no scheduling, idempotent):
    ```
    pnpm dev publish --tenant <slug> \
      --slug <story-slug> \
      --platforms tiktok \
      --reason "first real publish, smoke test"
    ```
    On success the decision log shows a `success: true` entry with a real `https://...` URL — that's the moment the loop closes.

## Exposing Postiz beyond localhost

If you plan to serve the Postiz UI/API on a public hostname (reverse proxy,
Docker Swarm, cloud VM, etc.):

- Make sure `POSTIZ_DISABLE_REGISTRATION=true` is set before you expose port
  5000 to the internet. Otherwise anyone can register an account and use the
  public API to post to your connected X / TikTok / Instagram accounts.
- Terminate TLS in front of the container. The default `MAIN_URL` is `http://`.
- Restrict the postgres container to the internal docker network (default).
  Do NOT add a `ports:` mapping for `postgres` or `redis`.

## Multi-tenant note

You can host one Postiz instance per tenant (each on its own port / domain) OR share a single Postiz across tenants by having each tenant carry its own API key (which Postiz scopes by user account). For one-operator setups (one human, multiple products) the second option is the lighter path: one docker stack, one OAuth dance per platform, multiple `tenants/<slug>/config.json` files differing only by `apiKey`.

## Update

```
docker compose pull
docker compose up -d
```

## Data persistence

- `./postiz-data/postgres/` — database
- `./postiz-data/redis/`    — queue state
- `./postiz-data/uploads/`  — uploaded media
