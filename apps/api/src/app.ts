import { readFileSync } from "node:fs";
import path from "node:path";
import express, { type ErrorRequestHandler, type RequestHandler } from "express";
import type pg from "pg";
import { raiseAlert, type AlertFn } from "./alerts.ts";
import { CALL_PAGE_CSP, callPageMessageHtml } from "./core/call-page.ts";
import type { OutboundPolicy } from "./core/outbound-allowlist.ts";
import { SERVER_ERRORS_PER_WINDOW, Spike } from "./core/spike.ts";
import { lastHeartbeat, workerState } from "./db/worker-heartbeat.ts";
import type { EnqueueNotifications } from "./jobs/enqueue-notifications.ts";
import type { EnqueueOnboarding } from "./jobs/onboarding.ts";
import { logger } from "./logger.ts";
import type { TelephonyProvider } from "./providers/telephony.ts";
import type { CallEndedEvent, FunctionCallEvent, VoiceProvider } from "./providers/voice.ts";
import { callPageRouter } from "./routes/calls.ts";
import { dashboardRouter, type DashboardOptions } from "./routes/dashboard.ts";
import { paymentsWebhookRouter, type PaymentsWebhookOptions } from "./routes/payments-webhook.ts";
import { postmarkRouter } from "./routes/postmark.ts";
import { signupRouter } from "./routes/signup.ts";
import { twilioRouter } from "./routes/twilio.ts";
import { voiceWebhookRouter } from "./routes/webhooks.ts";

export interface AppOptions {
  pool: pg.Pool;
  /** The logged-in dashboard API (/api). Absent until a login provider is configured (decision 012). */
  dashboard?: Omit<DashboardOptions, "pool"> | undefined;
  /** Postmark's bounce and complaint webhook. Absent until POSTMARK_WEBHOOK_SECRET is configured. */
  postmark?: { webhookSecret: string; alert?: AlertFn } | undefined;
  /** The payments provider's webhook (Step 12). Absent until GoCardless is configured. */
  payments?: Omit<PaymentsWebhookOptions, "pool"> | undefined;
  /** The signed call pages (/c/:token). Absent until SIGNING_SECRET is configured. */
  callPages?:
    | {
        signingSecret: string;
        telephony?: TelephonyProvider | undefined;
        voice?: VoiceProvider | undefined;
        /** Where an expired link's page points: the dashboard. */
        dashboardOrigin?: string | undefined;
        now?: () => Date;
      }
    | undefined;
  /**
   * The built dashboard (apps/web/dist), served at / in production so the dashboard and /api
   * share one address (BUILD_PLAN Step 8). Absent in development, where Vite serves it.
   */
  dashboardDist?: string | undefined;
  /**
   * While the API moves address (ALTERNATE_BASE_URL): a dashboard page asked for at the old
   * host is sent on to the dashboard's own address, the only one its logins work at.
   */
  moveDashboard?: { fromHost: string; toOrigin: string } | undefined;
  voiceProviders?: Record<string, VoiceProvider>;
  onCallEnded?: (event: CallEndedEvent) => Promise<void>;
  /** A mid-call emergency function fired (Step 6). */
  onFunctionCall?: (event: FunctionCallEvent) => Promise<unknown>;
  /** For the app's own alerts: a run of 500s, and the voice webhook's refused signatures. */
  alert?: AlertFn;
  now?: () => Date;
  /** Call routing. Absent until Twilio and PUBLIC_BASE_URL are configured. */
  telephony?:
    | {
        provider: TelephonyProvider;
        voice: VoiceProvider;
        publicBaseUrl: string;
        /** The other address Twilio's signatures are accepted for, while the API moves. */
        alternateBaseUrl?: string | undefined;
        outbound: OutboundPolicy;
        enqueueSync: (job: { tenantId: string; profileVersion: number }) => Promise<unknown>;
        enqueueNotifications: EnqueueNotifications;
        enqueueOnboarding?: EnqueueOnboarding;
        alert?: AlertFn;
        now?: () => Date;
        /** How long the voice platform gets to take a call, and routing to answer at all. */
        registerTimeoutMs?: number;
        deadlineMs?: number;
      }
    | undefined;
}

