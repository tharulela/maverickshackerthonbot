$ErrorActionPreference = "Stop"

$ROOT = "maverickshackerthonbot"

New-Item -ItemType Directory -Force -Path `
  "$ROOT/apps/baileys-service/src/whatsapp", `
  "$ROOT/apps/baileys-service/src/transcription", `
  "$ROOT/apps/session-api/src", `
  "$ROOT/n8n" | Out-Null

Set-Location $ROOT

@'
node_modules
dist
.env
auth
data
*.log
.n8n
'@ | Set-Content -NoNewline .gitignore

@'
OPENAI_API_KEY=your_openai_key
REDIS_URL=redis://redis:6379
BAILEYS_PORT=3000
SESSION_API_PORT=4000
N8N_WEBHOOK_URL=http://n8n:5678/webhook/whatsapp-incoming
'@ | Set-Content -NoNewline .env.example

@'
# Maverick's Hackerthon Bot

Low-code WhatsApp onboarding system using Baileys and n8n.

## What it does
- Connects to WhatsApp using Baileys and QR code login
- Receives incoming messages through a webhook endpoint
- Sends outgoing messages through a REST-compatible flow
- Uses n8n for onboarding orchestration and step-by-step flow logic
- Stores per-user onboarding state in Redis
- Handles text and voice notes
- Transcribes voice notes before processing
- Supports multilingual input including South African languages
- Uses TypeScript, logging, and basic error handling
- Keeps the transport layer abstract so Baileys can later be swapped for WhatsApp Business API

## Quick start
1. Copy `.env.example` to `.env`
2. Run `docker compose up --build`
3. Import `n8n/whatsapp-onboarding-workflow.json`
4. Scan the QR code in the Baileys logs
'@ | Set-Content -NoNewline README.md

@'
version: "3.9"

services:
  redis:
    image: redis:7-alpine
    command: ["redis-server", "--appendonly", "yes"]
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data

  session-api:
    build:
      context: ./apps/session-api
    environment:
      - PORT=4000
      - REDIS_URL=${REDIS_URL}
    ports:
      - "4000:4000"
    depends_on:
      - redis

  n8n:
    image: n8nio/n8n:latest
    ports:
      - "5678:5678"
    environment:
      - N8N_HOST=localhost
      - N8N_PORT=5678
      - N8N_PROTOCOL=http
      - WEBHOOK_URL=http://localhost:5678/
      - N8N_ENCRYPTION_KEY=replace_me_with_long_random_string
      - NODE_ENV=production
    volumes:
      - n8n_data:/home/node/.n8n

  baileys-service:
    build:
      context: ./apps/baileys-service
    environment:
      - PORT=3000
      - N8N_WEBHOOK_URL=${N8N_WEBHOOK_URL}
      - SESSION_API_URL=http://session-api:4000
      - OPENAI_API_KEY=${OPENAI_API_KEY}
      - LOG_LEVEL=info
    ports:
      - "3000:3000"
    depends_on:
      - session-api
      - n8n
    volumes:
      - ./apps/baileys-service/auth:/app/auth
      - ./apps/baileys-service/data:/app/data

volumes:
  redis_data:
  n8n_data:
'@ | Set-Content -NoNewline docker-compose.yml

@'
{
  "name": "baileys-service",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "@hapi/boom": "^10.0.1",
    "@whiskeysockets/baileys": "^6.7.18",
    "axios": "^1.7.9",
    "dotenv": "^16.4.7",
    "express": "^4.21.2",
    "pino": "^9.5.0",
    "pino-pretty": "^13.0.0",
    "qrcode-terminal": "^0.12.0",
    "zod": "^3.24.1"
  },
  "devDependencies": {
    "@types/express": "^5.0.0",
    "@types/node": "^22.10.2",
    "tsx": "^4.19.2",
    "typescript": "^5.7.2"
  }
}
'@ | Set-Content -NoNewline apps/baileys-service/package.json

