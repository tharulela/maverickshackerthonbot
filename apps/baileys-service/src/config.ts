import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const schema = z.object({
  PORT: z.coerce.number().default(3000),
  N8N_WEBHOOK_URL: z.string().url(),
  SESSION_API_URL: z.string().url(),
  OPENAI_API_KEY: z.string().optional(),
  LOG_LEVEL: z.string().default("info")
});

export const config = schema.parse(process.env);