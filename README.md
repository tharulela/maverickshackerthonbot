# Maverick's Hackerthon Bot

WhatsApp onboarding system using Baileys transport, n8n orchestration, and Redis session storage.

## What it does
- Connects to WhatsApp using Baileys and QR code login
- Forwards inbound events to `N8N_WEBHOOK_URL` where flow logic runs
- Exposes inbound compatibility endpoints at `POST /whatsapp/webhook` and `POST /incoming` that also forward to n8n
- Exposes POC helper endpoints:
  - `POST /ocr/extract`
  - `POST /selfie/link`
- Keeps session state and dedupe in Redis via `session-api`, orchestrated by n8n
- Handles text, image/document uploads, and voice notes

## Quick start
1. Copy `.env.example` to `.env`
2. Run `docker compose up --build`
3. Import `n8n/whatsapp-onboarding-workflow.json` into n8n and activate it
4. Scan the QR code in the Baileys logs

## Troubleshooting
- If logs show `fetch failed: connect ECONNREFUSED ...:8080`, the external onboarding backend is not reachable from the `baileys-service` container.
- Set `IKHOKHA_BASE_URL`, `PROFILE_BASE_URL`, `RELY_COMPLY_BASE_URL`, and `HSPROXY_BASE_URL` in `.env` to a reachable backend URL for your environment.
- If the backend runs on your host machine, ensure it is listening on the configured port and accessible from Docker (default uses `host.docker.internal`).

## n8n orchestration
- n8n owns onboarding flow logic and session transitions
- Baileys service acts as transport adapter plus helper APIs for OCR and selfie-link generation