@'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "Bundler",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["src"]
}
'@ | Set-Content -NoNewline apps/baileys-service/tsconfig.json

@'
PORT=3000
N8N_WEBHOOK_URL=http://localhost:5678/webhook/whatsapp-incoming
SESSION_API_URL=http://localhost:4000
OPENAI_API_KEY=your_openai_key
LOG_LEVEL=info
'@ | Set-Content -NoNewline apps/baileys-service/.env.example

@'
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

EXPOSE 3000
CMD ["npm", "start"]
'@ | Set-Content -NoNewline apps/baileys-service/Dockerfile

@'
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
'@ | Set-Content -NoNewline apps/baileys-service/src/config.ts

@'
import pino from "pino";
import { config } from "./config.js";

export const logger = pino({
  level: config.LOG_LEVEL,
  transport: {
    target: "pino-pretty",
    options: { colorize: true }
  }
});
'@ | Set-Content -NoNewline apps/baileys-service/src/logger.ts

@'
export type MessageType = "text" | "voice" | "unknown";

export interface NormalizedIncomingMessage {
  messageId: string;
  from: string;
  timestamp: number;
  type: MessageType;
  text?: string;
  mimeType?: string;
  mediaPath?: string;
  languageHint?: string;
}
'@ | Set-Content -NoNewline apps/baileys-service/src/types.ts

@'
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
'@ | Set-Content -NoNewline apps/baileys-service/src/server.ts

@'
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
    const response = await fetch(`http://localhost:${config.PORT}/incoming`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(msg)
    });

    if (!response.ok) {
      logger.warn({ status: response.status }, "Local webhook dispatch failed");
    }
  });
}

main().catch((error) => {
  logger.error({ error }, "Fatal startup failure");
  process.exit(1);
});
'@ | Set-Content -NoNewline apps/baileys-service/src/index.ts

@'
import { NormalizedIncomingMessage } from "../types.js";

export interface WhatsAppAdapter {
  sendMessage(to: string, text: string): Promise<void>;
  onIncoming(handler: (msg: NormalizedIncomingMessage) => Promise<void>): Promise<void>;
}
'@ | Set-Content -NoNewline apps/baileys-service/src/whatsapp/adapter.ts

@'
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { downloadContentFromMessage } from "@whiskeysockets/baileys";

async function streamToFile(stream: AsyncIterable<Buffer>, filePath: string) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  fs.writeFileSync(filePath, Buffer.concat(chunks));
}

export async function downloadVoiceNote(message: any): Promise<string> {
  const dir = "./data/media";
  fs.mkdirSync(dir, { recursive: true });

  const filePath = path.join(dir, `${randomUUID()}.ogg`);
  const stream = await downloadContentFromMessage(message.message.audioMessage, "audio");
  await streamToFile(stream, filePath);

  return filePath;
}
'@ | Set-Content -NoNewline apps/baileys-service/src/whatsapp/media.ts

@'
import { proto } from "@whiskeysockets/baileys";
import { NormalizedIncomingMessage } from "../types.js";

export async function normalizeMessage(
  message: proto.IWebMessageInfo,
  voiceText?: string,
  mediaPath?: string
): Promise<NormalizedIncomingMessage> {
  const from = message.key.remoteJid!;
  const messageId = message.key.id!;
  const timestamp = Number(message.messageTimestamp) * 1000;
  const m = message.message;

  if (!m) {
    return { messageId, from, timestamp, type: "unknown" };
  }

  if (m.conversation) {
    return { messageId, from, timestamp, type: "text", text: m.conversation };
  }

  if (m.extendedTextMessage?.text) {
    return { messageId, from, timestamp, type: "text", text: m.extendedTextMessage.text };
  }

  if (m.audioMessage) {
    return {
      messageId,
      from,
      timestamp,
      type: "voice",
      text: voiceText,
      mimeType: m.audioMessage.mimetype || "audio/ogg",
      mediaPath
    };
  }

  return { messageId, from, timestamp, type: "unknown" };
}
'@ | Set-Content -NoNewline apps/baileys-service/src/whatsapp/normalize.ts

