# Loyalty Cashback System Design

**Date:** 2025-02-01
**Status:** Approved
**Project:** VEV-app (Shopify Favorites Sync App Extension)

---

## Overview

Expand the existing VEV-app to include a tiered loyalty cashback system. Customers earn points on purchases based on their spending tier, and redeem points for discount codes.

## Key Decisions

| Decision | Choice |
|----------|--------|
| Configuration storage | Shopify shop metafields (editable via Shopify Admin) |
| Tier determination | Based on lifetime spend (Bronze/Silver/Gold) |
| Point award timing | On order paid, with automatic reversal on refund |
| Redemption method | Generate unique one-time Shopify discount codes |
| Display locations | Header, Cart, Account page, Dedicated rewards page |

---

## Data Model

### Customer Loyalty Metafield

**Namespace:** `custom`
**Key:** `loyalty`
**Type:** `json`

```json
{
  "points_balance": 450,
  "lifetime_spend": 1250.00,
  "tier": "silver",
  "history": [
    {"type": "earn", "points": 150, "order_id": "5678", "date": "2025-01-15"},
    {"type": "redeem", "points": -100, "code": "LOYALTY-ABC123", "date": "2025-01-20"},
    {"type": "reverse", "points": -50, "order_id": "5678", "reason": "refund", "date": "2025-01-18"}
  ]
}
```

**Fields:**
- `points_balance` — Current redeemable points
- `lifetime_spend` — Total spend (determines tier)
- `tier` — Cached tier name (recalculated on each order)
- `history` — Last 20 transactions (keeps metafield size manageable)

### Shop Loyalty Config Metafield

**Namespace:** `custom`
**Key:** `loyalty_config`
**Type:** `json`

```json
{
  "tiers": {
    "bronze": {"min_spend": 0, "points_per_dollar": 1},
    "silver": {"min_spend": 500, "points_per_dollar": 1.5},
    "gold": {"min_spend": 2000, "points_per_dollar": 2}
  },
  "redemption": {
    "points_required": 100,
    "discount_value": 5,
    "discount_type": "fixed_amount"
  },
  "welcome_bonus": 50
}
```

---

## API Endpoints

### New Routes for VEV-app

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/loyalty/balance` | GET | Get customer's points, tier, and recent history |
| `/api/loyalty/redeem` | POST | Redeem points, create discount code |
| `/api/webhooks/orders-paid` | POST | Shopify webhook: award points |
| `/api/webhooks/refunds-create` | POST | Shopify webhook: reverse points |

### Request/Response Examples

**Get Balance:**
```
GET /api/loyalty/balance?customerId=123456
Headers: x-api-key: <API_SECRET_KEY>

Response:
{
  "success": true,
  "points": 450,
  "tier": "silver",
  "tier_config": {"min_spend": 500, "points_per_dollar": 1.5},
  "next_tier": "gold",
  "spend_to_next_tier": 750,
  "lifetime_spend": 1250,
  "history": [...]
}
```

**Redeem Points:**
```
POST /api/loyalty/redeem
Headers: x-api-key: <API_SECRET_KEY>
Body: { "customerId": 123456, "points": 100 }

Response:
{
  "success": true,
  "discount_code": "LOYALTY-A7X9K2",
  "discount_value": 5,
  "points_redeemed": 100,
  "remaining_points": 350
}
```

---

## File Structure

### VEV-app (Backend)

```
/Users/cazacug/Development/VEV-app/
├── server.js                    # Add webhook & loyalty routes
├── config/
│   └── shopifyClient.js         # Add new scopes
├── routes/
│   ├── syncFavorites.js         # Existing
│   ├── loyalty.js               # NEW: balance + redeem
│   └── webhooks.js              # NEW: orders-paid, refunds-create
├── services/
│   ├── shopifyService.js        # Existing (extend for shop metafields)
│   ├── loyaltyService.js        # NEW: points calculation, tier logic
│   └── discountService.js       # NEW: create discount codes
└── docs/plans/
    └── 2025-02-01-loyalty-cashback-design.md
