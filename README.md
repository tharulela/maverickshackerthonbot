# Maverick's Hackerthon Bot

WhatsApp onboarding system using Baileys, Redis session storage, and backend onboarding APIs.

## What it does
- Connects to WhatsApp using Baileys and QR code login
- Receives inbound events at `POST /whatsapp/webhook` (with `/incoming` compatibility route)
- Exposes POC helper endpoints:
  - `POST /ocr/extract`
  - `POST /selfie/link`
- Runs a sole-proprietor onboarding state machine with resume, retry, edit, and help flows
- Persists onboarding fields through existing onboarding/profile APIs
- Stores per-user chat state and message dedupe markers in Redis via `session-api`
- Handles text, image/document uploads, and voice notes

## Quick start
1. Copy `.env.example` to `.env`
2. Run `docker compose up --build`
3. Scan the QR code in the Baileys logs

## Core flow (POC)
1. Onboarding entry + resume detection
2. Business capture (+ optional AI MCC description branch)
3. SA ID capture and branch checks (citizenship, age, DHA photo)
4. Residential address capture
5. Banking capture with OCR retry/manual fallback
6. Selfie handoff via signed link
7. Submit/close application
