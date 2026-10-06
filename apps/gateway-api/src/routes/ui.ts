import { readFileSync } from "node:fs";
import { join } from "node:path";
import { APPROVAL_UI_DIR } from "@agentroute/approval-ui";
import type { App } from "../types.js";

const FILES = {
  "index.html": "text/html; charset=utf-8",
  "app.js": "text/javascript; charset=utf-8",
  "styles.css": "text/css; charset=utf-8",
} as const;

/** Strict CSP: only same-origin scripts, styles and API calls; no framing. */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

export function registerUiRoutes(app: App): void {
  // Read once at startup: a fixed allow-list of files, so no path traversal is possible.
  const contents = new Map(
    Object.keys(FILES).map((name) => [name, readFileSync(join(APPROVAL_UI_DIR, name))] as const),
  );

  const serve = (name: keyof typeof FILES) => (_request: unknown, reply: import("fastify").FastifyReply) =>
    reply
      .header("content-security-policy", CSP)
      .header("x-frame-options", "DENY")
      .header("cache-control", "no-cache")
      .type(FILES[name])
      .send(contents.get(name));

  app.get("/ui", (_request, reply) => reply.redirect("/ui/"));
  app.get("/ui/", serve("index.html"));
  app.get("/ui/app.js", serve("app.js"));
  app.get("/ui/styles.css", serve("styles.css"));
}
