import { createHmac, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { NormalizedIncomingMessage } from "./types.js";

const HELP_MENU =
  "What would you like to do?\n1. Continue onboarding\n2. Change details\n3. Talk to support";

const SUPPORTED_BANKS = [
  "ABSA",
  "Capitec",
  "FNB",
  "Nedbank",
  "Standard Bank",
  "TymeBank",
  "African Bank",
  "Bidvest",
  "Discovery Bank",
  "Investec",
  "Sasfin",
  "Ubank",
];

const EDITABLE_FIELDS: Record<string, string> = {
  business: "BUSINESS_REGISTERED_NAME",
  "business name": "BUSINESS_REGISTERED_NAME",
  "business address": "ADDRESS",
  residential: "USER_ADDRESS",
  address: "USER_ADDRESS",
  bank: "BANK",
  banking: "BANK",
  "account holder": "BANK_ACCOUNT_HOLDER_NAME",
};

export type OnboardingStep =
  | "ENTRY"
  | "BUSINESS_NAME"
  | "BUSINESS_DESCRIPTION"
  | "BUSINESS_ADDRESS"
  | "ID_DOCUMENT"
  | "ID_CONFIRM"
  | "RESIDENTIAL_ADDRESS"
  | "BANK_DOCUMENT"
  | "BANK_ACCOUNT_HOLDER"
  | "BANK_CONFIRM"
  | "SELFIE_WAIT"
  | "COMPLETED"
  | "TERMINAL";

export interface OnboardingState {
  merchantId?: string;
  applicationId?: string;
  step: OnboardingStep;
  language?: string;
  helpActive?: boolean;
  editField?: string;
  idDocRetries?: number;
  bankDocRetries?: number;
  isAIpoweredMccEnabled?: boolean;
  businessName?: string;
  businessDescription?: string;
  businessAddress?: ParsedAddress;
  mccCode?: string;
  principalIdNumber?: string;
  userDateOfBirth?: string;
  userIsSouthAfricanCitizen?: boolean;
  dhaHasPhoto?: boolean;
  residentialAddress?: ParsedAddress;
  bankName?: string;
  bankAccountNumber?: string;
  bankAccountHolderName?: string;
  bankAccountType?: string;
  pendingBankNeedsAccountHolder?: boolean;
  selfieLink?: string;
  terminalReason?: string;
  lastPrompt?: string;
}

export interface SessionRecord {
  userId: string;
  step: number;
  state: OnboardingState;
}

export interface ParsedAddress {
  street1: string;
  suburb: string;
  city: string;
  province: string;
  code: string;
}

interface OcrExtractRequest {
  documentType: "SA_ID" | "BANK_DOCUMENT";
  mediaPath?: string;
  text?: string;
}

export interface OcrExtractResponse {
  documentType: "SA_ID" | "BANK_DOCUMENT";
  confidence: number;
  documentKind?: "sa_id" | "passport" | "bank_document" | "unknown";
  isSouthAfricanCitizen?: boolean;
  principalIdNumber?: string;
  userDateOfBirth?: string;
  bankName?: string;
  bankAccountNumber?: string;
  bankAccountHolderName?: string;
}

interface BackendApplication {
  applicationId: string;
  status?: string;
  fields?: Record<string, unknown>;
  raw?: Record<string, unknown>;
}

interface BackendClientConfig {
  timeoutMs: number;
  authToken?: string;
  authHeader: string;
}

class BackendClient {
  constructor(private readonly cfg: BackendClientConfig) {}

  async findInProgressApplication(
    merchantId: string,
  ): Promise<BackendApplication | null> {
    const data = await this.requestJson<any[]>(
      "GET",
      this.onboardingPath(
        `/onboarding/v1/merchants/${encodeURIComponent(merchantId)}/applications`,
      ),
    );
    const apps = Array.isArray(data) ? data : [];
    for (const app of apps) {
      const status = String(app?.status ?? "").toUpperCase();
      if (
        !status ||
        status === "IN_PROGRESS" ||
        status === "DRAFT" ||
        status === "PENDING"
      ) {
        return {
          applicationId: String(app?.applicationId ?? app?.id ?? ""),
          status: app?.status,
          fields: (app?.fields ?? app?.applicationFields ?? {}) as Record<
            string,
            unknown
          >,
          raw: app as Record<string, unknown>,
        };
      }
    }
    return null;
  }

  async getApplicationSnapshot(
    merchantId: string,
    applicationId: string,
  ): Promise<BackendApplication | null> {
    const data = await this.requestJson<any[]>(
      "GET",
      this.onboardingPath(
        `/onboarding/v1/merchants/${encodeURIComponent(merchantId)}/applications`,
      ),
    );
    const apps = Array.isArray(data) ? data : [];
    const app = apps.find(
      (item) => String(item?.applicationId ?? item?.id ?? "") === applicationId,
    );
    if (!app) {
      return null;
    }

    return {
      applicationId,
      status: app?.status,
      fields: (app?.fields ?? app?.applicationFields ?? {}) as Record<
        string,
        unknown
      >,
      raw: app as Record<string, unknown>,
    };
  }

  async createApplication(merchantId: string): Promise<string> {
    const body = {
      businessType: "SOLE_PROPRIETOR",
      BUSINESS_TYPE: "SOLE_PROPRIETOR",
    };
    const data = await this.requestJson<Record<string, unknown>>(
      "POST",
      this.onboardingPath(
        `/onboarding/v1/merchants/${encodeURIComponent(merchantId)}/applications`,
      ),
      body,
    );

    const applicationId = String(data?.applicationId ?? data?.id ?? "");
    if (!applicationId) {
      throw new Error("Unable to determine created application ID");
    }
    return applicationId;
  }

  async updateApplication(
    merchantId: string,
    applicationId: string,
    fields: Record<string, unknown>,
  ): Promise<void> {
    await this.requestJson(
      "PUT",
      this.onboardingPath(
        `/onboarding/v1/merchants/${encodeURIComponent(
          merchantId,
        )}/applications/${encodeURIComponent(applicationId)}`,
      ),
      fields,
    );
  }

  async closeApplication(
    merchantId: string,
    applicationId: string,
  ): Promise<void> {
    await this.requestJson(
      "PUT",
      this.onboardingPath(
        `/onboarding/v1/merchants/${encodeURIComponent(
          merchantId,
        )}/applications/${encodeURIComponent(applicationId)}/close`,
      ),
      {},
    );
  }

  async saveBankAccount(
    merchantId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.requestJson(
      "POST",
      this.profilePath(
        `/profile/v1/merchants/${encodeURIComponent(merchantId)}/bankaccounts`,
      ),
      payload,
    );
  }

  async getDhaDetails(personalIdNumber: string): Promise<Record<string, unknown>> {
    return await this.requestJson(
      "GET",
      this.relyPath(
        `/rely-comply-broker/v1/get-dha-details/${encodeURIComponent(
          personalIdNumber,
        )}`,
      ),
    );
  }

  async classifyBusinessIndustry(description: string): Promise<string | undefined> {
    const url =
      config.MCC_CLASSIFIER_URL ??
      this.onboardingPath("/api/classify-business-industry");
    const result = await this.requestJson<Record<string, unknown>>("POST", url, {
      description,
    });
    return String(result?.mccCode ?? result?.code ?? "") || undefined;
  }

  async publishFlowEvent(
    applicationId: string,
    event: string,
    meta: Record<string, unknown> = {},
  ): Promise<void> {
    const path = this.hsproxyPath(
      `/hsproxy/applications/application-id/${encodeURIComponent(
        applicationId,
      )}/ui-flow-events/publish`,
    );
    await this.requestJson("POST", path, { event, meta, source: "whatsapp_poc" });
  }

  private onboardingPath(path: string): string {
    return `${config.IKHOKHA_BASE_URL}${path}`;
  }

  private profilePath(path: string): string {
    const base = config.PROFILE_BASE_URL ?? config.IKHOKHA_BASE_URL;
    return `${base}${path}`;
  }

  private relyPath(path: string): string {
    const base = config.RELY_COMPLY_BASE_URL ?? config.IKHOKHA_BASE_URL;
    return `${base}${path}`;
  }

  private hsproxyPath(path: string): string {
    const base = config.HSPROXY_BASE_URL ?? config.IKHOKHA_BASE_URL;
    return `${base}${path}`;
  }

  private async requestJson<T = Record<string, unknown>>(
    method: string,
    url: string,
    body?: unknown,
  ): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (this.cfg.authToken) {
      headers[this.cfg.authHeader] = `Bearer ${this.cfg.authToken}`;
    }

    const response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.cfg.timeoutMs),
    });

    if (!response.ok) {
      const responseText = await response.text().catch(() => "");
      throw new Error(
        `HTTP ${method} ${url} failed: ${response.status} ${response.statusText} ${responseText}`,
      );
    }

    if (response.status === 204) {
      return {} as T;
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      return (await response.json()) as T;
    }

    return {} as T;
  }
}

