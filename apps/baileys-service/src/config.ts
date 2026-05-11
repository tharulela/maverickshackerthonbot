import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const schema = z.object({
  PORT: z.coerce.number().default(3000),
  N8N_WEBHOOK_URL: z.string().url().optional(),
  SESSION_API_URL: z.string().url(),
  OPENAI_API_KEY: z.string().optional(),
  LOG_LEVEL: z.string().default("info"),
  IKHOKHA_BASE_URL: z.string().url().default("http://localhost:8080"),
  PROFILE_BASE_URL: z.string().url().optional(),
  RELY_COMPLY_BASE_URL: z.string().url().optional(),
  HSPROXY_BASE_URL: z.string().url().optional(),
  MCC_CLASSIFIER_URL: z.string().url().optional(),
  BACKEND_AUTH_TOKEN: z.string().optional(),
  BACKEND_AUTH_HEADER: z.string().default("Authorization"),
  WHATSAPP_WEBHOOK_SECRET: z.string().optional(),
  REQUEST_TIMEOUT_MS: z.coerce.number().default(15000),
  OCR_RETRY_LIMIT: z.coerce.number().default(2),
  IS_AI_POWERED_MCC_ENABLED: z.coerce.boolean().default(false),
  SELFIE_BASE_URL: z.string().url().default("https://selfie.example.com/capture"),
  SELFIE_LINK_SECRET: z.string().min(8).default("change-me-please"),
  SELFIE_LINK_TTL_SECONDS: z.coerce.number().default(900),
});

export const config = schema.parse(process.env);
