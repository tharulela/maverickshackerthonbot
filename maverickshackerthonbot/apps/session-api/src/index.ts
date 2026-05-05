import express from "express";
import { config } from "./config.js";
import { registerRoutes } from "./routes.js";
import { redis } from "./redis.js";

const app = express();
app.use(express.json());

registerRoutes(app);

app.listen(config.PORT, () => {
  console.log(`session-api listening on ${config.PORT}`);
});

process.on("SIGINT", async () => {
  await redis.quit();
  process.exit(0);
});