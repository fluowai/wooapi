# n8n-nodes-wooapi

n8n community node for **WooAPI** — send and receive WhatsApp messages programmatically.

## Features

- **Send messages**: text, media (image/audio/video/document), location, contact, reply
- **Manage instances**: list, status, QR code, connect, disconnect
- **Trigger workflow**: receive WhatsApp events via webhook (message received, sent, instance connected, etc.)

## Installation

### Via n8n UI (recommended)

1. Go to **Settings → Community Nodes**
2. Click **Install**
3. Enter `n8n-nodes-wooapi`
4. Click **Install**

### Manual

```bash
npm install n8n-nodes-wooapi
```

Then restart n8n.

## Credentials

| Field | Description |
|-------|-------------|
| Base URL | URL da sua instância WooAPI (ex: `https://api.seudominio.com`) |
| API Key | API key da instância (formato: `woo_xxx`) |

## Nodes

### WooAPI (action node)

**Message resource:**
- **Send Text** — send a text message
- **Send Media** — send image, audio, video, or document
- **Send Location** — share a location
- **Send Contact** — send a contact card
- **Send Reply** — reply quoting a message

**Instance resource:**
- **Get Instances** — list all instances
- **Get Status** — check connection status
- **Get QR Code** — get QR code for connecting
- **Connect** — initiate connection
- **Logout** — disconnect instance

### WooAPI Trigger (trigger node)

Receives WhatsApp events in real-time:

- `message.received` — when someone sends a message
- `message.sent` — when a message is sent
- `instance.connected` / `instance.disconnected`
- `instance.qr` — QR code updated

The trigger automatically registers a webhook on your WooAPI instance.

## Example Workflow

```
[Webhook Trigger: message.received] → [WooAPI: Send Text (auto-reply)]
```

1. Add **WooAPI Trigger** node, select `message.received`
2. Connect a **WooAPI** node with operation `Send Text`
3. Use `{{ $json.data.message.text }}` as response

## Development

```bash
cd n8n-nodes-wooapi
npm install
npm run build
```

To test locally, link the package:

```bash
npm link
cd ~/.n8n/custom
npm link n8n-nodes-wooapi
```

Or add to your n8n `package.json`:

```json
{
  "n8n": {
    "nodes": ["n8n-nodes-wooapi"]
  }
}
```

## License

MIT
