import { chromium, type BrowserContext, type Locator, type Page } from "playwright";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

export const config = {
  baseUrl: (process.env.MYCHART_BASE_URL ?? "https://mychart.nyulmc.org/mychart").replace(/\/+$/, ""),
  username: process.env.MYCHART_USERNAME,
  password: process.env.MYCHART_PASSWORD,
  profileDir: resolve(process.env.MYCHART_PROFILE_DIR ?? "./profile"),
  headless: process.env.MYCHART_HEADLESS !== "false",
  chromiumPath: process.env.MYCHART_CHROMIUM_PATH,
};

let context: BrowserContext | undefined;
let page: Page | undefined;

/** One persistent browser profile, so cookies and "trust this device" survive restarts. */
export async function getPage(): Promise<Page> {
  if (page && !page.isClosed()) return page;
  if (!context) {
    mkdirSync(config.profileDir, { recursive: true });
    context = await chromium.launchPersistentContext(config.profileDir, {
      headless: config.headless,
      executablePath: config.chromiumPath,
      viewport: { width: 1280, height: 900 },
    });
    context.on("close", () => {
      context = undefined;
      page = undefined;
    });
  }
  page = context.pages()[0] ?? (await context.newPage());
  page.setDefaultTimeout(20_000);
  return page;
}

export async function closeBrowser() {
  await context?.close();
}

export function url(path: string): string {
  if (/^https?:\/\//.test(path)) {
    const target = new URL(path);
    if (target.origin !== new URL(config.baseUrl).origin) {
      throw new Error(`Refusing to navigate outside MyChart (${target.origin})`);
    }
    return path;
  }
  return config.baseUrl + (path.startsWith("/") ? path : "/" + path);
}

export async function goto(path: string): Promise<Page> {
  const p = await getPage();
  await p.goto(url(path), { waitUntil: "domcontentloaded" });
  await settle(p);
  return p;
}

/** MyChart pages render client-side; wait for the network to quiet down, but don't hang on long-polls. */
export async function settle(p: Page) {
  await p.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
}

export type LoginState = "logged_in" | "login_form" | "verification" | "unknown";

export async function detectState(p: Page): Promise<LoginState> {
  const u = p.url();
  if (await p.locator("#Login").isVisible().catch(() => false)) return "login_form";
  const text = (await p.locator("body").innerText().catch(() => "")).slice(0, 4000);
  if (/verif(y|ication)|one-time|security code|send (me )?a code|enter the code/i.test(text)) return "verification";
  if (/\/(Home|app\/|inside\.asp)/i.test(u) || /log ?out|sign ?out/i.test(text)) return "logged_in";
  return "unknown";
}

/** Fill the login form. Returns the resulting state (may be "verification" if 2FA is required). */
export async function login(username?: string, password?: string): Promise<LoginState> {
  const user = username ?? config.username;
  const pass = password ?? config.password;
  if (!user || !pass) throw new Error("No credentials: set MYCHART_USERNAME/MYCHART_PASSWORD or pass them to the tool.");
  const p = await goto("/Authentication/Login");
  if ((await detectState(p)) === "logged_in") return "logged_in";
  await p.locator("#Login").fill(user);
  await p.locator("#Password").fill(pass);
  await p.locator("#submit").click();
  await p.waitForURL((u) => !/Authentication\/Login\/?$/i.test(u.pathname), { timeout: 20_000 }).catch(() => {});
  await settle(p);
  const state = await detectState(p);
  if (state === "login_form") {
    const err = await p.locator("#errorMessage, .errorMessage, [role=alert]").first().innerText().catch(() => "");
    throw new Error(`Login failed${err ? `: ${err.trim()}` : ""}`);
  }
  return state;
}

