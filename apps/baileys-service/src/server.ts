import express from "express";
import { logger } from "./logger.js";
import { config } from "./config.js";
import { NormalizedIncomingMessage } from "./types.js";
import {
  createSelfieLinkPayload,
  initialOnboardingState,
  processOnboardingMessage,
  runOcrExtract,
  SessionRecord,
} from "./onboarding.js";

const FALLBACK_REPLY =
  "Meow! Thanks for your message. I am currently being built and will be up and running soon.";
const webhookRateLimit = new Map<
  string,
  { count: number; windowStart: number }
>();

function isBackendConnectivityError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const text = [error.message, error.stack ?? ""].join(" ");
  return (
    text.includes("fetch failed") ||
    text.includes("ECONNREFUSED") ||
    text.includes("ENOTFOUND") ||
    text.includes("ETIMEDOUT")
  );
}

async function loadSession(userId: string): Promise<SessionRecord> {
  const response = await fetch(
    `${config.SESSION_API_URL}/session/${encodeURIComponent(userId)}`,
  );

  if (response.status === 404) {
    return { userId, step: 0, state: initialOnboardingState() };
  }

  if (!response.ok) {
    throw new Error(
      `session lookup failed: ${response.status} ${response.statusText}`,
    );
  }

  const data = (await response.json()) as {
    found: boolean;
    session?: SessionRecord;
  };
  return data.session ?? { userId, step: 0, state: initialOnboardingState() };
}

async function saveSession(session: SessionRecord): Promise<void> {
  const response = await fetch(
    `${config.SESSION_API_URL}/session/${encodeURIComponent(session.userId)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ step: session.step, state: session.state }),
    },
  );

  if (!response.ok) {
    throw new Error(
      `session save failed: ${response.status} ${response.statusText}`,
    );
  }
}

async function dedupeMessage(messageId: string): Promise<boolean> {
  const response = await fetch(
    `${config.SESSION_API_URL}/dedupe/${encodeURIComponent(messageId)}`,
    { method: "POST" },
  );

  if (!response.ok) {
    throw new Error(
      `dedupe check failed for message ${messageId}: ${response.status} ${response.statusText}`,
    );
  }

  const payload = (await response.json()) as { deduped: boolean };
  return payload.deduped;
}

function isWebhookAuthorized(req: express.Request): boolean {
  if (!config.WHATSAPP_WEBHOOK_SECRET) {
    return true;
  }

  const provided = req.header("x-webhook-secret");
  return provided === config.WHATSAPP_WEBHOOK_SECRET;
}

function isRateLimited(req: express.Request, key: string): boolean {
  const now = Date.now();
  const identifier = `${req.ip ?? "unknown"}:${key}`;
  const existing = webhookRateLimit.get(identifier);

  if (
    !existing ||
    now - existing.windowStart >= config.WEBHOOK_RATE_LIMIT_WINDOW_MS
  ) {
    webhookRateLimit.set(identifier, { count: 1, windowStart: now });
    return false;
  }

  if (existing.count >= config.WEBHOOK_RATE_LIMIT_MAX_REQUESTS) {
    return true;
  }

  existing.count += 1;
  webhookRateLimit.set(identifier, existing);
  return false;
}

function webhookGuardMiddleware(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  if (!isWebhookAuthorized(req)) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  const payload = req.body as Partial<NormalizedIncomingMessage> | undefined;
  const from = payload?.from ?? "unknown";
  if (isRateLimited(req, from)) {
    return res.status(429).json({ ok: false, error: "Rate limit exceeded" });
  }
  next();
}

function stepToNumber(step: string): number {
  const orderedSteps = [
    "ENTRY",
    "BUSINESS_NAME",
    "BUSINESS_DESCRIPTION",
    "BUSINESS_ADDRESS",
    "ID_DOCUMENT",
    "ID_CONFIRM",
    "RESIDENTIAL_ADDRESS",
    "BANK_DOCUMENT",
    "BANK_ACCOUNT_HOLDER",
    "BANK_CONFIRM",
    "SELFIE_WAIT",
    "COMPLETED",
    "TERMINAL",
  ];

  const index = orderedSteps.indexOf(step);
  return index >= 0 ? index : 0;
}

export function createServer(
  sendReplyToWhatsApp: (to: string, text: string) => Promise<void>,
) {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.post("/ocr/extract", async (req, res) => {
    try {
      const documentType = String(req.body?.documentType ?? "");
      if (documentType !== "SA_ID" && documentType !== "BANK_DOCUMENT") {
        return res.status(400).json({
          ok: false,
          error: "documentType must be SA_ID or BANK_DOCUMENT",
        });
      }

      const result = await runOcrExtract({
        documentType,
        mediaPath: req.body?.mediaPath,
        text: req.body?.text,
      });

      res.json({ ok: true, result });
    } catch (error) {
      logger.error({ err: error }, "OCR extraction failed");
      res.status(500).json({ ok: false });
    }
  });

  app.post("/selfie/link", async (req, res) => {
    try {
      const merchantId = String(req.body?.merchantId ?? "");
      const applicationId = String(req.body?.applicationId ?? "");

      if (!merchantId || !applicationId) {
        return res.status(400).json({
          ok: false,
          error: "merchantId and applicationId are required",
        });
      }

      const payload = await createSelfieLinkPayload({
        merchantId,
        applicationId,
      });
      res.json({ ok: true, ...payload });
    } catch (error) {
      logger.error({ err: error }, "Failed to create selfie link");
      res.status(500).json({ ok: false });
    }
  });

  const webhookHandler = async (
    req: express.Request,
    res: express.Response,
  ) => {
    const payload = req.body as NormalizedIncomingMessage;
    try {
      logger.info(
        { payload },
        "Processing incoming WhatsApp onboarding webhook",
      );

      const deduped = await dedupeMessage(payload.messageId);
      if (deduped) {
        return res.json({ ok: true, deduped: true });
      }

      const session = await loadSession(payload.from);
      const result = await processOnboardingMessage(payload, session);

      await saveSession({
        userId: payload.from,
        step: stepToNumber(result.state.step),
        state: result.state,
      });
      await sendReplyToWhatsApp(payload.from, result.replyText);

      res.json({ ok: true });
    } catch (error) {
      if (isBackendConnectivityError(error)) {
        logger.warn(
          { err: error },
          "Onboarding backend unavailable; fallback reply sent",
        );
      } else {
        logger.error({ err: error }, "Failed to process incoming webhook");
      }

      try {
        await sendReplyToWhatsApp(payload.from, FALLBACK_REPLY);
      } catch (sendError) {
        logger.error({ err: sendError }, "Failed to send fallback reply");
      }

      // We intentionally return 200 because the error is handled with a fallback
      // WhatsApp reply. This prevents upstream dispatch retries/noise when
      // external onboarding backends are temporarily unavailable.
      res.status(200).json({ ok: false, fallbackSent: true, handled: true });
    }
  };

  app.post("/whatsapp/webhook", webhookGuardMiddleware, webhookHandler);
  app.post("/incoming", webhookGuardMiddleware, webhookHandler);

  return app;
}
