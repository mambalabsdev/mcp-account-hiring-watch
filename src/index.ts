#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(join(here, "..", "package.json"), "utf8"),
) as { version: string; name: string };

// Distinctive UA so Apify run meta.userAgent marks MCP-originated runs.
const USER_AGENT = `mambalabs-mcp ${pkg.name}@${pkg.version}`;

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
};

// Drop undefined values so optional inputs are not sent to the actor.
function compact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

// How long the actor run itself is allowed to take, in seconds. The suite's
// slowest measured run on 2026-09-22 was 152 s on a seven platform search, so
// 1800 s is roughly twelve times that: headroom for a slow day without letting a
// hung run bill indefinitely.
const ACTOR_RUN_TIMEOUT_SECS = 1800;

// How long this wrapper waits for that run, in milliseconds. The actor's own
// timeout plus two minutes, so the run's own TIMED-OUT status is what the
// caller sees rather than the wrapper giving up first and reporting nothing.
const WRAPPER_WAIT_MS = (ACTOR_RUN_TIMEOUT_SECS + 120) * 1000;
const POLL_INTERVAL_MS = 3000;

const TERMINAL = new Set(["SUCCEEDED", "FAILED", "TIMED-OUT", "ABORTED", "ABORTING"]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Shared caller. actorPath is the actor's immutable Apify actor ID (a stable key
// that survives Store renames). The /v2/acts/{id} endpoint accepts it directly,
// so a Store rename never breaks these calls.
//
// START AND POLL, NOT RUN-SYNC. Apify's synchronous endpoints carry a platform
// ceiling of 300 seconds on the HTTP wait itself and answer 408 past it whatever
// the timeout parameter says, so a long run reads as a timeout even though the
// actor goes on to finish. Starting the run, polling it to a terminal status and
// then reading the dataset is the only way to wait as long as the actor needs.
//
// The token is read here rather than at module load, so the tool registers
// unconditionally and a server started without APIFY_TOKEN still advertises its
// capabilities instead of reporting none.
async function runActor(
  actorPath: string,
  actorLabel: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const APIFY_TOKEN = process.env.APIFY_TOKEN;
  if (!APIFY_TOKEN) {
    return { isError: true, content: [{ type: "text", text: "APIFY_TOKEN is not set. Create a token at https://console.apify.com/account/integrations and set it as the APIFY_TOKEN environment variable." }] };
  }

  const headers = {
    Authorization: `Bearer ${APIFY_TOKEN}`,
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
  };

  const httpError = async (response: Response): Promise<string> => {
    let detail = "";
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      if (body?.error?.message) detail = ` ${body.error.message}`;
    } catch {
      detail = "";
    }
    switch (response.status) {
      case 400:
        return `The ${actorLabel} run was rejected as invalid input.${detail}`;
      case 401:
        return "Invalid Apify token. Check your APIFY_TOKEN environment variable.";
      case 402:
        return "Insufficient Apify credits. Check your account balance at https://console.apify.com/billing";
      default:
        return `Apify request to ${actorLabel} failed with status ${response.status}.${detail}`;
    }
  };

  // 1. Start the run.
  let started: Response;
  try {
    started = await fetch(
      `https://api.apify.com/v2/acts/${actorPath}/runs?timeout=${ACTOR_RUN_TIMEOUT_SECS}`,
      { method: "POST", headers, body: JSON.stringify(input) },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `Could not reach the Apify API: ${message}` }] };
  }
  if (!started.ok) {
    return { isError: true, content: [{ type: "text", text: await httpError(started) }] };
  }

  let run: { id?: string; status?: string; defaultDatasetId?: string };
  try {
    run = ((await started.json()) as { data?: typeof run }).data ?? {};
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run start returned a response that could not be parsed: ${message}` }] };
  }
  const runId = run.id;
  if (!runId) {
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run start returned no run id, so there is nothing to wait for.` }] };
  }

  // 2. Poll to a terminal status.
  const deadline = Date.now() + WRAPPER_WAIT_MS;
  let status = run.status ?? "READY";
  let datasetId = run.defaultDatasetId;
  while (!TERMINAL.has(status)) {
    if (Date.now() >= deadline) {
      return {
        isError: true,
        content: [{ type: "text", text: `The ${actorLabel} run ${runId} was still ${status} after ${Math.round(WRAPPER_WAIT_MS / 1000)} seconds and this call stopped waiting. The run itself is still on Apify: read it at https://console.apify.com/actors/runs/${runId}` }],
      };
    }
    await sleep(POLL_INTERVAL_MS);
    let poll: Response;
    try {
      poll = await fetch(`https://api.apify.com/v2/actor-runs/${runId}`, { headers });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { isError: true, content: [{ type: "text", text: `Lost contact with the Apify API while waiting for ${actorLabel} run ${runId}: ${message}` }] };
    }
    if (!poll.ok) {
      return { isError: true, content: [{ type: "text", text: await httpError(poll) }] };
    }
    const body = (await poll.json()) as { data?: { status?: string; defaultDatasetId?: string } };
    status = body.data?.status ?? status;
    datasetId = body.data?.defaultDatasetId ?? datasetId;
  }

  // 3. A run that did not succeed is a failure the caller must see, never an
  // empty success. Surfacing it here is what keeps a crashed run from reading
  // as "no results found".
  if (status !== "SUCCEEDED") {
    return {
      isError: true,
      content: [{ type: "text", text: `The ${actorLabel} run did not succeed (run ID: ${runId}, status: ${status}).` }],
    };
  }
  if (!datasetId) {
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run ${runId} succeeded but reported no dataset, so there is nothing to return.` }] };
  }

  // 4. Read the dataset.
  let ds: Response;
  try {
    ds = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?format=json`, { headers });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `Could not read the ${actorLabel} dataset: ${message}` }] };
  }
  if (!ds.ok) {
    return { isError: true, content: [{ type: "text", text: await httpError(ds) }] };
  }

  let items: unknown;
  try {
    items = await ds.json();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run returned a response that could not be parsed: ${message}` }] };
  }

  if (!Array.isArray(items)) {
    const asObj = items as { error?: { type?: string; message?: string } };
    const detail = asObj?.error?.message
      ? `${asObj.error.message}`
      : JSON.stringify(items);
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run did not return a dataset. ${detail}` }] };
  }

  return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
}

