import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Page } from "playwright";
import {
  byRef,
  clickFirst,
  config,
  detectState,
  ensureLoggedIn,
  getPage,
  goto,
  login,
  settle,
  snapshot,
  submitCode,
  url,
} from "./browser.js";

// Message-center paths differ between MyChart versions; try the modern one first.
const INBOX_PATHS = ["/app/communication-center", "/Messaging/Inbox", "/inside.asp?mode=inbox"];

// The browser is a single shared page, so tool calls must not interleave.
let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

type ToolResult = { content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>; isError?: boolean };

function json(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function handler<A>(fn: (args: A) => Promise<ToolResult>) {
  return (args: A) =>
    serialized(async () => {
      try {
        return await fn(args);
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    });
}

async function pageReport(p: Page, opts: { linksMatching?: RegExp; maxText?: number } = {}) {
  const snap = await snapshot(p, opts.maxText);
  if (opts.linksMatching) {
    const matching = snap.elements.filter((e) => (e.href && opts.linksMatching!.test(e.href)) || e.role === "button");
    if (matching.length) snap.elements = matching;
  }
  return snap;
}

async function findTextbox(p: Page) {
  const box = p.locator('textarea, [contenteditable="true"], [role="textbox"]').filter({ visible: true }).last();
  if (!(await box.count())) throw new Error("No message text box found. Use mychart_snapshot to inspect the page.");
  return box;
}

export function registerTools(server: McpServer) {
  // ---------- Session ----------

  server.registerTool(
    "mychart_status",
    {
      description: "Check whether the MyChart session is logged in, waiting on 2FA, or logged out.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    handler(async () => {
      const p = await getPage();
      if (p.url() === "about:blank") await goto("/Home");
      return json({ state: await detectState(p), url: p.url(), portal: config.baseUrl });
    }),
  );

  server.registerTool(
    "mychart_login",
    {
      description:
        "Log in to MyChart. Uses MYCHART_USERNAME/MYCHART_PASSWORD from the environment unless given. " +
        "If it returns state 'verification', MyChart wants a 2FA code: inspect the page with mychart_snapshot, " +
        "pick the delivery method with mychart_click, ask the user for the code, then call mychart_submit_code.",
      inputSchema: {
        username: z.string().optional(),
        password: z.string().optional(),
      },
    },
    handler(async ({ username, password }: { username?: string; password?: string }) => {
      const state = await login(username, password);
      const p = await getPage();
      return json({ state, url: p.url(), ...(state !== "logged_in" ? { page: await pageReport(p, { maxText: 2000 }) } : {}) });
    }),
  );

  server.registerTool(
    "mychart_submit_code",
    {
      description: "Enter a 2FA verification code on the MyChart verification page (also ticks 'trust this device' if offered).",
      inputSchema: { code: z.string().min(4).max(12) },
    },
    handler(async ({ code }: { code: string }) => {
      const state = await submitCode(code);
      const p = await getPage();
      return json({ state, url: p.url(), ...(state !== "logged_in" ? { page: await pageReport(p, { maxText: 2000 }) } : {}) });
    }),
  );

  // ---------- Messages ----------

  server.registerTool(
    "mychart_list_messages",
    {
      description:
        "Open the MyChart message center and return the visible conversations (text plus element refs/links). " +
        "Open one with mychart_open_message.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    handler(async () => {
      await ensureLoggedIn();
      let p: Page | undefined;
      for (const path of INBOX_PATHS) {
        p = await goto(path);
        const text = await p.locator("body").innerText().catch(() => "");
        if (!/page (could not be|not) found|404/i.test(text) && (await detectState(p)) === "logged_in") break;
      }
      return json(await pageReport(p!, { linksMatching: /conversation|message|communication/i }));
    }),
  );

  server.registerTool(
    "mychart_open_message",
    {
      description:
        "Open a conversation and return its full text. Pass either `ref` (from the latest list/snapshot) or `href` (a MyChart link).",
      inputSchema: {
        ref: z.string().optional(),
        href: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    handler(async ({ ref, href }: { ref?: string; href?: string }) => {
      let p = await ensureLoggedIn();
      if (href) p = await goto(href);
      else if (ref) {
        await byRef(p, ref).click();
        await settle(p);
      } else throw new Error("Pass ref or href.");
      return json(await pageReport(p, { maxText: 15000 }));
    }),
  );

  server.registerTool(
    "mychart_reply",
    {
      description:
        "Reply to the conversation that is currently open (open it first with mychart_open_message, or pass its href). " +
        "With dry_run=true (default) the reply is typed but NOT sent, so you can confirm with the user first; " +
        "then call again with dry_run=false to send.",
      inputSchema: {
        body: z.string().min(1).max(5000),
        href: z.string().optional(),
        dry_run: z.boolean().default(true),
      },
      annotations: { destructiveHint: true },
    },
    handler(async ({ body, href, dry_run }: { body: string; href?: string; dry_run: boolean }) => {
      let p = await ensureLoggedIn();
      if (href) p = await goto(href);
      const box = p.locator('textarea, [contenteditable="true"], [role="textbox"]').filter({ visible: true });
      if (!(await box.count())) {
        await clickFirst(p, [p.getByRole("button", { name: /^reply/i }), p.getByRole("link", { name: /^reply/i })]);
        await settle(p);
      }
      const textbox = await findTextbox(p);
      await textbox.fill(body);
      if (dry_run) {
        return json({ sent: false, note: "Draft typed but not sent. Call again with dry_run=false to send.", page: await pageReport(p, { maxText: 3000 }) });
      }
      await clickFirst(p, [p.getByRole("button", { name: /^send/i })]);
      await settle(p);
      return json({ sent: true, page: await pageReport(p, { maxText: 3000 }) });
    }),
  );

  server.registerTool(
    "mychart_start_new_message",
    {
      description:
        "Start a NEW message to a care team (MyChart's 'Ask a question' / 'New message' flow) and return the first step. " +
        "The flow is a multi-step wizard (message type, recipient, subject, body) that varies by health system; " +
        "walk it with mychart_snapshot, mychart_click, mychart_fill and mychart_select. " +
        "Always confirm recipient, subject and body with the user before clicking the final Send button.",
      inputSchema: {},
    },
    handler(async () => {
      await ensureLoggedIn();
      let p: Page | undefined;
      for (const path of INBOX_PATHS) {
        p = await goto(path);
        if ((await detectState(p)) === "logged_in") break;
      }
      await clickFirst(p!, [
        p!.getByRole("button", { name: /new message|ask a question|send a message|compose/i }),
        p!.getByRole("link", { name: /new message|ask a question|send a message|compose/i }),
      ]);
      await settle(p!);
      return json(await pageReport(p!));
    }),
  );

  // ---------- Generic page control (escape hatch for anything the canned tools don't cover) ----------

  server.registerTool(
    "mychart_navigate",
    {
      description: `Go to a MyChart page by path (relative to ${config.baseUrl}) or full URL on the same site, and return a snapshot.`,
      inputSchema: { path: z.string() },
    },
    handler(async ({ path }: { path: string }) => {
      url(path); // validates origin
      await ensureLoggedIn();
      return json(await pageReport(await goto(path)));
    }),
  );

  server.registerTool(
    "mychart_snapshot",
    {
      description:
        "Return the current page's URL, visible text, and a numbered list of interactive elements (ref, role, name). " +
        "Refs are valid until the next snapshot or page change.",
      inputSchema: { max_text: z.number().int().min(500).max(50000).default(6000) },
      annotations: { readOnlyHint: true },
    },
    handler(async ({ max_text }: { max_text: number }) => json(await pageReport(await getPage(), { maxText: max_text }))),
  );

  server.registerTool(
    "mychart_click",
    {
      description:
        "Click an element by ref from the latest snapshot, then return a fresh snapshot. " +
        "If this click could send a message or submit a form, confirm with the user first.",
      inputSchema: { ref: z.string() },
      annotations: { destructiveHint: true },
    },
    handler(async ({ ref }: { ref: string }) => {
      const p = await getPage();
      await byRef(p, ref).click();
      await settle(p);
      return json(await pageReport(p));
    }),
  );

  server.registerTool(
    "mychart_fill",
    {
      description: "Type text into an input/textarea by ref from the latest snapshot (replaces existing text).",
      inputSchema: { ref: z.string(), text: z.string().max(5000) },
    },
    handler(async ({ ref, text }: { ref: string; text: string }) => {
      const p = await getPage();
      await byRef(p, ref).fill(text);
      return json({ ok: true });
    }),
  );

  server.registerTool(
    "mychart_select",
    {
      description: "Choose an option in a <select> dropdown by ref, matching the option's visible label.",
      inputSchema: { ref: z.string(), option: z.string() },
    },
    handler(async ({ ref, option }: { ref: string; option: string }) => {
      const p = await getPage();
      await byRef(p, ref).selectOption({ label: option });
      await settle(p);
      return json(await pageReport(p));
    }),
  );

  server.registerTool(
    "mychart_screenshot",
    {
      description: "Take a screenshot of the current MyChart page (useful when the text snapshot is ambiguous).",
      inputSchema: { full_page: z.boolean().default(false) },
      annotations: { readOnlyHint: true },
    },
    handler(async ({ full_page }: { full_page: boolean }) => {
      const p = await getPage();
      const data = (await p.screenshot({ fullPage: full_page, type: "png" })).toString("base64");
      return { content: [{ type: "image" as const, data, mimeType: "image/png" }] };
    }),
  );
}
