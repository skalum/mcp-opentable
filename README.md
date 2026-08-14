# @striderlabs/mcp-opentable

**Book restaurant reservations via OpenTable using AI agents**

[![npm](https://img.shields.io/npm/v/@striderlabs/mcp-opentable)](https://www.npmjs.com/package/@striderlabs/mcp-opentable)
[![MCP Registry](https://img.shields.io/badge/MCP-Registry-blue)](https://mcpservers.org/servers/strider-labs-opentable)
[![Claude Desktop](https://img.shields.io/badge/Claude-Desktop-blue)](https://docs.anthropic.com/mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)

Part of [Strider Labs](https://github.com/striderlabsdev/striderlabs) — action execution for personal AI agents.

## Get Started in 2 Minutes

### For Claude Desktop Users

1. Add this to your Claude Desktop config:

```json
{
  "mcpServers": {
    "opentable": {
      "command": "npx",
      "args": ["-y", "@striderlabs/mcp-opentable"]
    }
  }
}
```

2. Restart Claude.
3. Tell Claude: *"Book a table for 4 at an Italian restaurant for 7 PM tonight"*

Your agent can now book reservations. That's it.

---

## Installation (NPM)

```bash
npm install @striderlabs/mcp-opentable
```

Or with npx directly:

```bash
npx @striderlabs/mcp-opentable
```

## Features

- 🔍 **Search restaurants** by cuisine, location, and rating
- ⏰ **Check availability** for specific times and party sizes
- 📅 **Make reservations** with one-click confirmation
- 📝 **View booking history** and manage reservations
- 🏷️ **Filter by price, cuisine, and dining style**
- 🔐 **Persistent sessions** - stay logged in across restarts
- 🔄 **Automatic MFA** - handles multi-factor authentication
- 📱 **Per-user credentials** - encrypted session storage

## Tested & Compatible

| Component | Version | Status |
|-----------|---------|--------|
| **MCP SDK** | ^1.0.0 | ✅ |
| **Node.js** | 18+ | ✅ |
| **Claude Desktop** | Latest | ✅ |
| **Claude (API)** | claude-3.5-sonnet+ | ✅ |
| **Anthropic SDK** | ^0.20+ | ✅ |

## Metrics

- **Weekly downloads:** 187 (Apr 10-17, 2026) — Top restaurant connector (+467% growth)
- **Status:** ✅ Live in production
- **Reliability:** 85%+ task completion rate
- **Discovery:** npm, Claude Plugins, mcpservers.org, ClawHub, PulseMCP

## Available Elsewhere

- **npm:** [npmjs.com/@striderlabs/mcp-opentable](https://npmjs.com/package/@striderlabs/mcp-opentable)
- **Claude Plugins:** Search "Strider Labs" in Claude
- **mcpservers.org:** [Strider Labs OpenTable](https://mcpservers.org/servers/strider-labs-opentable)
- **Full Strider Labs:** [github.com/striderlabsdev/striderlabs](https://github.com/striderlabsdev/striderlabs)

## How It Works

### For Agents
Your agent can use these capabilities:
```javascript
// Search for restaurants
restaurants = search_restaurants({
  location: "San Francisco, CA",
  cuisine: "Italian",
  price_range: "$$",
  date: "2026-04-15",
  party_size: 4,
  time: "19:00"
})

// Get detailed restaurant info
details = get_restaurant_details({
  restaurant_id: "ristorante-milano-sf"
})

// Check availability
availability = check_availability({
  restaurant_id: "ristorante-milano-sf",
  party_size: 4,
  date: "2026-04-15",
  time: "19:00"
})

// Make a reservation
booking = make_reservation({
  restaurant_id: "ristorante-milano-sf",
  party_size: 4,
  date: "2026-04-15",
  time: "19:00",
  special_requests: "Window seat if possible"
})

// View your reservations
reservations = get_my_reservations()
```

### Session Management
- Each user has encrypted, persistent credentials
- Automatic OAuth token refresh
- MFA handling (SMS/email)
- Sessions survive agent restarts

### Reliability
- 85%+ task completion rate
- Automated UI change detection (connectors update when OpenTable changes)
- Fallback paths for failures
- 24/7 monitoring + alerting

## Configuration

### Login

OpenTable has no password login — signing in emails a one-time verification
code. Set `OPENTABLE_EMAIL` and the server handles the rest of the flow:

1. `opentable_login` (called explicitly, or automatically when a booking
   tool needs an authenticated session) opens OpenTable's sign-in flow and
   requests a code for `OPENTABLE_EMAIL`.
2. The agent asks you for the code from your inbox and passes it to
   `opentable_submit_code`, which completes the login.
3. Session cookies are saved to `~/.strider/opentable/cookies.json` and
   reused across restarts, so this only recurs when the session expires.

In Claude Desktop, set the variable via the `env` block of the server config:

```json
{
  "mcpServers": {
    "opentable": {
      "command": "npx",
      "args": ["-y", "@striderlabs/mcp-opentable"],
      "env": {
        "OPENTABLE_EMAIL": "your-email@example.com"
      }
    }
  }
}
```

For first-time setup you can also log in from a terminal instead of through
the agent:

```bash
OPENTABLE_EMAIL=your-email@example.com node scripts/login.mjs
# enter the emailed code at the prompt
```

### Browser requirements

OpenTable blocks headless browsers at the network edge, so this server
drives a real, visible Google Chrome window (via
[patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright)):

- **Google Chrome must be installed** on the machine running the server.
- A display is required. On a desktop macOS/Windows/Linux machine this just
  works (a Chrome window appears briefly during operations). On a headless
  Linux server, run under a virtual display, e.g.
  `xvfb-run -a npx @striderlabs/mcp-opentable`.

### Self-Hosted

```bash
# Clone the repo
git clone https://github.com/striderlabsdev/mcp-opentable
cd mcp-opentable

# Install dependencies
npm install

# Start the server
npm start

# Your agent can now connect to localhost:3000
```

## Architecture

### How We Connect
This connector uses browser automation (Playwright) to interact with OpenTable, because OpenTable doesn't have a comprehensive public API for reservations. Here's why that's safe and reliable:

- **User-controlled:** Your agent only accesses your own OpenTable account
- **Session-based:** We store your login session securely, not your password
- **Change-aware:** We detect OpenTable UI changes and alert immediately
- **Fingerprinting:** We use realistic browser profiles to avoid bot detection
- **Rate-limited:** We respect OpenTable's infrastructure with appropriate delays

### Security
- Credentials stored encrypted in your local `.env` or secure vault
- Sessions isolated per user
- No data sent to third parties
- MIT Licensed — audit the code yourself

## Support

- 📖 [Full Strider Labs Docs](https://github.com/striderlabsdev/striderlabs)
- 🐛 [Report Issues](https://github.com/striderlabsdev/mcp-opentable/issues)
- 💬 [Discussions](https://github.com/striderlabsdev/mcp-opentable/discussions)
- 🌐 [Website](https://striderlabs.ai)
- 📧 [Email](mailto:hello@striderlabs.ai)

## Contributing

We welcome contributions! Areas of interest:
- Bug reports and fixes
- Feature requests (new filters, integrations, etc.)
- Performance improvements
- Documentation enhancements

See [CONTRIBUTING.md](../CONTRIBUTING.md) for guidelines.

## License

MIT — Free to use, modify, and distribute. See [LICENSE](./LICENSE) for details.

---

**Built by Strider Labs** — Making AI agents actually useful.

[GitHub](https://github.com/striderlabsdev) | [Website](https://striderlabs.ai) | [Discord](https://discord.gg/openclaw)
