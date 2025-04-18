# Shopify Favorites Sync App

A Node.js + Express application that syncs product favorites from the storefront to customer metafields in Shopify.

## Features

- Syncs product favorites from localStorage to Shopify customer metafields
- Supports both guest users and logged-in customers
- Merges existing favorites with new ones
- RESTful API endpoint for syncing favorites

## Prerequisites

- Node.js (v14 or higher)
- npm or yarn
- Shopify store with Admin API access
- Private app credentials (API key, secret, and access token)

## Setup

1. Clone the repository:
```bash
git clone <repository-url>
cd VEV-app
```

2. Install dependencies:
```bash
npm install
```

3. Create a `.env` file in the root directory with your Shopify credentials:
```env
# Shopify API Credentials
SHOPIFY_API_KEY=your_api_key
SHOPIFY_API_SECRET=your_api_secret
SHOPIFY_ADMIN_API_ACCESS_TOKEN=your_access_token
SHOPIFY_SHOP=your-store.myshopify.com

# Server Configuration
PORT=3000
NODE_ENV=development
```

4. Start the server:
```bash
npm start
```

For development with auto-reload:
```bash
npm run dev
```

## API Endpoints

### POST /api/sync-favorites

Syncs product favorites for a customer.

**Request Body:**
```json
{
  "customerId": "1234567890",
  "favorites": [
    {
      "productId": "8823074750722",
      "variantId": "45557802631426"
    },
    {
      "productId": "1234567890123"
    }
  ]
}
```

**Response:**
```json
{
  "success": true,
  "message": "Favorites synced successfully"
}
```

## Metafield Structure

The app stores favorites in a customer metafield with:
- Namespace: `cad`
- Key: `customer_products`
- Type: `json`

Example value:
```json
{
  "saved": {
    "8823074750722": ["45557802631426"],
    "1234567890123": []
  },
  "viewed": "",
  "custom": {}
}
```

## Error Handling

The API returns appropriate HTTP status codes and error messages:
- 400: Invalid request data
- 404: Customer not found
- 500: Server error

## License

ISC 