export function createApp({
  pool,
  dashboardDist,
  moveDashboard,
  voiceProviders = {},
  onCallEnded = () => Promise.resolve(),
  onFunctionCall,
  alert = raiseAlert,
  now = () => new Date(),
  telephony,
  callPages,
  postmark,
  payments,
  dashboard,
}: AppOptions) {
  const app = express();
  app.disable("x-powered-by");
  app.use(securityHeaders);

  // Liveness: answers whenever the process can. It deliberately checks nothing else, so a
  // database outage never makes Azure restart containers that are otherwise healthy.
  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  // The worker's check-in, for an availability alert (Step 8): 503 once it has missed four.
  // The API can be fine while the worker is down, so this stays out of /healthz and /readyz,
  // which decide whether Azure restarts or routes to this API instance.
  app.get("/healthz/worker", async (_req, res) => {
    try {
      const worker = workerState(await lastHeartbeat(pool), new Date());
      res.status(worker.state === "running" ? 200 : 503).json({
        status: worker.state,
        lastSeen: worker.state === "never" ? null : worker.seenAt.toISOString(),
      });
    } catch (error) {
      logger.warn("Worker check-in lookup failed", { error });
      res.status(503).json({ status: "unknown", lastSeen: null });
    }
  });

  // Readiness: can this instance do useful work? A 503 tells the load balancer to stop
  // sending traffic here until the database is reachable again.
  app.get("/readyz", async (_req, res) => {
    try {
      await pool.query("SELECT 1");
      res.json({ status: "ready" });
    } catch (error) {
      logger.warn("Readiness check failed", { error });
      res.status(503).json({ status: "unavailable" });
    }
  });

  app.use(
    "/webhooks",
    voiceWebhookRouter({
      providers: voiceProviders,
      onCallEnded,
      ...(onFunctionCall && { onFunctionCall }),
      alert,
      now,
    }),
  );
  if (telephony) {
    app.use(
      "/webhooks/twilio",
      twilioRouter({ pool, telephony: telephony.provider, ...telephony }),
    );
  }

  if (postmark) app.use("/webhooks/postmark", postmarkRouter({ pool, ...postmark }));
  if (payments) {
    app.use("/webhooks/gocardless", paymentsWebhookRouter({ pool, alert, now, ...payments }));
  }
  if (callPages) app.use("/c", callPageRouter({ pool, ...callPages }));
  if (dashboard) {
    // First: following a signup link needs a login but no account, so it can't sit behind the
    // dashboard's account check.
    app.use(
      "/api/signup",
      signupRouter({
        admin: dashboard.admin,
        auth: dashboard.auth,
        ...(dashboard.now && { now: dashboard.now }),
      }),
    );
    app.use("/api", dashboardRouter({ pool, ...dashboard }));
  }

  if (dashboardDist) serveDashboard(app, dashboardDist, moveDashboard);

  // Last: Express's own handler prints the stack with console.error, unredacted, and shows
  // it to the client outside production. Log through the redacting logger instead, and
  // give the client nothing.
  // A 500 is always a bug or an outage; a run of them within a window is worth an alert.
  const serverErrors = new Spike({ limit: SERVER_ERRORS_PER_WINDOW });
  const onError: ErrorRequestHandler = (error: unknown, req, res, next) => {
    // A response already on its way (the voice route answers from a timer while its work may
    // still fail) can't carry an error; writing to it would only raise a second one that
    // buries this. Log it, and let Express close the connection.
    if (res.headersSent) {
      logger.error("Request failed after its response was sent", {
        error,
        method: req.method,
        path: req.path,
      });
      next(error);
      return;
    }
    // A person on the page behind a text's link gets a page saying so, not JSON.
    const reply = (code: number, body: { error: string }) => {
      if (callPages && req.path.startsWith("/c/") && req.accepts(["json", "html"]) === "html") {
        res.setHeader("Content-Security-Policy", CALL_PAGE_CSP);
        res.status(code).type("html").send(callPageMessageHtml("error", callPages.dashboardOrigin));
        return;
      }
      res.status(code).json(body);
    };
    // Express's body parser marks what it refuses (malformed JSON, too large) with a 4xx
    // status and a type: that's a bad request, not a fault here.
    const { status, type } = (error ?? {}) as { status?: unknown; type?: unknown };
    if (typeof status === "number" && status >= 400 && status < 500 && typeof type === "string") {
      logger.warn("Refused a request body", { method: req.method, path: req.path, type });
      reply(status, { error: "Bad request" });
      return;
    }
    logger.error("Unhandled request error", { error, method: req.method, path: req.path });
    if (serverErrors.record(now())) {
      alert("server-error-spike", { inWindow: serverErrors.count, lastPath: req.path });
    }
    reply(500, { error: "Internal server error" });
  };
  app.use(onError);

  return app;
}