@'
export interface Transcriber {
  transcribeAudio(filePath: string): Promise<string>;
}
'@ | Set-Content -NoNewline apps/baileys-service/src/transcription/transcriber.ts

@'
import fs from "node:fs";
import axios from "axios";
import { config } from "../config.js";
import { Transcriber } from "./transcriber.js";

export class OpenAIWhisperTranscriber implements Transcriber {
  async transcribeAudio(filePath: string): Promise<string> {
    if (!config.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is required for transcription");
    }

    const form = new FormData();
    form.append("file", fs.createReadStream(filePath) as any);
    form.append("model", "whisper-1");

    const response = await axios.post("https://api.openai.com/v1/audio/transcriptions", form, {
      headers: {
        Authorization: `Bearer ${config.OPENAI_API_KEY}`
      }
    });

    return response.data.text;
  }
}
'@ | Set-Content -NoNewline apps/baileys-service/src/transcription/openai-whisper.ts

@'
import { config } from "../config.js";
import { Transcriber } from "./transcriber.js";
import { OpenAIWhisperTranscriber } from "./openai-whisper.js";

export function createTranscriber(): Transcriber {
  if (config.OPENAI_API_KEY) {
    return new OpenAIWhisperTranscriber();
  }

  return {
    async transcribeAudio() {
      return "Transcribed voice note text";
    }
  };
}
'@ | Set-Content -NoNewline apps/baileys-service/src/transcription/factory.ts

@'
{
  "name": "session-api",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "dotenv": "^16.4.7",
    "express": "^4.21.2",
    "ioredis": "^5.4.1",
    "zod": "^3.24.1"
  },
  "devDependencies": {
    "@types/express": "^5.0.0",
    "@types/node": "^22.10.2",
    "tsx": "^4.19.2",
    "typescript": "^5.7.2"
  }
}
'@ | Set-Content -NoNewline apps/session-api/package.json

@'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "Bundler",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
'@ | Set-Content -NoNewline apps/session-api/tsconfig.json

@'
PORT=4000
REDIS_URL=redis://redis:6379
SESSION_TTL_SECONDS=86400
DEDUPE_TTL_SECONDS=86400
'@ | Set-Content -NoNewline apps/session-api/.env.example

@'
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

EXPOSE 4000
CMD ["npm", "start"]
'@ | Set-Content -NoNewline apps/session-api/Dockerfile

@'
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
'@ | Set-Content -NoNewline apps/session-api/src/config.ts

@'
export interface SessionState {
  userId: string;
  step: number;
  state: Record<string, unknown>;
  updatedAt: string;
}
'@ | Set-Content -NoNewline apps/session-api/src/types.ts

@'
import Redis from "ioredis";
import { config } from "./config.js";

export const redis = new Redis(config.REDIS_URL);
'@ | Set-Content -NoNewline apps/session-api/src/redis.ts

@'
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
'@ | Set-Content -NoNewline apps/session-api/src/routes.ts

@'
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
'@ | Set-Content -NoNewline apps/session-api/src/index.ts

@'
{
  "name": "WhatsApp Onboarding Flow",
  "nodes": [
    {
      "parameters": {
        "path": "whatsapp-incoming",
        "httpMethod": "POST",
        "responseMode": "responseNode"
      },
      "id": "Webhook",
      "name": "Webhook",
      "type": "n8n-nodes-base.webhook",
      "typeVersion": 2,
      "position": [240, 300]
    }
  ],
  "connections": {},
  "active": false,
  "settings": {},
  "versionId": "1"
}
'@ | Set-Content -NoNewline n8n/whatsapp-onboarding-workflow.json

git checkout -b develop
git add .
git commit -m "Initial commit"