const server = new McpServer({
  name: "mamba-account-hiring-watch",
  version: pkg.version,
});

// Account Hiring Watch (immutable actor ID gRAZA5WBi1r6L0gy7). Every buyer facing input of the live actor
// is exposed. The actor takes numbers as strings, so numeric inputs are strings here too.
server.registerTool(
  "watch_account_hiring",
  {
    title: "Watch account hiring",
    description:
      "Watch a list of company domains and get back only what changed on their job boards since the last run with the same watch name: new, closed, and reposted postings, read live from 17 job boards including Greenhouse, Lever, Ashby, and Workday. Each change row carries the full job description, a stable posting key, and the board it came from; each company also gets a summary row with open postings and 30 day hiring velocity. The first run for a watch sets the baseline, and its rows are marked is_backfill and never charged. Optional signed webhook delivery. A run that does not succeed is returned as an error with its run ID. Read-only on the boards; requires an APIFY_TOKEN and consumes Apify credits per change returned.",
    annotations: {
      title: "Watch account hiring",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      domains: z.array(z.string())
        .describe("Company website domains to watch, for example stripe.com. The watch reads each company's own job board. Up to 2,000 per run."),
      watch_name: z.string()
        .optional()
        .describe("Keeps separate watch lists apart. Use one name per list or client. Changing the name starts a new watch, and its first run sets the baseline. Default default."),
      keyword_categories: z.array(z.enum(["All", "GTM", "Engineering", "Finance", "Operations", "Executive", "Marketing", "HR", "CustomerSuccess", "Data", "Product", "Legal", "Design", "Custom"]))
        .optional()
        .describe("Only changes to postings whose title matches these role categories are returned and charged. All returns every posting change. Every posting still counts toward hiring velocity. Default [\"All\"]."),
      custom_keywords: z.array(z.string())
        .optional()
        .describe("Extra title keywords, matched on whole words. Prefix with T1: for the strongest tier or T3: for the weakest; no prefix is tier 2. Adding any keyword also adds the Custom category."),
      board_hints: z.array(z.string())
        .optional()
        .describe("Point a domain at its job board when the watch cannot find it, as domain=provider:slug, for example acme.com=greenhouse:acmeinc or acme.com=workday:acme.wd5/External. Providers: greenhouse, lever, ashby, workable, smartrecruiters, personio, recruitee, workday, rippling."),
      first_run_mode: z.enum(["recent", "baseline_only", "all_open"])
        .optional()
        .describe("What a domain's first run returns. recent returns postings the board dates inside the last N days, baseline_only returns the summary row, all_open returns every open posting. First run rows are marked is_backfill and never charged. Default recent."),
      first_run_recent_days: z.string()
        .optional()
        .describe("With first_run_mode recent: how many days back counts as recent. 1 to 30. Default 7."),
      closed_after_misses: z.string()
        .optional()
        .describe("A posting closes after this many complete board reads without it. A partial read never counts. 1 to 5. Default 2."),
      repost_window_days: z.string()
        .optional()
        .describe("A closed posting that comes back inside this many days is reported as reposted, not new. 7 to 60. Default 30."),
      include_job_description: z.enum(["true", "false"])
        .optional()
        .describe("Adds the full description text to new and reposted rows. Closed rows carry no description. Default true."),
      description_max_chars: z.string()
        .optional()
        .describe("Longest description kept per row. job_description_chars always reports the full length. 500 to 100000. Default 20000."),
      webhook_url: z.string()
        .optional()
        .describe("Optional HTTPS endpoint. Changes are sent as signed Standard Webhooks requests, and a change is charged only after your endpoint answers 2xx."),
      webhook_secret: z.string()
        .optional()
        .describe("Required with webhook_url. Signs each request (HMAC SHA256). A whsec_ prefixed secret is base64 decoded per the Standard Webhooks spec."),
      webhook_batch_mode: z.enum(["batch", "per_change"])
        .optional()
        .describe("batch sends up to 50 changes per request, grouped by company. per_change sends one request per change, for tools where one request is one row (Clay table webhooks, Zapier). Default batch."),
      state_store: z.string()
        .optional()
        .describe("Optional key value store that holds the watch state. Leave empty to use the store account-hiring-watch-state in your own Apify account."),
      max_domains: z.string()
        .optional()
        .describe("Domains past this number are skipped. 1 to 2000. Default 500."),
      max_charge_usd: z.string()
        .optional()
        .describe("Optional. When the next change would take this run's charges over this amount, the remaining changes are held and delivered first on the next run."),
    },
  },
  async (args) => runActor("gRAZA5WBi1r6L0gy7", "Account Hiring Watch", compact(args as Record<string, unknown>)),
);

const transport = new StdioServerTransport();
await server.connect(transport);
