# Postiz self-hosted deployment

## Setup

1. Copy env template:
   ```
   cp .env.example .env
   ```

2. Generate JWT secret:
   ```
   echo "POSTIZ_JWT_SECRET=$(openssl rand -hex 32)" >> .env
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
