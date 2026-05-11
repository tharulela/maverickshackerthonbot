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
    throw new Error(`dedupe check failed: ${response.status} ${response.statusText}`);
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
      logger.error({ error }, "OCR extraction failed");
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

      const payload = await createSelfieLinkPayload({ merchantId, applicationId });
      res.json({ ok: true, ...payload });
    } catch (error) {
      logger.error({ error }, "Failed to create selfie link");
      res.status(500).json({ ok: false });
    }
  });

  app.post("/whatsapp/webhook", async (req, res) => {
    if (!isWebhookAuthorized(req)) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

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
        step: session.step + 1,
        state: result.state,
      });
      await sendReplyToWhatsApp(payload.from, result.replyText);

      res.json({ ok: true });
    } catch (error) {
      logger.error({ error }, "Failed to process incoming webhook");

      try {
        await sendReplyToWhatsApp(payload.from, FALLBACK_REPLY);
      } catch (sendError) {
        logger.error({ sendError }, "Failed to send fallback reply");
      }

      res.status(500).json({ ok: false, fallbackSent: true });
    }
  });

  app.post("/incoming", async (req, res) => {
    req.url = "/whatsapp/webhook";
    app.handle(req, res);
  });

  return app;
}
