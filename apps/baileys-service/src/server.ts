import express from "express";
import { logger } from "./logger.js";
import { config } from "./config.js";
import { NormalizedIncomingMessage } from "./types.js";
import {
  createSelfieLinkPayload,
  runOcrExtract,
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

async function forwardToN8n(payload: NormalizedIncomingMessage) {
  if (!config.N8N_WEBHOOK_URL) {
    throw new Error("N8N_WEBHOOK_URL is required for n8n-first webhook mode");
  }

  const response = await fetch(config.N8N_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `n8n webhook failed: ${response.status} ${response.statusText} ${body}`,
    );
  }

  const data = (await response.json().catch(() => ({}))) as {
    replyText?: string;
    deduped?: boolean;
  };

  return data;
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
        "Forwarding incoming WhatsApp payload to n8n",
      );
      const result = await forwardToN8n(payload);

      if (result.deduped) {
        return res.json({ ok: true, deduped: true });
      }

      const replyText = result.replyText?.trim();
      if (replyText) {
        await sendReplyToWhatsApp(payload.from, replyText);
      }

      res.json({ ok: true, replyText: replyText ?? null });
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