/** Ensure we have a live session, re-logging in with stored credentials if it expired. */
export async function ensureLoggedIn(): Promise<Page> {
  const p = await getPage();
  if (p.url() === "about:blank") await goto("/Home");
  let state = await detectState(p);
  if (state === "unknown") {
    await goto("/Home");
    state = await detectState(p);
  }
  if (state === "logged_in") return p;
  if (state === "login_form" && config.username && config.password) {
    state = await login();
    if (state === "logged_in" || state === "unknown") return p;
  }
  if (state === "verification") {
    throw new Error("MyChart is asking for a verification code. Use mychart_snapshot to see the options, then mychart_submit_code.");
  }
  throw new Error("Not logged in to MyChart. Call mychart_login first.");
}

/** Enter a 2FA code and tick "trust this device" when offered. */
export async function submitCode(code: string): Promise<LoginState> {
  const p = await getPage();
  const input = p
    .locator(
      'input[autocomplete="one-time-code"], input[name*="code" i], input[id*="code" i], input[type="tel"], input[inputmode="numeric"]',
    )
    .filter({ visible: true })
    .first();
  await input.fill(code);
  const trust = p.getByLabel(/trust|remember|don't ask/i).filter({ visible: true }).first();
  if (await trust.count()) await trust.check().catch(() => {});
  await clickFirst(p, [p.getByRole("button", { name: /verify|submit|continue|next|sign in/i })]);
  await p.waitForLoadState("domcontentloaded").catch(() => {});
  await settle(p);
  return detectState(p);
}

export async function clickFirst(p: Page, candidates: Locator[]) {
  for (const c of candidates) {
    const visible = c.filter({ visible: true }).first();
    if (await visible.count()) {
      await visible.click();
      return;
    }
  }
  throw new Error("Could not find the expected button on the page. Use mychart_snapshot to inspect it.");
}

export interface ElementRef {
  ref: string;
  role: string;
  name: string;
  value?: string;
  href?: string;
  checked?: boolean;
}

/**
 * Tag every visible interactive element with a data-mcp-ref attribute and return a compact list,
 * plus the page's visible text. This is what lets Claude drive pages the canned tools don't cover.
 */
export async function snapshot(p: Page, maxText = 6000): Promise<{ url: string; title: string; text: string; elements: ElementRef[] }> {
  const elements = await p.evaluate(() => {
    const sel =
      'a[href], button, input:not([type=hidden]), textarea, select, [role=button], [role=link], [role=tab], [role=option], [role=menuitem], [role=checkbox], [role=radio], [contenteditable=true]';
    const out: Array<Record<string, unknown>> = [];
    let n = 0;
    document.querySelectorAll("[data-mcp-ref]").forEach((el) => el.removeAttribute("data-mcp-ref"));
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (!rect.width || !rect.height || style.visibility === "hidden" || style.display === "none") continue;
      const ref = String(++n);
      el.setAttribute("data-mcp-ref", ref);
      const input = el as HTMLInputElement;
      const labelled =
        el.getAttribute("aria-label") ||
        (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent) ||
        el.closest("label")?.textContent ||
        input.placeholder ||
        el.title ||
        el.innerText ||
        input.value ||
        el.getAttribute("name") ||
        "";
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute("role") || (tag === "input" ? `input:${input.type}` : tag);
      const entry: Record<string, unknown> = { ref, role, name: labelled.replace(/\s+/g, " ").trim().slice(0, 120) };
      if (tag === "input" || tag === "textarea" || tag === "select") {
        if (input.type === "checkbox" || input.type === "radio") entry.checked = input.checked;
        else if (input.type !== "password" && input.value) entry.value = input.value.slice(0, 120);
      }
      if (tag === "a") entry.href = (el as HTMLAnchorElement).getAttribute("href") ?? undefined;
      out.push(entry);
    }
    return out;
  });
  const text = (await p.locator("body").innerText().catch(() => "")).replace(/\n{3,}/g, "\n\n").trim();
  return {
    url: p.url(),
    title: await p.title(),
    text: text.length > maxText ? text.slice(0, maxText) + "\n…[truncated]" : text,
    elements: elements as unknown as ElementRef[],
  };
}

export function byRef(p: Page, ref: string): Locator {
  return p.locator(`[data-mcp-ref="${ref.replace(/"/g, "")}"]`);
}
