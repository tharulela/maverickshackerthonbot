import { Express } from "express";
import { config } from "./config.js";
import { redis } from "./redis.js";

export function registerRoutes(app: Express) {
  app.get("/health", (_req, res) => res.json({ ok: true }));

  app.get("/session/:userId", async (req, res) => {
    const key = `wa:session:${req.params.userId}`;
    const value = await redis.get(key);

    if (!value) {
      return res.status(404).json({ found: false });
    }

    res.json({ found: true, session: JSON.parse(value) });
  });

  app.post("/session/:userId", async (req, res) => {
    const key = `wa:session:${req.params.userId}`;
    const session = {
      userId: req.params.userId,
      step: Number(req.body.step ?? 0),
      state: req.body.state ?? {},
      updatedAt: new Date().toISOString()
    };

    await redis.set(key, JSON.stringify(session), "EX", config.SESSION_TTL_SECONDS);
    res.json({ ok: true });
  });

  app.post("/dedupe/:messageId", async (req, res) => {
    const key = `wa:dedupe:${req.params.messageId}`;
    const existing = await redis.get(key);

    if (existing) {
      return res.json({ deduped: true });
    }

    await redis.set(key, "1", "EX", config.DEDUPE_TTL_SECONDS);
    res.json({ deduped: false });
  });
}