import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const schema = z.object({
  PORT: z.coerce.number().default(4000),
  REDIS_URL: z.string().url(),
  SESSION_TTL_SECONDS: z.coerce.number().default(86400),
  DEDUPE_TTL_SECONDS: z.coerce.number().default(86400)
});

export const config = schema.parse(process.env);