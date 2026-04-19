# Postiz self-hosted deployment

## Setup

1. Copy env template:
   ```
   cp .env.example .env
   ```

2. Generate the required secrets (both are mandatory — the compose file will
   refuse to start without them):
   ```
   echo "POSTIZ_JWT_SECRET=$(openssl rand -hex 32)" >> .env
   echo "POSTIZ_DB_PASSWORD=$(openssl rand -hex 24)" >> .env
   ```

3. Add your platform credentials to `.env`:
   - **X / Twitter**: create a Developer App at developer.x.com (Native App, Read+Write)
     - Callback URL: `http://localhost:5000/integrations/social/x`
     - Copy `X_API_KEY` and `X_API_SECRET`
   - **TikTok**: register at developers.tiktok.com and request production
     - Callback URL: `http://localhost:5000/integrations/social/tiktok`
   - **Instagram**: create a Meta App (Business type) at developers.facebook.com
     - Requires an Instagram Business/Creator account linked to a Facebook Page
     - Callback URL: `http://localhost:5000/integrations/social/instagram`

4. Start:
   ```
   docker compose up -d
   ```

5. Open http://localhost:5000, create an admin account, then connect each platform via Integrations.

   **First-time admin creation:** the default `POSTIZ_DISABLE_REGISTRATION=true`
   blocks the signup page. To create your admin, temporarily set
   `POSTIZ_DISABLE_REGISTRATION=false` in `.env`, restart with
   `docker compose up -d`, register, then flip it back to `true` and restart.

## Exposing Postiz beyond localhost

If you plan to serve the Postiz UI/API on a public hostname (reverse proxy,
Docker Swarm, cloud VM, etc.):

- Make sure `POSTIZ_DISABLE_REGISTRATION=true` is set before you expose port
  5000 to the internet. Otherwise anyone can register an account and use the
  public API to post to your connected X / TikTok / Instagram accounts.
- Terminate TLS in front of the container. The default `MAIN_URL` is `http://`.
- Restrict the postgres container to the internal docker network (default).
  Do NOT add a `ports:` mapping for `postgres` or `redis`.

6. Once connected, create an API key under Settings → Developers → Public API and add to the root `.env`:
   ```
   POSTIZ_API_URL=http://localhost:5000/public/v1
   POSTIZ_API_KEY=<key>
   ```

## Update

```
docker compose pull
docker compose up -d
```

## Data persistence

- `./postiz-data/postgres/` — database
- `./postiz-data/redis/`    — queue state
- `./postiz-data/uploads/`  — uploaded media
