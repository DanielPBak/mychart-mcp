#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { timingSafeEqual } from "node:crypto";
import { closeBrowser } from "./browser.js";
import { registerTools } from "./tools.js";

function createServer() {
  const server = new McpServer({ name: "mychart", version: "0.1.0" });
  registerTools(server);
  return server;
}

async function runStdio() {
  await createServer().connect(new StdioServerTransport());
}

/** Streamable HTTP for remote/cloud agents. Requires a bearer token: this server can read your medical records. */
async function runHttp() {
  const token = process.env.MCP_AUTH_TOKEN;
  if (!token || token.length < 24) {
    console.error("HTTP mode requires MCP_AUTH_TOKEN (at least 24 chars). Generate one with: openssl rand -hex 32");
    process.exit(1);
  }
  const expected = Buffer.from(`Bearer ${token}`);
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/mcp", (req, res, next) => {
    const got = Buffer.from(req.headers.authorization ?? "");
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  });
  app.post("/mcp", async (req, res) => {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  app.all("/mcp", (_req, res) => {
    res.status(405).set("Allow", "POST").send();
  });
  const port = Number(process.env.PORT ?? 8787);
  app.listen(port, () => console.error(`mychart-mcp listening on http://localhost:${port}/mcp`));
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    await closeBrowser().catch(() => {});
    process.exit(0);
  });
}

await (process.argv.includes("--http") ? runHttp() : runStdio());