```

### LG-dev Theme (Frontend)

```
/Users/cazacug/Development/VEV/LG-dev/
├── assets/
│   └── loyalty-handler.js       # NEW: fetch/display points, redemption
├── snippets/
│   ├── loyalty-points-badge.liquid    # NEW: header badge
│   └── loyalty-cart-widget.liquid     # NEW: cart redemption UI
├── sections/
│   └── loyalty-rewards-page.liquid    # NEW: full rewards page
└── templates/
    └── page.rewards.json              # NEW: template for /pages/rewards
```

---

## Webhook Flow

### Order Paid → Award Points

1. Receive `orders/paid` webhook from Shopify
2. Verify HMAC signature with API secret
3. Check if order_id already processed (prevent duplicates)
4. Fetch shop loyalty config (from shop metafield)
5. Fetch customer loyalty metafield (or create with welcome_bonus)
6. Calculate new lifetime_spend = current + order_total
7. Determine tier from new lifetime_spend
8. Calculate points = order_total × tier.points_per_dollar
9. Update customer metafield:
   - `points_balance += earned_points`
   - `lifetime_spend = new_lifetime_spend`
   - `tier = calculated_tier`
   - `history.unshift({type: "earn", ...})`
10. Return 200 OK

### Refund → Reverse Points

1. Receive `refunds/create` webhook from Shopify
2. Verify HMAC signature
3. Find original order in customer history
4. Calculate points_to_deduct = refund_amount × original_tier_rate
5. Deduct from points_balance (minimum 0)
6. Add reversal entry to history
7. Note: lifetime_spend NOT reduced (tier stays earned)
8. Return 200 OK

---

## Frontend Display

```
┌─────────────────────────────────────────────────────┐
│  HEADER                          🛒 Cart  ⭐ 450 pts │
├─────────────────────────────────────────────────────┤
│  CART DRAWER                                        │
│  ┌───────────────────────────────────┐              │
│  │ You have 450 points               │              │
│  │ [Redeem 100 pts for $5 off]       │              │
│  └───────────────────────────────────┘              │
├─────────────────────────────────────────────────────┤
│  ACCOUNT PAGE (/account)                            │
│  • Points balance: 450                              │
│  • Tier: Silver (next: Gold at $2000)               │
│  • [View Rewards →]                                 │
├─────────────────────────────────────────────────────┤
│  REWARDS PAGE (/pages/rewards)                      │
│  • Tier progress bar                                │
│  • Points balance & redemption                      │
│  • Transaction history                              │
│  • How it works explanation                         │
└─────────────────────────────────────────────────────┘
```

---

## Edge Cases & Error Handling

| Scenario | Handling |
|----------|----------|
| Guest checkout | No points awarded (requires customer account) |
| No loyalty metafield yet | Create with welcome_bonus on first order |
| Redeem more than balance | Reject with error message |
| Discount code already used | Shopify handles (one-time codes) |
| $0 order total | Award 0 points (no error) |
| Duplicate webhook | Check order_id in history, skip if exists |
| VPS down on webhook | Shopify retries for 48 hours |
| Customer deleted | Fail gracefully, log error |

---

## Security

1. **HMAC verification** — All webhooks verified with `X-Shopify-Hmac-SHA256`
2. **API key for frontend** — `x-api-key` header (same as favorites)
3. **Customer ID validation** — Verify exists before operations
4. **One-time discount codes** — Prevents reuse/abuse

---

## Required Shopify Scopes

Add to existing app scopes:
- `read_orders` — Verify order data in webhooks
- `write_price_rules` — Create discount codes
- `write_discounts` — Create discount codes

---

## Implementation Order

1. **Backend: Config & Services**
   - Add loyaltyService.js (tier calculation, points math)
   - Add discountService.js (create Shopify discount codes)
   - Extend shopifyService.js (shop metafield read)

2. **Backend: Routes**
   - Add routes/loyalty.js (balance, redeem)
   - Add routes/webhooks.js (orders-paid, refunds-create)
   - Update server.js to mount new routes

3. **Shopify Setup**
   - Create shop metafield definition for loyalty_config
   - Create customer metafield definition for loyalty
   - Register webhooks (orders/paid, refunds/create)

4. **Frontend: Theme**
   - Add loyalty-handler.js
   - Add snippets (badge, cart widget)
   - Add rewards page section
   - Integrate into header, cart drawer, account page

5. **Testing**
   - Test point award on order
   - Test point reversal on refund
   - Test redemption flow
   - Test tier upgrades