/**
 * Browser protections on every response. Nothing here may be shown inside another site's
 * frame (a page that could trick someone into clicking on the dashboard or a call page), a
 * browser must take each file's declared type at its word (never sniff a recording or an
 * upload into HTML), only the site's own address is passed on as a referrer (a call-page
 * link in a referrer would be a leak; /c/* already sends none), and once a browser has seen
 * the site over HTTPS it stays on it for a year. Browsers ignore that last one over plain
 * HTTP, so it's harmless on a laptop.
 */
const securityHeaders: RequestHandler = (_req, res, next) => {
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Strict-Transport-Security", "max-age=31536000");
  next();
};

/** Paths that belong to the API, never to the dashboard: an unknown one stays a 404. */
const API_PATHS = /^\/(?:api|webhooks|c|healthz|readyz)(?:\/|$)/;

/**
 * The dashboard's files, and its page for every other GET (its own routes, such as
 * /tenants/:id, are handled in the browser). The page itself is never cached, so a deploy
 * shows at once; Vite gives every other file a name that changes with its contents, so those
 * can be cached for a year.
 *
 * With `move`, the page carries a line of script that sends a browser on the old host to the
 * same path at the new address. In the browser rather than a redirect here, because the browser
 * knows which address it's really on: Microsoft's docs don't say whether Azure's ingress passes
 * the Host header through unchanged, and a server-side check that misread it could loop.
 * Health checks, webhooks and the call pages in texts already sent aren't pages, so they keep
 * answering at both addresses.
 */
function serveDashboard(
  app: express.Express,
  dist: string,
  move?: { fromHost: string; toOrigin: string },
): void {
  const page = path.join(dist, "index.html");
  // Never from an address to itself, which would reload forever.
  const movedPage =
    move && move.fromHost.toLowerCase() !== new URL(move.toOrigin).host.toLowerCase()
      ? pageThatMoves(page, move)
      : undefined;
  app.use(
    express.static(dist, {
      index: false,
      setHeaders: (res, file) => {
        res.setHeader(
          "Cache-Control",
          file.endsWith(".html") ? "no-cache" : "public, max-age=31536000, immutable",
        );
      },
    }),
  );
  app.use((req, res, next) => {
    if ((req.method !== "GET" && req.method !== "HEAD") || API_PATHS.test(req.path)) {
      next();
      return;
    }
    res.setHeader("Cache-Control", "no-cache");
    const moved = movedPage?.();
    if (moved) res.type("html").send(moved);
    else res.sendFile(page);
  });
}

/**
 * The dashboard's page with the move in its head, read once on first use. Unreadable (the page
 * missing), it answers undefined and the plain file is sent, which fails as it always has. The
 * script sits inline, which the security headers allow (they only forbid framing); a policy
 * limiting scripts later would have to allow it.
 */
function pageThatMoves(
  page: string,
  { fromHost, toOrigin }: { fromHost: string; toOrigin: string },
): () => string | undefined {
  let html: string | undefined;
  return () => {
    if (html === undefined) {
      try {
        html = readFileSync(page, "utf8");
      } catch {
        return undefined;
      }
      // Host names and origins can't hold "<", so JSON is safe inside the script tag.
      const script =
        `<script>if (location.host.toLowerCase() === ${JSON.stringify(fromHost.toLowerCase())}) ` +
        `location.replace(${JSON.stringify(toOrigin)} + location.pathname + location.search + location.hash)</script>`;
      // In the head; failing that, after the doctype, since anything before it puts the
      // browser in quirks mode.
      const doctype = /^\s*<!doctype[^>]*>/i.exec(html)?.[0] ?? "";
      html = html.includes("</head>")
        ? html.replace("</head>", () => `${script}</head>`)
        : `${doctype}${script}${html.slice(doctype.length)}`;
    }
    return html;
  };
}
