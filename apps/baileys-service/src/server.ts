import express from "express";
import { logger } from "./logger.js";
import { config } from "./config.js";
import { NormalizedIncomingMessage } from "./types.js";

const FALLBACK_REPLY =
  "Meow! Thanks for your message. I am currently being built and will be up and running soon.";

interface SessionRecord {
  userId: string;
  step: number;
  state: Record<string, unknown>;
}

async function loadSession(userId: string): Promise<SessionRecord> {
  const response = await fetch(
    `${config.SESSION_API_URL}/session/${encodeURIComponent(userId)}`,
  );

  if (response.status === 404) {
    return { userId, step: 0, state: {} };
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
  return data.session ?? { userId, step: 0, state: {} };
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

function buildOnboardingReply(
  payload: NormalizedIncomingMessage,
  session: SessionRecord,
) {
  const text = (payload.text ?? "").trim();
  const nextState = { ...session.state };
  let nextStep = session.step ?? 0;
  let replyText = "";

  if (nextStep === 0) {
    replyText = "Meow! Welcome to onboarding. What is your full name?";
    nextStep = 1;
  } else if (nextStep === 1) {
    nextState.fullName = text;
    replyText = "Thanks. Which language would you like to continue in?";
    nextStep = 2;
  } else if (nextStep === 2) {
    nextState.language = text;
    replyText = "Great. Please share your email address.";
    nextStep = 3;
  } else if (nextStep === 3) {
    nextState.email = text;
    replyText = "What service are you interested in?";
    nextStep = 4;
  } else if (nextStep === 4) {
    nextState.service = text;
    replyText = "Thanks - your onboarding is complete.";
    nextStep = 5;
  } else {
    replyText = "You are already onboarded. Reply HELP for support.";
  }

  return {
    replyText,
    session: {
      userId: payload.from,
      step: nextStep,
      state: nextState,
    },
  };
}

export function createServer(
  sendReplyToWhatsApp: (to: string, text: string) => Promise<void>,
) {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.post("/incoming", async (req, res) => {
    const payload = req.body as NormalizedIncomingMessage;

    try {
      logger.info(
        { payload },
        "Processing incoming message with local onboarding flow",
      );

      const session = await loadSession(payload.from);
      const result = buildOnboardingReply(payload, session);

      await saveSession(result.session);
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

  return app;
}