const backendClient = new BackendClient({
  timeoutMs: config.REQUEST_TIMEOUT_MS,
  authToken: config.BACKEND_AUTH_TOKEN,
  authHeader: config.BACKEND_AUTH_HEADER,
});

export function normalizeMerchantId(from: string): string {
  return from.split("@")[0] ?? from;
}

export function initialOnboardingState(): OnboardingState {
  return {
    step: "ENTRY",
    idDocRetries: 0,
    bankDocRetries: 0,
    bankAccountType: "CURRENT",
    isAIpoweredMccEnabled: config.IS_AI_POWERED_MCC_ENABLED,
  };
}

function isHelpIntent(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return normalized === "help" || normalized === "menu" || normalized === "?";
}

function isEditIntent(text: string): string | undefined {
  const normalized = text.trim().toLowerCase();
  if (
    !normalized.includes("change") &&
    !normalized.includes("fix") &&
    !normalized.includes("edit")
  ) {
    return undefined;
  }

  for (const key of Object.keys(EDITABLE_FIELDS)) {
    if (normalized.includes(key)) {
      return EDITABLE_FIELDS[key];
    }
  }

  return undefined;
}

function parseAddress(value: string): ParsedAddress {
  const parts = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  return {
    street1: parts[0] ?? value,
    suburb: parts[1] ?? "",
    city: parts[2] ?? "",
    province: parts[3] ?? "",
    code: parts[4] ?? "",
  };
}

