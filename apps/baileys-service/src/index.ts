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
    const response = await fetch(
      `http://localhost:${config.PORT}/whatsapp/webhook`,
      {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(msg)
      },
    );

    if (!response.ok) {
      logger.warn({ status: response.status }, "Local webhook dispatch failed");
    }
  });
}

main().catch((error) => {
  logger.error({ error }, "Fatal startup failure");
  process.exit(1);
});
