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