function buildAddressFieldPayload(
  prefix: "ADDRESS" | "USER_ADDRESS",
  address: ParsedAddress,
): Record<string, string> {
  const base = prefix === "ADDRESS" ? "ADDRESS" : "USER_ADDRESS";
  return {
    [`${base}_STREET1`]: address.street1,
    [`${base}_SUBURB`]: address.suburb,
    [`${base}_CITY`]: address.city,
    [`${base}_PROVINCE`]: address.province,
    [`${base}_CODE`]: address.code,
  };
}

function calculateAge(isoDate: string): number {
  const now = new Date();
  const dob = new Date(isoDate);

  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const monthDiff = now.getUTCMonth() - dob.getUTCMonth();
  if (
    monthDiff < 0 ||
    (monthDiff === 0 && now.getUTCDate() < dob.getUTCDate())
  ) {
    age -= 1;
  }

  return age;
}

function extractDateFromSouthAfricanId(idNumber: string): string | undefined {
  if (!/^\d{13}$/.test(idNumber)) {
    return undefined;
  }

  const yy = Number(idNumber.slice(0, 2));
  const mm = Number(idNumber.slice(2, 4));
  const dd = Number(idNumber.slice(4, 6));

  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) {
    return undefined;
  }

  const currentTwoDigitYear = Number(
    String(new Date().getUTCFullYear()).slice(-2),
  );
  const century = yy <= currentTwoDigitYear ? 2000 : 1900;
  const year = century + yy;

  const date = new Date(Date.UTC(year, mm - 1, dd));
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }

  return date.toISOString().slice(0, 10);
}

function normalizeBankName(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }

  const direct = SUPPORTED_BANKS.find(
    (item) => item.toLowerCase() === raw.toLowerCase(),
  );
  if (direct) {
    return direct;
  }

  return SUPPORTED_BANKS.find((item) =>
    raw.toLowerCase().includes(item.toLowerCase()),
  );
}

async function safeReadMediaFile(mediaPath?: string): Promise<string> {
  if (!mediaPath) {
    return "";
  }

  const allowedPrefixes = ["./data/", "data/", "/app/data/"];
  if (!allowedPrefixes.some((prefix) => mediaPath.startsWith(prefix))) {
    return "";
  }

  try {
    const buf = await fs.readFile(mediaPath);
    return buf.toString("utf-8");
  } catch {
    return "";
  }
}

export async function runOcrExtract(
  request: OcrExtractRequest,
): Promise<OcrExtractResponse> {
  const inlineText = (request.text ?? "").trim();
  const fileText = await safeReadMediaFile(request.mediaPath);
  const source = `${inlineText}\n${fileText}`.trim();
  const lower = source.toLowerCase();

  if (request.documentType === "SA_ID") {
    const idMatch = source.match(/\b\d{13}\b/);
    const dob = idMatch ? extractDateFromSouthAfricanId(idMatch[0]) : undefined;
    const isPassport =
      lower.includes("passport") ||
      lower.includes("foreign") ||
      lower.includes("non-sa");
    const isSouthAfricanCitizen = !isPassport;

    let confidence = 0.2;
    if (idMatch) {
      confidence = 0.85;
    }
    if (!source) {
      confidence = 0.1;
    }

    return {
      documentType: "SA_ID",
      confidence,
      documentKind: isPassport ? "passport" : idMatch ? "sa_id" : "unknown",
      isSouthAfricanCitizen,
      principalIdNumber: idMatch?.[0],
      userDateOfBirth: dob,
    };
  }

  const accountNumberMatch = source.match(/\b\d{6,16}\b/);
  const bankName = normalizeBankName(source);
  const accountHolderMatch = source.match(
    /account\s*holder[:\-]?\s*([A-Za-z\s]{3,60})/i,
  );

  let confidence = 0.2;
  if (accountNumberMatch && bankName) {
    confidence = 0.85;
  } else if (accountNumberMatch || bankName) {
    confidence = 0.55;
  }
  if (!source) {
    confidence = 0.1;
  }

  return {
    documentType: "BANK_DOCUMENT",
    confidence,
    documentKind: "bank_document",
    bankName,
    bankAccountNumber: accountNumberMatch?.[0],
    bankAccountHolderName: accountHolderMatch?.[1]?.trim(),
  };
}

