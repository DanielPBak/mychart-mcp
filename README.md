# mychart-mcp

An MCP server that lets Claude use **Epic MyChart** for you: read your messages, reply to your care team, and start new messages. It's built for NYU Langone Health but works with any MyChart web portal if you change `MYCHART_BASE_URL`.

Epic's official FHIR API is read-only and has no messaging, so this server drives the MyChart **website** in a headless Chromium (Playwright) using your own login.

## Tools

| Tool | What it does |
|---|---|
| `mychart_status` | Logged in / login form / waiting on 2FA |
| `mychart_login` | Logs in (uses env credentials unless you pass them) |
| `mychart_submit_code` | Enters the 2FA code and ticks "trust this device" |
| `mychart_list_messages` | Opens the message center and lists conversations |
| `mychart_open_message` | Returns a conversation's full text |
| `mychart_reply` | Replies to a conversation. **`dry_run` defaults to true**: it types the reply but doesn't send it |
| `mychart_start_new_message` | Opens the "Ask a question / New message" wizard |
| `mychart_snapshot` / `_click` / `_fill` / `_select` / `_navigate` / `_screenshot` | General page control, so Claude can handle any page the tools above don't cover (the new-message wizard, appointments, bills, …) |

The new-message wizard differs between health systems (message type → recipient → subject → body), so Claude walks it step by step with the snapshot, click, fill and select tools instead of relying on hard-coded selectors.

## Setup

```bash
npm install
npx playwright install chromium   # skip if you already have Playwright's Chromium
npm run build
cp .env.example .env              # then edit it
```

### First login (do this once, with a visible browser)

MyChart asks for a 2FA code the first time. Run with `MYCHART_HEADLESS=false` and log in once. `mychart_submit_code` ticks "trust this device", and the persistent profile in `./profile` keeps that trust, so later sessions usually skip 2FA. If MyChart asks again, Claude will request the code from you.

### Claude Code (local, stdio)

```bash
claude mcp add mychart \
  -e MYCHART_USERNAME=you -e MYCHART_PASSWORD='...' \
  -e MYCHART_PROFILE_DIR=$PWD/profile \
  -- node $PWD/dist/index.js
```

### Claude Desktop

```json
{
  "mcpServers": {
    "mychart": {
      "command": "node",
      "args": ["/absolute/path/to/mychart-mcp/dist/index.js"],
      "env": {
        "MYCHART_USERNAME": "you",
        "MYCHART_PASSWORD": "...",
        "MYCHART_PROFILE_DIR": "/absolute/path/to/mychart-mcp/profile"
      }
    }
  }
}
```

### Remote / cloud agents (HTTP)

```bash
MCP_AUTH_TOKEN=$(openssl rand -hex 32) npm run start:http   # serves http://localhost:8787/mcp
```

- Put it behind HTTPS, for example with a Cloudflare Tunnel or Tailscale Funnel on a home machine.
- Connect with `claude mcp add --transport http mychart https://your-host/mcp --header "Authorization: Bearer <token>"`.
- **The host must be in the US.** NYU's portal says it can't be used from outside the US.
- A home machine is better than a cloud VM: a residential IP and a stable "trusted device" mean fewer 2FA prompts and fewer security flags.
- claude.ai custom connectors expect OAuth, not a static bearer token. Supporting them would need an OAuth layer in front of this server.

## Smoke test

```bash
npm run build && node scripts/smoke-test.mjs
```

The test logs in with fake credentials and checks that the server lists its tools, detects the login page and reports the failed login.

## Caveats (read these)

- **Unverified past login.** The login form selectors (`#Login`, `#Password`, `#submit`) were checked against NYU's live portal. The message-center paths and the Reply/Send buttons are best guesses from how MyChart usually looks, and no real account has tested them yet. If a tool can't find something, it tells Claude to use `mychart_snapshot`, and the general tools can still finish the job. Please report or fix the selectors as you hit them.
- **Sending is real.** A message to your care team is part of your medical record. `mychart_reply` defaults to a dry run, and the tool descriptions tell Claude to confirm before sending. Keep tool permission prompts on for `mychart_reply`, `mychart_click` and `mychart_start_new_message`.
- **Terms of service.** Automated access probably breaks MyChart's terms of use. Use it only on your own account, at human speed.
- **Secrets.** `./profile` holds live session cookies. Treat it like a password: it's gitignored, so keep it that way. Don't send it to shared machines.
- **Not for urgent issues.** MyChart messages can take days to get an answer. For emergencies, call 911 or your doctor.
