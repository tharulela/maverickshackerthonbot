import express from "express";
import { logger } from "./logger.js";
import { config } from "./config.js";
import { NormalizedIncomingMessage } from "./types.js";

export function createServer(sendReplyToWhatsApp: (to: string, text: string) => Promise<void>) {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.post("/incoming", async (req, res) => {
    const payload = req.body as NormalizedIncomingMessage;

    try {
      logger.info({ payload }, "Forwarding incoming message to n8n");

      const response = await fetch(config.N8N_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        throw new Error(`n8n webhook failed: ${response.status} ${response.statusText}`);
      }

      const data = (await response.json()) as { replyText?: string };

      if (data.replyText) {
        await sendReplyToWhatsApp(payload.from, data.replyText);
      }

      res.json({ ok: true });
    } catch (error) {
      logger.error({ error }, "Failed to process incoming webhook");
      res.status(500).json({ ok: false });
    }
  });

  return app;
}