function createSelfieLink(
  merchantId: string,
  applicationId: string,
): { url: string; expiresAt: string; token: string } {
  const token = randomUUID();
  const expiresAtMs = Date.now() + config.SELFIE_LINK_TTL_SECONDS * 1000;
  const expiresAt = new Date(expiresAtMs).toISOString();
  const payload = `${merchantId}:${applicationId}:${token}:${expiresAt}`;
  const signature = createHmac("sha256", config.SELFIE_LINK_SECRET)
    .update(payload)
    .digest("hex");

  const url = `${config.SELFIE_BASE_URL}?merchantId=${encodeURIComponent(
    merchantId,
  )}&applicationId=${encodeURIComponent(
    applicationId,
  )}&token=${encodeURIComponent(token)}&expiresAt=${encodeURIComponent(
    expiresAt,
  )}&sig=${signature}`;

  return { url, expiresAt, token };
}

async function persistFields(
  state: OnboardingState,
  fields: Record<string, unknown>,
): Promise<void> {
  if (!state.merchantId || !state.applicationId) {
    throw new Error("Cannot persist fields without merchant and application context");
  }

  await backendClient.updateApplication(state.merchantId, state.applicationId, fields);
}

function userText(payload: NormalizedIncomingMessage): string {
  return (payload.text ?? "").trim();
}

function terminal(
  state: OnboardingState,
  reason: string,
  reply: string,
): { state: OnboardingState; reply: string } {
  return {
    state: {
      ...state,
      step: "TERMINAL",
      terminalReason: reason,
      lastPrompt: reply,
    },
    reply,
  };
}

async function runEditFlow(
  state: OnboardingState,
  text: string,
): Promise<{ state: OnboardingState; reply: string } | null> {
  if (state.editField && text) {
    const nextState: OnboardingState = { ...state, editField: undefined };

    if (state.editField === "BUSINESS_REGISTERED_NAME") {
      nextState.businessName = text;
      await persistFields(nextState, { BUSINESS_REGISTERED_NAME: text });
      return { state: nextState, reply: "Updated your business name. Let’s continue." };
    }

    if (state.editField === "ADDRESS") {
      const address = parseAddress(text);
      nextState.businessAddress = address;
      await persistFields(nextState, buildAddressFieldPayload("ADDRESS", address));
      return { state: nextState, reply: "Updated your business address. Let’s continue." };
    }

    if (state.editField === "USER_ADDRESS") {
      const address = parseAddress(text);
      nextState.residentialAddress = address;
      await persistFields(nextState, buildAddressFieldPayload("USER_ADDRESS", address));
      return {
        state: nextState,
        reply: "Updated your residential address. Let’s continue.",
      };
    }

    if (state.editField === "BANK" || state.editField === "BANK_ACCOUNT_HOLDER_NAME") {
      const bankOcr = await runOcrExtract({ documentType: "BANK_DOCUMENT", text });
      nextState.bankName = bankOcr.bankName ?? state.bankName;
      nextState.bankAccountNumber = bankOcr.bankAccountNumber ?? state.bankAccountNumber;
      nextState.bankAccountHolderName =
        state.editField === "BANK_ACCOUNT_HOLDER_NAME"
          ? text
          : bankOcr.bankAccountHolderName ?? state.bankAccountHolderName;

      await persistFields(nextState, {
        BANK_NAME: nextState.bankName,
        BANK_ACCOUNT_NUMBER: nextState.bankAccountNumber,
        BANK_ACCOUNT_HOLDER_NAME: nextState.bankAccountHolderName,
        BANK_ACCOUNT_TYPE: "CURRENT",
      });

      return { state: nextState, reply: "Updated your banking details. Let’s continue." };
    }

    return { state: nextState, reply: "Updated. Let’s continue." };
  }

  return null;
}

async function ensureEntryState(
  payload: NormalizedIncomingMessage,
  state: OnboardingState,
): Promise<OnboardingState> {
  if (state.applicationId && state.merchantId) {
    return state;
  }

  const merchantId = normalizeMerchantId(payload.from);
  let nextState: OnboardingState = {
    ...state,
    merchantId,
    language: "en",
  };

  let inProgress: BackendApplication | null = null;
  try {
    inProgress = await backendClient.findInProgressApplication(merchantId);
  } catch (error) {
    logger.warn({ error }, "Resume lookup failed; continuing with new application flow");
  }

  if (inProgress?.applicationId) {
    nextState = {
      ...nextState,
      applicationId: inProgress.applicationId,
      step: inferStepFromApplicationFields(inProgress.fields ?? {}) ?? "BUSINESS_NAME",
    };
    return nextState;
  }

  const applicationId = await backendClient.createApplication(merchantId);
  nextState = {
    ...nextState,
    applicationId,
    step: "BUSINESS_NAME",
  };

  await persistFields(nextState, { BUSINESS_TYPE: "SOLE_PROPRIETOR" });
  return nextState;
}

