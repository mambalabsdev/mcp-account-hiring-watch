# Account Hiring Watch MCP Server

[![Smithery](https://smithery.ai/badge/mambabuilt/mcp-account-hiring-watch)](https://smithery.ai/servers/mambabuilt/mcp-account-hiring-watch) [![Glama score](https://glama.ai/mcp/servers/mambalabsdev/mcp-account-hiring-watch/badges/score.svg)](https://glama.ai/mcp/servers/mambalabsdev/mcp-account-hiring-watch) [![MCP Registry](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fregistry.modelcontextprotocol.io%2Fv0%2Fservers%3Fsearch%3Dcom.mambabuilt%252Fmcp-account-hiring-watch%26limit%3D1&query=%24.servers%5B0%5D._meta%5B%22io.modelcontextprotocol.registry%2Fofficial%22%5D.status&label=mcp%20registry&color=blue)](https://registry.modelcontextprotocol.io/v0/servers?search=com.mambabuilt/mcp-account-hiring-watch&limit=1) [![npm version](https://img.shields.io/npm/v/@mambalabsdev/mcp-account-hiring-watch)](https://www.npmjs.com/package/@mambalabsdev/mcp-account-hiring-watch) [![npm downloads](https://img.shields.io/npm/dm/@mambalabsdev/mcp-account-hiring-watch)](https://www.npmjs.com/package/@mambalabsdev/mcp-account-hiring-watch) [![license](https://img.shields.io/github/license/mambalabsdev/mcp-account-hiring-watch)](https://github.com/mambalabsdev/mcp-account-hiring-watch/blob/main/LICENSE) [![mcpservers.org](https://img.shields.io/badge/mcpservers.org-listed-blue)](https://mcpservers.org/servers/mambalabsdev/mcp-account-hiring-watch)

An MCP server for the Mamba Labs Account Hiring Watch actor on Apify. Send a list of company domains. Each run reads every company's own job board and returns only what changed since the last run: new, closed, and reposted postings, with the full job description, a stable posting key, and 30 day hiring velocity per company.

## What's Inside

- [What it does](#what-it-does)
- [Quick start](#quick-start)
- [Prerequisites](#prerequisites)
- [Example prompts](#example-prompts)
- [Tool](#tool)
- [Inputs](#inputs)
- [Pricing](#pricing)
- [Your keys](#your-keys)
- [Full actor documentation](#full-actor-documentation)
- [License](#license)

## What it does

Watch a list of company domains and get back only what changed on their job boards since the last run with the same watch name: new, closed, and reposted postings, read live from 17 job boards including Greenhouse, Lever, Ashby, and Workday. Each change row carries the full job description, a stable posting key, and the board it came from; each company also gets a summary row with open postings and 30 day hiring velocity. The first run for a watch sets the baseline, and its rows are marked is_backfill and never charged. Optional signed webhook delivery. A run that does not succeed is returned as an error with its run ID. Read-only on the boards; requires an APIFY_TOKEN and consumes Apify credits per change returned.

All of the work runs on Apify. This package is a thin client that starts the actor run, waits for it, and hands back the dataset rows.

## Quick start

You need Node.js 18 or newer and an Apify account with an API token.

Add this to your Claude Desktop config (`claude_desktop_config.json`), Cursor, or any MCP client:

```json
{
  "mcpServers": {
    "mamba-account-hiring-watch": {
      "command": "npx",
      "args": [
        "-y",
        "@mambalabsdev/mcp-account-hiring-watch"
      ],
      "env": {
        "APIFY_TOKEN": "your-apify-token"
      }
    }
  }
}
```

Restart the client. The `watch_account_hiring` tool appears.

## Prerequisites

- Node.js 18 or newer.
- An Apify API token from [console.apify.com/account/integrations](https://console.apify.com/account/integrations), set as `APIFY_TOKEN`. The server lists its tool without a token; a call needs one.

## Example prompts

- "Watch stripe.com, ramp.com, and vercel.com for new sales and RevOps postings."
- "Run my target account watch again and tell me which companies opened or closed GTM roles since last week."

## Tool

`watch_account_hiring`. One tool. Example arguments:

```json
{
  "domains": ["stripe.com", "ramp.com", "vercel.com"],
  "watch_name": "target-accounts",
  "keyword_categories": ["GTM"]
}
```

## Inputs

Every buyer facing input of the live actor, unchanged. Omitted inputs take the actor's own defaults.

| Input | Type | Required | Description |
|---|---|---|---|
| `domains` | array | yes | Company website domains to watch, for example stripe.com. The watch reads each company's own job board. Up to 2,000 per run. |
| `watch_name` | string | no | Keeps separate watch lists apart. Use one name per list or client. Changing the name starts a new watch, and its first run sets the baseline. Default default. |
| `keyword_categories` | array | no | Only changes to postings whose title matches these role categories are returned and charged. All returns every posting change. Every posting still counts toward hiring velocity. Default ["All"]. |
| `custom_keywords` | array | no | Extra title keywords, matched on whole words. Prefix with T1: for the strongest tier or T3: for the weakest; no prefix is tier 2. Adding any keyword also adds the Custom category. |
| `board_hints` | array | no | Point a domain at its job board when the watch cannot find it, as domain=provider:slug, for example acme.com=greenhouse:acmeinc or acme.com=workday:acme.wd5/External. Providers: greenhouse, lever, ashby, workable, smartrecruiters, personio, recruitee, workday, rippling. |
| `first_run_mode` | string | no | What a domain's first run returns. recent returns postings the board dates inside the last N days, baseline_only returns the summary row, all_open returns every open posting. First run rows are marked is_backfill and never charged. Default recent. |
| `first_run_recent_days` | string | no | With first_run_mode recent: how many days back counts as recent. 1 to 30. Default 7. |
| `closed_after_misses` | string | no | A posting closes after this many complete board reads without it. A partial read never counts. 1 to 5. Default 2. |
| `repost_window_days` | string | no | A closed posting that comes back inside this many days is reported as reposted, not new. 7 to 60. Default 30. |
| `include_job_description` | string | no | Adds the full description text to new and reposted rows. Closed rows carry no description. Default true. |
| `description_max_chars` | string | no | Longest description kept per row. job_description_chars always reports the full length. 500 to 100000. Default 20000. |
| `webhook_url` | string | no | Optional HTTPS endpoint. Changes are sent as signed Standard Webhooks requests, and a change is charged only after your endpoint answers 2xx. |
| `webhook_secret` | string | no | Required with webhook_url. Signs each request (HMAC SHA256). A whsec_ prefixed secret is base64 decoded per the Standard Webhooks spec. |
| `webhook_batch_mode` | string | no | batch sends up to 50 changes per request, grouped by company. per_change sends one request per change, for tools where one request is one row (Clay table webhooks, Zapier). Default batch. |
| `state_store` | string | no | Optional key value store that holds the watch state. Leave empty to use the store account-hiring-watch-state in your own Apify account. |
| `max_domains` | string | no | Domains past this number are skipped. 1 to 2000. Default 500. |
| `max_charge_usd` | string | no | Optional. When the next change would take this run's charges over this amount, the remaining changes are held and delivered first on the next run. |

## Pricing

Pay per event on Apify, billed to your Apify account. Prices in USD.

| Event | Free plan | Bronze | Silver | Gold |
|---|---|---|---|---|
| `posting_change`, per change returned (new, closed, or reposted) | $0.01 | $0.0095 | $0.009 | $0.0085 |
| `apify-actor-start`, per run start | $0.002 | $0.002 | $0.002 | $0.002 |

First run rows (`is_backfill`) and rows from a board the run could not confirm are never charged. With a webhook set, a change is charged only after your endpoint answers 2xx.

## Your keys

The actor needs no provider key. It reads public job board APIs and holds no key of its own. A webhook secret, if you set one, is yours and is stored by Apify as a secret input.

## Full actor documentation

[apify.com/mambalabs/account-hiring-watch](https://apify.com/mambalabs/account-hiring-watch)

## License

MIT. See [LICENSE](LICENSE).
