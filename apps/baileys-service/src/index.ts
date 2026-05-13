import { config } from "./config.js";
import { logger } from "./logger.js";
import { createBaileysAdapter } from "./whatsapp/baileys.js";
import { createServer } from "./server.js";

async function main() {
  const wa = await createBaileysAdapter();
  const app = createServer(wa.sendMessage);

  app.listen(config.PORT, () => {
    logger.info({ port: config.PORT }, "Baileys service listening");
  });

  await wa.onIncoming(async (msg) => {
    if (!config.N8N_WEBHOOK_URL) {
      logger.warn("N8N_WEBHOOK_URL is not set; skipping inbound dispatch");
      return;
    }

    const response = await fetch(
      config.N8N_WEBHOOK_URL,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(msg),
      },
    );

    if (!response.ok) {
      const responseBody = await response.text().catch(() => "");
      logger.warn(
        { status: response.status, responseBody },
        "Local webhook dispatch failed",
      );
      return;
    }

    const result = (await response.json().catch(() => ({}))) as {
      deduped?: boolean;
      replyText?: string;
    };

    if (!result.deduped && result.replyText?.trim()) {
      await wa.sendMessage(msg.from, result.replyText.trim());
    }
  });
}

main().catch((error) => {
  logger.error({ err: error }, "Fatal startup failure");
  process.exit(1);
});
