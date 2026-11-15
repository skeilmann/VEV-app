# Deploy (VPS 31.97.184.19)

The app runs in Docker at `/opt/shopify-favorites-sync`, behind the server's Traefik
(HTTPS, Let's Encrypt resolver `le-http`):

    https://srv1009578.hstgr.cloud/vev/...   ->  container port 3000 (prefix /vev removed)

Port 3000 is not published; only Traefik reaches the container.

## Update

    rsync -az --exclude node_modules --exclude .env --exclude .git --exclude test \
      ./ root@31.97.184.19:/opt/shopify-favorites-sync/
    ssh root@31.97.184.19 'cd /opt/shopify-favorites-sync && docker-compose build && docker-compose up -d'
    curl https://srv1009578.hstgr.cloud/vev/ping

(The server has the standalone `docker-compose` binary, not the `docker compose` plugin.)

## .env on the server (never committed)

| Name | Purpose |
|---|---|
| SHOPIFY_SHOP, SHOPIFY_ADMIN_API_ACCESS_TOKEN, SHOPIFY_API_KEY | Admin API access |
| SHOPIFY_API_SECRET | verifies webhook signatures (or SHOPIFY_WEBHOOK_SECRET) |
| CUSTOMER_TOKEN_SECRET | verifies customer tokens; same value as shop metafield `custom.vev_token_secret` |
| ALLOWED_ORIGINS | store origins allowed by CORS, comma-separated |
| SHOP_CURRENCY | shop currency (MDL) |

## Theme side

Theme settings → "VEV app": server address `https://srv1009578.hstgr.cloud/vev`,
"Show rewards in header and cart" (off until loyalty is ready).
The theme signs the customer token with shop metafield `custom.vev_token_secret`.

## Shopify app scopes

Favorites: read_customers, write_customers. Loyalty also needs read_orders
(orders/paid and refunds/create webhooks, order lookup) and write_discounts (codes).