function inferStepFromApplicationFields(
  fields: Record<string, unknown>,
): OnboardingStep | undefined {
  const hasBusinessName = Boolean(fields.BUSINESS_REGISTERED_NAME);
  const hasPrincipalId = Boolean(fields.PRINCIPAL_ID_NUMBER);
  const hasResidential = Boolean(fields.USER_ADDRESS_STREET1 || fields.USER_ADDRESS_CITY);
  const hasBank = Boolean(fields.BANK_ACCOUNT_NUMBER && fields.BANK_NAME);
  const hasSelfie = Boolean(fields.DOCUMENT_SELFIE_RESOURCE_URI);

  if (!hasBusinessName) return "BUSINESS_NAME";
  if (!hasPrincipalId) return "ID_DOCUMENT";
  if (!hasResidential) return "RESIDENTIAL_ADDRESS";
  if (!hasBank) return "BANK_DOCUMENT";
  if (!hasSelfie) return "SELFIE_WAIT";
  return "COMPLETED";
}

async function handleHelpFlow(
  state: OnboardingState,
  text: string,
): Promise<{ state: OnboardingState; reply: string } | null> {
  const normalized = text.toLowerCase();

  if (isHelpIntent(text)) {
    return { state: { ...state, helpActive: true }, reply: HELP_MENU };
  }

  if (state.helpActive) {
    if (normalized === "1" || normalized.includes("continue")) {
      return { state: { ...state, helpActive: false }, reply: "Great, let’s continue onboarding." };
    }

    if (normalized === "2" || normalized.includes("change")) {
      return {
        state: { ...state, helpActive: false, editField: "BUSINESS_REGISTERED_NAME" },
        reply: "What would you like to change? (business name, business address, residential address, bank)",
      };
    }

    if (normalized === "3" || normalized.includes("support")) {
      return {
        state: { ...state, helpActive: false },
        reply: "A support consultant will contact you shortly. You can still continue onboarding here anytime.",
      };
    }

    return { state, reply: HELP_MENU };
  }

  return null;
}

export async function processOnboardingMessage(
  payload: NormalizedIncomingMessage,
  inputSession: SessionRecord,
): Promise<{ replyText: string; state: OnboardingState }> {
  let state: OnboardingState = {
    ...initialOnboardingState(),
    ...(inputSession.state ?? {}),
  };

  const text = userText(payload);

  state = await ensureEntryState(payload, state);

  if (state.applicationId) {
    try {
      await backendClient.publishFlowEvent(state.applicationId, "message_received", {
        step: state.step,
        messageType: payload.type,
      });
    } catch (error) {
      logger.warn({ error }, "Failed to publish funnel event");
    }
  }

  const helpOutcome = await handleHelpFlow(state, text);
  if (helpOutcome) {
    return {
      replyText: helpOutcome.reply,
      state: {
        ...helpOutcome.state,
        lastPrompt: helpOutcome.reply,
      },
    };
  }

  const detectedEditField = isEditIntent(text);
  if (detectedEditField) {
    const nextState = { ...state, editField: detectedEditField };
    return {
      replyText: "Sure, please share the corrected value now.",
      state: {
        ...nextState,
        lastPrompt: "Sure, please share the corrected value now.",
      },
    };
  }

  const editOutcome = await runEditFlow(state, text);
  if (editOutcome) {
    return {
      replyText: editOutcome.reply,
      state: {
        ...editOutcome.state,
        lastPrompt: editOutcome.reply,
      },
    };
  }

  if (state.step === "TERMINAL") {
    return {
      replyText: state.lastPrompt ?? "This onboarding session is closed for now.",
      state,
    };
  }

  if (state.step === "COMPLETED") {
    return {
      replyText:
        "Your onboarding application has already been submitted. Reply HELP if you need support.",
      state,
    };
  }

  if (state.step === "ENTRY") {
    const nextState = { ...state, step: "BUSINESS_NAME" as const };
    const reply =
      "Hi 👋 Welcome to sole proprietor onboarding. We currently support English only for this POC. What is your business name?";
    return { replyText: reply, state: { ...nextState, lastPrompt: reply } };
  }

  if (state.step === "BUSINESS_NAME") {
    if (!text) {
      const reply = "Please share your business name to continue.";
      return { replyText: reply, state: { ...state, lastPrompt: reply } };
    }

    const nextState: OnboardingState = {
      ...state,
      businessName: text,
      step: state.isAIpoweredMccEnabled ? "BUSINESS_DESCRIPTION" : "BUSINESS_ADDRESS",
    };

    await persistFields(nextState, { BUSINESS_REGISTERED_NAME: text });

    const reply = state.isAIpoweredMccEnabled
      ? "Tell me a short description of what your business does."
      : "What is your business address? (street, suburb, city, province, postal code)";
    return { replyText: reply, state: { ...nextState, lastPrompt: reply } };
  }

  if (state.step === "BUSINESS_DESCRIPTION") {
    if (!text) {
      const reply = "Please share a short business description.";
      return { replyText: reply, state: { ...state, lastPrompt: reply } };
    }

    const mccCode = await backendClient
      .classifyBusinessIndustry(text)
      .catch(() => undefined);
    const nextState: OnboardingState = {
      ...state,
      businessDescription: text,
      mccCode,
      step: "BUSINESS_ADDRESS",
    };

    await persistFields(nextState, {
      BUSINESS_DESCRIPTION: text,
      ...(mccCode ? { BUSINESS_MCC_CODE: mccCode } : {}),
    });

    const reply =
      "What is your business address? (street, suburb, city, province, postal code)";
    return { replyText: reply, state: { ...nextState, lastPrompt: reply } };
  }

  if (state.step === "BUSINESS_ADDRESS") {
    if (!text) {
      const reply = "Please share your business address to continue.";
      return { replyText: reply, state: { ...state, lastPrompt: reply } };
    }

    const businessAddress = parseAddress(text);
    const nextState: OnboardingState = {
      ...state,
      businessAddress,
      step: "ID_DOCUMENT",
    };

    await persistFields(nextState, {
      ...buildAddressFieldPayload("ADDRESS", businessAddress),
      ...(nextState.mccCode ? { BUSINESS_MCC_CODE: nextState.mccCode } : {}),
    });

    const reply = "Please upload your South African ID document (image or PDF).";
    return { replyText: reply, state: { ...nextState, lastPrompt: reply } };
  }

  if (state.step === "ID_DOCUMENT") {
    if (!payload.mediaPath && !text) {
      const reply =
        "Please upload your South African ID document so I can extract your details.";
      return { replyText: reply, state: { ...state, lastPrompt: reply } };
    }

    const ocr = await runOcrExtract({
      documentType: "SA_ID",
      mediaPath: payload.mediaPath,
      text,
    });

    if (ocr.documentKind === "passport" || ocr.isSouthAfricanCitizen === false) {
      const outcome = terminal(
        state,
        "NON_SA_CITIZEN",
        "Sole prop POC currently supports SA citizens only.",
      );
      return { replyText: outcome.reply, state: outcome.state };
    }

    if (!ocr.principalIdNumber || ocr.confidence < 0.5) {
      const retries = (state.idDocRetries ?? 0) + 1;
      if (retries > config.OCR_RETRY_LIMIT) {
        const nextState = { ...state, idDocRetries: retries };
        const reply =
          "I’m still struggling to read that document. Please type your 13-digit SA ID number manually.";
        return { replyText: reply, state: { ...nextState, lastPrompt: reply } };
      }

      const nextState = { ...state, idDocRetries: retries };
      const reply =
        "I couldn't read your ID clearly. Please re-upload a clearer image or PDF of your SA ID.";
      return { replyText: reply, state: { ...nextState, lastPrompt: reply } };
    }

    const idNumber = ocr.principalIdNumber;
    let dob = ocr.userDateOfBirth ?? extractDateFromSouthAfricanId(idNumber);
    let dhaHasPhoto = false;
    let isSouthAfricanCitizen = ocr.isSouthAfricanCitizen !== false;

    try {
      const dha = await backendClient.getDhaDetails(idNumber);
      if (typeof dha?.hasPhoto === "boolean") {
        dhaHasPhoto = dha.hasPhoto;
      }
      if (typeof dha?.dateOfBirth === "string" && dha.dateOfBirth) {
        dob = dha.dateOfBirth;
      }
      if (typeof dha?.isSouthAfricanCitizen === "boolean") {
        isSouthAfricanCitizen = dha.isSouthAfricanCitizen;
      }
    } catch (error) {
      logger.warn({ error }, "DHA lookup failed; continuing with OCR data");
    }

    if (!isSouthAfricanCitizen) {
      const outcome = terminal(
        state,
        "NON_SA_CITIZEN",
        "Sole prop POC currently supports SA citizens only.",
      );
      return { replyText: outcome.reply, state: outcome.state };
    }

    if (!dob) {
      const retries = (state.idDocRetries ?? 0) + 1;
      if (retries > config.OCR_RETRY_LIMIT) {
        const reply =
          "I need your date of birth. Please type your SA ID number again clearly so I can continue.";
        return {
          replyText: reply,
          state: { ...state, idDocRetries: retries, lastPrompt: reply },
        };
      }
      const reply =
        "I could not confirm your date of birth from the document. Please re-upload your SA ID.";
      return {
        replyText: reply,
        state: { ...state, idDocRetries: retries, lastPrompt: reply },
      };
    }

    const age = calculateAge(dob);
    if (age < 16) {
      const outcome = terminal(
        state,
        "TOO_YOUNG",
        "You are too young for onboarding on this channel right now.",
      );
      return { replyText: outcome.reply, state: outcome.state };
    }

    if (age >= 16 && age < 18) {
      const outcome = terminal(
        state,
        "NO_FACE_SCAN_PATH",
        "This POC currently does not support the face scan path for your age bracket.",
      );
      return { replyText: outcome.reply, state: outcome.state };
    }

    const nextState: OnboardingState = {
      ...state,
      principalIdNumber: idNumber,
      userDateOfBirth: dob,
      userIsSouthAfricanCitizen: true,
      dhaHasPhoto,
      step: "ID_CONFIRM",
      idDocRetries: 0,
    };

    await persistFields(nextState, {
      PRINCIPAL_ID_NUMBER: idNumber,
      USER_IS_SOUTH_AFRICAN_CITIZEN: true,
      USER_DATE_OF_BIRTH: dob,
    });

    const pathNote = dhaHasPhoto
      ? "DHA photo found, so selfie handoff later will be enough."
      : "DHA photo missing; we will rely on your uploaded ID plus selfie handoff.";
    const reply = `I extracted:\n- ID number: ${idNumber}\n- Date of birth: ${dob}\n${pathNote}\nReply YES to confirm or NO to retry.`;
    return { replyText: reply, state: { ...nextState, lastPrompt: reply } };
  }

  if (state.step === "ID_CONFIRM") {
    const normalized = text.toLowerCase();
    if (normalized !== "yes" && normalized !== "y") {
      const retries = (state.idDocRetries ?? 0) + 1;
      const nextState = { ...state, step: "ID_DOCUMENT", idDocRetries: retries };
      const reply = "No problem — please re-upload your SA ID document.";
      return { replyText: reply, state: { ...nextState, lastPrompt: reply } };
    }

    const nextState = { ...state, step: "RESIDENTIAL_ADDRESS" as const };
    const reply =
      "What is your residential address? (street, suburb, city, province, postal code)";
    return { replyText: reply, state: { ...nextState, lastPrompt: reply } };
  }

  if (state.step === "RESIDENTIAL_ADDRESS") {
    if (!text) {
      const reply = "Please share your residential address to continue.";
      return { replyText: reply, state: { ...state, lastPrompt: reply } };
    }

    const residentialAddress = parseAddress(text);
    const nextState: OnboardingState = {
      ...state,
      residentialAddress,
      step: "BANK_DOCUMENT",
    };

    await persistFields(nextState, buildAddressFieldPayload("USER_ADDRESS", residentialAddress));

    const reply = "Please upload your proof of banking (statement or bank letter).";
    return { replyText: reply, state: { ...nextState, lastPrompt: reply } };
  }

  if (state.step === "BANK_DOCUMENT") {
    if (!payload.mediaPath && !text) {
      const reply =
        "Please upload your proof of banking so I can extract your bank details.";
      return { replyText: reply, state: { ...state, lastPrompt: reply } };
    }

    const ocr = await runOcrExtract({
      documentType: "BANK_DOCUMENT",
      mediaPath: payload.mediaPath,
      text,
    });

    const bankName = normalizeBankName(ocr.bankName);

    if (!bankName || !ocr.bankAccountNumber || ocr.confidence < 0.5) {
      const retries = (state.bankDocRetries ?? 0) + 1;
      if (retries > config.OCR_RETRY_LIMIT) {
        const reply =
          "I’m still struggling to read your bank document. Please type: BANK NAME, ACCOUNT NUMBER, ACCOUNT HOLDER.";
        return {
          replyText: reply,
          state: {
            ...state,
            bankDocRetries: retries,
            lastPrompt: reply,
          },
        };
      }

      const reply =
        "I couldn't read the bank document clearly. Please re-upload a clearer statement or bank letter.";
      return {
        replyText: reply,
        state: {
          ...state,
          bankDocRetries: retries,
          lastPrompt: reply,
        },
      };
    }

    const needsAccountHolder = !ocr.bankAccountHolderName;
    const nextState: OnboardingState = {
      ...state,
      bankName,
      bankAccountNumber: ocr.bankAccountNumber,
      bankAccountHolderName: ocr.bankAccountHolderName,
      pendingBankNeedsAccountHolder: needsAccountHolder,
      bankDocRetries: 0,
      step: needsAccountHolder ? "BANK_ACCOUNT_HOLDER" : "BANK_CONFIRM",
    };

    await persistFields(nextState, {
      BANK_NAME: bankName,
      BANK_ACCOUNT_NUMBER: ocr.bankAccountNumber,
      BANK_ACCOUNT_TYPE: "CURRENT",
      ...(ocr.bankAccountHolderName
        ? { BANK_ACCOUNT_HOLDER_NAME: ocr.bankAccountHolderName }
        : {}),
    });

    if (nextState.merchantId) {
      await backendClient
        .saveBankAccount(nextState.merchantId, {
          bankName,
          accountNumber: ocr.bankAccountNumber,
          accountType: "CURRENT",
          ...(ocr.bankAccountHolderName
            ? { accountHolderName: ocr.bankAccountHolderName }
            : {}),
        })
        .catch((error) => {
          logger.warn({ error }, "Failed to persist bank account on profile API");
        });
    }

    if (needsAccountHolder) {
      const reply = "Please type the bank account holder name.";
      return {
        replyText: reply,
        state: {
          ...nextState,
          lastPrompt: reply,
        },
      };
    }

    const reply = `I extracted:\n- Bank: ${nextState.bankName}\n- Account number: ${nextState.bankAccountNumber}\n- Account holder: ${nextState.bankAccountHolderName}\nReply YES to confirm or NO to retry.`;
    return {
      replyText: reply,
      state: {
        ...nextState,
        lastPrompt: reply,
      },
    };
  }

  if (state.step === "BANK_ACCOUNT_HOLDER") {
    if (!text) {
      const reply = "Please type the account holder name to continue.";
      return { replyText: reply, state: { ...state, lastPrompt: reply } };
    }

    const nextState: OnboardingState = {
      ...state,
      bankAccountHolderName: text,
      step: "BANK_CONFIRM",
    };

    await persistFields(nextState, {
      BANK_ACCOUNT_HOLDER_NAME: text,
      BANK_ACCOUNT_TYPE: "CURRENT",
    });

    const reply = `Thanks. Please confirm:\n- Bank: ${nextState.bankName}\n- Account number: ${nextState.bankAccountNumber}\n- Account holder: ${nextState.bankAccountHolderName}\nReply YES to confirm or NO to retry.`;
    return {
      replyText: reply,
      state: {
        ...nextState,
        lastPrompt: reply,
      },
    };
  }

  if (state.step === "BANK_CONFIRM") {
    const normalized = text.toLowerCase();
    if (normalized !== "yes" && normalized !== "y") {
      const reply = "No problem — please upload your proof of banking again.";
      return {
        replyText: reply,
        state: {
          ...state,
          step: "BANK_DOCUMENT",
          bankDocRetries: (state.bankDocRetries ?? 0) + 1,
          lastPrompt: reply,
        },
      };
    }

    if (!state.merchantId || !state.applicationId) {
      throw new Error("Missing merchant/application state for selfie handoff");
    }

    const selfie = createSelfieLink(state.merchantId, state.applicationId);
    const nextState: OnboardingState = {
      ...state,
      selfieLink: selfie.url,
      step: "SELFIE_WAIT",
    };

    const reply = `Please complete your selfie verification here:\n${selfie.url}\nReply DONE once completed.`;
    return { replyText: reply, state: { ...nextState, lastPrompt: reply } };
  }

  if (state.step === "SELFIE_WAIT") {
    const normalized = text.toLowerCase();
    if (
      !["done", "complete", "completed", "yes", "y"].some((item) =>
        normalized.includes(item),
      )
    ) {
      const reply = "Please reply DONE once you have completed the selfie step.";
      return { replyText: reply, state: { ...state, lastPrompt: reply } };
    }

    if (!state.merchantId || !state.applicationId) {
      throw new Error("Missing merchant/application for selfie completion check");
    }

    const snapshot = await backendClient
      .getApplicationSnapshot(state.merchantId, state.applicationId)
      .catch(() => null);
    const selfieResource =
      snapshot?.fields?.DOCUMENT_SELFIE_RESOURCE_URI ??
      snapshot?.raw?.DOCUMENT_SELFIE_RESOURCE_URI;

    if (!selfieResource) {
      const reply =
        "I could not detect a completed selfie yet. Please finish the selfie flow, then reply DONE again.";
      return { replyText: reply, state: { ...state, lastPrompt: reply } };
    }

    await backendClient.closeApplication(state.merchantId, state.applicationId);
    await backendClient
      .publishFlowEvent(state.applicationId, "application_submitted", {
        step: "SUBMIT",
      })
      .catch(() => {});

    const nextState: OnboardingState = {
      ...state,
      step: "COMPLETED",
    };

    const reply =
      "✅ Your sole proprietor onboarding application has been submitted. Verification is now in progress and we’ll update you soon.";
    return { replyText: reply, state: { ...nextState, lastPrompt: reply } };
  }

  const reply = "I didn’t understand that. Reply HELP for options.";
  return {
    replyText: reply,
    state: {
      ...state,
      lastPrompt: reply,
    },
  };
}

export async function createSelfieLinkPayload(payload: {
  merchantId: string;
  applicationId: string;
}) {
  return createSelfieLink(payload.merchantId, payload.applicationId);
}

export const onboardingBackend = backendClient;
