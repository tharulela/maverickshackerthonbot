import { createHmac, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import axios from "axios";
import { PDFParse } from "pdf-parse";
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
  "GoTyme Bank",
  "African Bank",
  "Bidvest",
  "Discovery Bank",
  "Investec",
  "Sasfin",
  "Ubank",
];

const BANK_ALIASES: Array<{ alias: string; bank: string }> = [
  { alias: "first national bank", bank: "FNB" },
  { alias: "first national", bank: "FNB" },
  { alias: "fnb", bank: "FNB" },
  { alias: "f n b", bank: "FNB" },
  { alias: "firstrand", bank: "FNB" },
  { alias: "capitec bank", bank: "Capitec" },
  { alias: "capitecbank", bank: "Capitec" },
  { alias: "nedbank", bank: "Nedbank" },
  { alias: "nedbank limited", bank: "Nedbank" },
  { alias: "standard bank", bank: "Standard Bank" },
  { alias: "standardbank", bank: "Standard Bank" },
  { alias: "standard bank of south africa", bank: "Standard Bank" },
  { alias: "absa", bank: "ABSA" },
  { alias: "absa bank", bank: "ABSA" },
  { alias: "absa bank limited", bank: "ABSA" },
  { alias: "tymebank", bank: "TymeBank" },
  { alias: "tyme bank", bank: "TymeBank" },
  { alias: "gotyme", bank: "GoTyme Bank" },
  { alias: "gotyme bank", bank: "GoTyme Bank" },
  { alias: "go tyme", bank: "GoTyme Bank" },
  { alias: "go tyme bank", bank: "GoTyme Bank" },
  { alias: "african bank", bank: "African Bank" },
  { alias: "bidvest", bank: "Bidvest" },
  { alias: "discovery bank", bank: "Discovery Bank" },
  { alias: "investec", bank: "Investec" },
  { alias: "sasfin", bank: "Sasfin" },
  { alias: "ubank", bank: "Ubank" },
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
  | "BANK_ACCOUNT_NUMBER"
  | "BANK_NAME"
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
  principalFirstName?: string;
  principalLastName?: string;
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
  principalFirstName?: string;
  principalLastName?: string;
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

interface BackendApplicationApiItem {
  id?: string;
  applicationId?: string;
  status?: string;
  fields?: Record<string, unknown>;
  applicationFields?: Record<string, unknown>;
  DOCUMENT_SELFIE_RESOURCE_URI?: string;
  [key: string]: unknown;
}

interface DhaDetailsResponse {
  hasPhoto?: boolean;
  dateOfBirth?: string;
  isSouthAfricanCitizen?: boolean;
  [key: string]: unknown;
}

interface BackendClientConfig {
  timeoutMs: number;
  authToken?: string;
  authHeader: string;
}

interface MockBackendApplication {
  applicationId: string;
  status: string;
  fields: Record<string, unknown>;
}

class BackendClient {
  private static readonly mockApplications = new Map<
    string,
    MockBackendApplication
  >();
  private static mockModeLogged = false;
  private readonly useMockBackend = config.MOCK_BACKEND;

  constructor(private readonly cfg: BackendClientConfig) {}

  async findInProgressApplication(
    merchantId: string,
  ): Promise<BackendApplication | null> {
    if (this.useMockBackend) {
      const app = this.getMockApplication(merchantId);
      if (!app) {
        return null;
      }

      return {
        applicationId: app.applicationId,
        status: app.status,
        fields: app.fields,
        raw: { ...app.fields },
      };
    }

    const data = await this.requestJson<BackendApplicationApiItem[]>(
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
    if (this.useMockBackend) {
      const app = this.getMockApplication(merchantId);
      if (!app || app.applicationId !== applicationId) {
        return null;
      }

      return {
        applicationId: app.applicationId,
        status: app.status,
        fields: app.fields,
        raw: { ...app.fields },
      };
    }

    const data = await this.requestJson<BackendApplicationApiItem[]>(
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
    if (this.useMockBackend) {
      const applicationId = `mock-app-${randomUUID()}`;
      this.setMockApplication(merchantId, {
        applicationId,
        status: "IN_PROGRESS",
        fields: { BUSINESS_TYPE: "SOLE_PROPRIETOR" },
      });
      return applicationId;
    }

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
    if (this.useMockBackend) {
      const existing = this.getMockApplication(merchantId);
      this.setMockApplication(merchantId, {
        applicationId,
        status: existing?.status ?? "IN_PROGRESS",
        fields: {
          ...(existing?.fields ?? {}),
          ...fields,
        },
      });
      return;
    }

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
    if (this.useMockBackend) {
      const existing = this.getMockApplication(merchantId);
      this.setMockApplication(merchantId, {
        applicationId,
        status: "COMPLETED",
        fields: existing?.fields ?? {},
      });
      return;
    }

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
    if (this.useMockBackend) {
      const existing = this.getMockApplication(merchantId);
      if (existing) {
        this.setMockApplication(merchantId, {
          ...existing,
          fields: { ...existing.fields, ...payload },
        });
      }
      return;
    }

    await this.requestJson(
      "POST",
      this.profilePath(
        `/profile/v1/merchants/${encodeURIComponent(merchantId)}/bankaccounts`,
      ),
      payload,
    );
  }

  async getDhaDetails(personalIdNumber: string): Promise<DhaDetailsResponse> {
    if (this.useMockBackend) {
      return {
        hasPhoto: true,
        dateOfBirth: "1990-01-01",
        isSouthAfricanCitizen: true,
        personalIdNumber,
      };
    }

    return await this.requestJson(
      "GET",
      this.relyPath(
        `/rely-comply-broker/v1/get-dha-details/${encodeURIComponent(
          personalIdNumber,
        )}`,
      ),
    );
  }

  async classifyBusinessIndustry(
    description: string,
  ): Promise<string | undefined> {
    if (this.useMockBackend) {
      return "5999";
    }

    const url =
      config.MCC_CLASSIFIER_URL ??
      this.onboardingPath("/api/classify-business-industry");
    const result = await this.requestJson<Record<string, unknown>>(
      "POST",
      url,
      {
        description,
      },
    );
    return String(result?.mccCode ?? result?.code ?? "") || undefined;
  }

  async publishFlowEvent(
    applicationId: string,
    event: string,
    meta: Record<string, unknown> = {},
  ): Promise<void> {
    if (this.useMockBackend) {
      return;
    }

    const path = this.hsproxyPath(
      `/hsproxy/applications/application-id/${encodeURIComponent(
        applicationId,
      )}/ui-flow-events/publish`,
    );
    await this.requestJson("POST", path, {
      event,
      meta,
      source: "whatsapp_poc",
    });
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

  private getMockApplication(
    merchantId: string,
  ): MockBackendApplication | undefined {
    this.logMockModeOnce();
    return BackendClient.mockApplications.get(merchantId);
  }

  private setMockApplication(
    merchantId: string,
    app: MockBackendApplication,
  ): void {
    this.logMockModeOnce();
    BackendClient.mockApplications.set(merchantId, app);
  }

  private logMockModeOnce(): void {
    if (BackendClient.mockModeLogged) {
      return;
    }
    BackendClient.mockModeLogged = true;
    logger.warn(
      "MOCK_BACKEND enabled; using in-memory onboarding API responses",
    );
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
  const futureToleranceYears = 10;
  const century =
    yy <= currentTwoDigitYear + futureToleranceYears ? 2000 : 1900;
  const year = century + yy;

  const date = new Date(Date.UTC(year, mm - 1, dd));
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }

  return date.toISOString().slice(0, 10);
}

function normalizeDateToIso(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const raw = value.trim();
  if (!raw) {
    return undefined;
  }

  // Already ISO-like (YYYY-MM-DD)
  const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    const year = Number(isoMatch[1]);
    const month = Number(isoMatch[2]);
    const day = Number(isoMatch[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (
      !Number.isNaN(date.getTime()) &&
      date.getUTCFullYear() === year &&
      date.getUTCMonth() + 1 === month &&
      date.getUTCDate() === day
    ) {
      return date.toISOString().slice(0, 10);
    }
  }

  // Compact format YYYYMMDD
  const compactIso = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compactIso) {
    return normalizeDateToIso(
      `${compactIso[1]}-${compactIso[2]}-${compactIso[3]}`,
    );
  }

  // Slash/dot format: DD/MM/YYYY or MM/DD/YYYY (default to DD/MM for ZA context)
  const slash = raw.match(/^(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})$/);
  if (slash) {
    const a = Number(slash[1]);
    const b = Number(slash[2]);
    const year = Number(slash[3]);

    const asDayMonth = normalizeDateToIso(
      `${year}-${String(b).padStart(2, "0")}-${String(a).padStart(2, "0")}`,
    );
    const asMonthDay = normalizeDateToIso(
      `${year}-${String(a).padStart(2, "0")}-${String(b).padStart(2, "0")}`,
    );

    if (asDayMonth && !asMonthDay) return asDayMonth;
    if (!asDayMonth && asMonthDay) return asMonthDay;
    if (asDayMonth && asMonthDay) return asDayMonth;
  }

  return undefined;
}

function normalizeBankName(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }

  const lowered = raw.toLowerCase().trim();
  const normalized = lowered.replace(/[^a-z0-9]+/g, " ").trim();
  const compact = normalized.replace(/\s+/g, "");

  const direct = SUPPORTED_BANKS.find((item) => {
    const candidate = item.toLowerCase();
    return candidate === lowered || candidate === normalized;
  });
  if (direct) {
    return direct;
  }

  for (const entry of BANK_ALIASES) {
    const alias = entry.alias.toLowerCase();
    const aliasNormalized = alias.replace(/[^a-z0-9]+/g, " ").trim();
    const aliasCompact = aliasNormalized.replace(/\s+/g, "");
    if (
      lowered.includes(alias) ||
      normalized.includes(aliasNormalized) ||
      compact.includes(aliasCompact)
    ) {
      return entry.bank;
    }
  }

  return SUPPORTED_BANKS.find((item) => {
    const candidate = item.toLowerCase();
    const candidateNormalized = candidate.replace(/[^a-z0-9]+/g, " ").trim();
    const candidateCompact = candidateNormalized.replace(/\s+/g, "");
    return (
      lowered.includes(candidate) ||
      normalized.includes(candidateNormalized) ||
      compact.includes(candidateCompact)
    );
  });
}

function normalizeAccountNumber(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }

  const digits = raw.replace(/\D/g, "");
  if (digits.length < 6 || digits.length > 16) {
    return undefined;
  }
  return digits;
}

function parseManualBankText(text: string): {
  bankName?: string;
  bankAccountNumber?: string;
  bankAccountHolderName?: string;
} {
  const parts = text
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length >= 2) {
    return {
      bankName: parts[0],
      bankAccountNumber: normalizeAccountNumber(parts[1]),
      bankAccountHolderName: parts.slice(2).join(", ") || undefined,
    };
  }

  const accountMatch = text.match(
    /(?:account\s*(?:number|no\.?|#)?\s*[:\-]?\s*)([\d\s-]{6,24})/i,
  );
  const holderMatch = text.match(
    /(?:account\s*holder|name)\s*[:\-]?\s*([A-Za-z\s'`.-]{3,80})/i,
  );

  return {
    bankName: normalizeBankName(text) ?? undefined,
    bankAccountNumber: normalizeAccountNumber(accountMatch?.[1]),
    bankAccountHolderName: holderMatch?.[1]?.trim(),
  };
}

async function safeReadMediaFile(mediaPath?: string): Promise<string> {
  if (!mediaPath) {
    return "";
  }

  const extension = path.extname(mediaPath).toLowerCase();
  if (extension === ".pdf") {
    try {
      const buffer = await fs.readFile(mediaPath);
      const parser = new PDFParse({ data: buffer });
      const parsed = await parser.getText();
      await parser.destroy();
      return String(parsed.text ?? "").trim();
    } catch (error) {
      logger.warn({ err: error }, "PDF text extraction failed");
      return "";
    }
  }

  const textLike = new Set([".txt", ".csv", ".json", ".md", ".xml"]);

  if (!textLike.has(extension)) {
    return "";
  }

  try {
    return await fs.readFile(mediaPath, "utf8");
  } catch {
    return "";
  }
}

async function runOpenAiTextOcr(
  request: OcrExtractRequest,
  sourceText: string,
): Promise<Partial<OcrExtractResponse> | null> {
  if (!config.OPENAI_API_KEY || !sourceText.trim()) {
    return null;
  }

  try {
    const prompt =
      request.documentType === "SA_ID"
        ? "Extract SA ID info from the supplied text. Return strict JSON with keys: principalFirstName (string|null), principalLastName (string|null), principalIdNumber (string|null), userDateOfBirth (YYYY-MM-DD|null), isSouthAfricanCitizen (boolean|null), documentKind ('sa_id'|'passport'|'unknown'), confidence (0..1)."
        : "Extract bank proof info from the supplied text. Return strict JSON with keys: bankName (string|null), bankAccountNumber (string|null), bankAccountHolderName (string|null), confidence (0..1).";

    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You are an OCR extraction service. Output only valid JSON.",
          },
          {
            role: "user",
            content: `${prompt}\n\nDocument text:\n${sourceText}`,
          },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${config.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: config.REQUEST_TIMEOUT_MS,
      },
    );

    const raw = String(response.data?.choices?.[0]?.message?.content ?? "");
    const parsed = extractJsonObject(raw);
    if (!parsed) {
      return null;
    }

    return parsed as Partial<OcrExtractResponse>;
  } catch (error) {
    logger.warn(
      { err: error },
      "OpenAI text OCR failed; falling back to heuristic parsing",
    );
    return null;
  }
}

function mediaPathToMimeType(mediaPath: string): string {
  const extension = path.extname(mediaPath).toLowerCase();
  switch (extension) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".bmp":
      return "image/bmp";
    default:
      return "application/octet-stream";
  }
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }

  const candidate = text.slice(start, end + 1);
  try {
    return JSON.parse(candidate) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function runOpenAiMediaOcr(
  request: OcrExtractRequest,
): Promise<Partial<OcrExtractResponse> | null> {
  if (!config.OPENAI_API_KEY || !request.mediaPath) {
    return null;
  }

  const mimeType = mediaPathToMimeType(request.mediaPath);
  if (!mimeType.startsWith("image/")) {
    return null;
  }

  try {
    const imageBuffer = await fs.readFile(request.mediaPath);
    const dataUrl = `data:${mimeType};base64,${imageBuffer.toString("base64")}`;

    const prompt =
      request.documentType === "SA_ID"
        ? "Extract SA ID info. Return strict JSON with keys: principalFirstName (string|null), principalLastName (string|null), principalIdNumber (string|null), userDateOfBirth (YYYY-MM-DD|null), isSouthAfricanCitizen (boolean|null), documentKind ('sa_id'|'passport'|'unknown'), confidence (0..1)."
        : "Extract bank proof info. Return strict JSON with keys: bankName (string|null), bankAccountNumber (string|null), bankAccountHolderName (string|null), confidence (0..1).";

    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You are an OCR extraction service. Output only valid JSON.",
          },
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${config.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: config.REQUEST_TIMEOUT_MS,
      },
    );

    const raw = String(response.data?.choices?.[0]?.message?.content ?? "");
    const parsed = extractJsonObject(raw);
    if (!parsed) {
      return null;
    }

    return parsed as Partial<OcrExtractResponse>;
  } catch (error) {
    logger.warn(
      { err: error },
      "OpenAI media OCR failed; falling back to heuristic parsing",
    );
    return null;
  }
}

function hydrateStateFromFields(
  state: OnboardingState,
  fields: Record<string, unknown>,
): OnboardingState {
  return {
    ...state,
    businessName: String(
      fields.BUSINESS_REGISTERED_NAME ?? state.businessName ?? "",
    ),
    businessDescription: String(
      fields.BUSINESS_DESCRIPTION ?? state.businessDescription ?? "",
    ),
    mccCode: String(fields.BUSINESS_MCC_CODE ?? state.mccCode ?? ""),
    principalFirstName: String(
      fields.PRINCIPAL_FIRST_NAME ?? state.principalFirstName ?? "",
    ),
    principalLastName: String(
      fields.PRINCIPAL_LAST_NAME ?? state.principalLastName ?? "",
    ),
    principalIdNumber: String(
      fields.PRINCIPAL_ID_NUMBER ?? state.principalIdNumber ?? "",
    ),
    userDateOfBirth: String(
      fields.USER_DATE_OF_BIRTH ?? state.userDateOfBirth ?? "",
    ),
    bankName: String(fields.BANK_NAME ?? state.bankName ?? ""),
    bankAccountNumber: String(
      fields.BANK_ACCOUNT_NUMBER ?? state.bankAccountNumber ?? "",
    ),
    bankAccountHolderName: String(
      fields.BANK_ACCOUNT_HOLDER_NAME ?? state.bankAccountHolderName ?? "",
    ),
  };
}

export async function runOcrExtract(
  request: OcrExtractRequest,
): Promise<OcrExtractResponse> {
  const inlineText = (request.text ?? "").trim();
  const fileText = await safeReadMediaFile(request.mediaPath);
  const source = `${inlineText}\n${fileText}`.trim();
  const lower = source.toLowerCase();
  const aiTextOcr = await runOpenAiTextOcr(request, source);
  const aiMediaOcr = await runOpenAiMediaOcr(request);
  const aiOcr = {
    ...(aiTextOcr ?? {}),
    ...(aiMediaOcr ?? {}),
  } as Partial<OcrExtractResponse>;

  if (request.documentType === "SA_ID") {
    const heuristicSurname = source
      .match(/surname\s*[:\-]?\s*([A-Z][A-Z\s'-]{1,60})/i)?.[1]
      ?.trim();
    const heuristicNames = source
      .match(/(?:names|given\s*names?)\s*[:\-]?\s*([A-Z][A-Z\s'-]{1,80})/i)?.[1]
      ?.trim();
    const aiFirstName =
      typeof aiOcr?.principalFirstName === "string" &&
      aiOcr.principalFirstName.trim()
        ? aiOcr.principalFirstName.trim()
        : undefined;
    const aiLastName =
      typeof aiOcr?.principalLastName === "string" &&
      aiOcr.principalLastName.trim()
        ? aiOcr.principalLastName.trim()
        : undefined;
    const principalFirstName = aiFirstName ?? heuristicNames;
    const principalLastName = aiLastName ?? heuristicSurname;

    const idMatch = source.match(/\b\d{13}\b/);
    const primaryId =
      aiOcr?.principalIdNumber && aiOcr.principalIdNumber.length === 13
        ? aiOcr.principalIdNumber
        : idMatch?.[0];
    const idDob = primaryId
      ? extractDateFromSouthAfricanId(primaryId)
      : undefined;
    const ocrDob = normalizeDateToIso(aiOcr?.userDateOfBirth);
    const dob = idDob && ocrDob && idDob !== ocrDob ? idDob : (ocrDob ?? idDob);
    const isPassport =
      aiOcr?.documentKind === "passport" ||
      lower.includes("passport") ||
      lower.includes("foreign") ||
      lower.includes("non-sa");
    const isSouthAfricanCitizen = aiOcr?.isSouthAfricanCitizen ?? !isPassport;

    let confidence = 0.2;
    if (primaryId) {
      confidence = 0.85;
    }
    if (typeof aiOcr?.confidence === "number") {
      confidence = aiOcr.confidence;
    }
    if (!source) {
      confidence = Math.max(confidence, aiOcr?.confidence ?? 0.1);
    }

    return {
      documentType: "SA_ID",
      confidence,
      documentKind: isPassport ? "passport" : primaryId ? "sa_id" : "unknown",
      isSouthAfricanCitizen,
      principalIdNumber: primaryId,
      principalFirstName,
      principalLastName,
      userDateOfBirth: dob,
    };
  }

  const labelledAccountMatch = source.match(
    /(?:account\s*(?:number|no\.?|#)?\s*[:\-]?\s*)([\d\s-]{6,24})/i,
  );
  const accountNumberMatch = source.match(/\b\d{6,16}\b/);
  const manualBank = parseManualBankText(source);
  const bankName =
    normalizeBankName(aiOcr?.bankName) ??
    normalizeBankName(manualBank.bankName) ??
    normalizeBankName(source);
  const accountHolderMatch = source.match(
    /account\s*holder[:\-]?\s*([A-Za-z\s]{3,60})/i,
  );
  const bankAccountNumber =
    normalizeAccountNumber(aiOcr?.bankAccountNumber) ??
    normalizeAccountNumber(labelledAccountMatch?.[1]) ??
    normalizeAccountNumber(accountNumberMatch?.[0]);
  const bankAccountHolderName =
    typeof aiOcr?.bankAccountHolderName === "string" &&
    aiOcr.bankAccountHolderName.trim()
      ? aiOcr.bankAccountHolderName.trim()
      : accountHolderMatch?.[1]?.trim();

  let confidence = 0.2;
  if (bankAccountNumber && bankName) {
    confidence = 0.85;
  } else if (bankAccountNumber || bankName) {
    confidence = 0.55;
  }
  if (typeof aiOcr?.confidence === "number") {
    confidence = aiOcr.confidence;
  }

  // Keep confidence aligned with extracted mandatory fields to reduce false negatives.
  if (bankAccountNumber && bankName) {
    confidence = Math.max(confidence, 0.8);
  }

  if (!source) {
    confidence = Math.max(confidence, aiOcr?.confidence ?? 0.1);
  }

  return {
    documentType: "BANK_DOCUMENT",
    confidence,
    documentKind: "bank_document",
    bankName,
    bankAccountNumber,
    bankAccountHolderName,
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
    throw new Error(
      "Cannot persist fields without merchant and application context",
    );
  }

  await backendClient.updateApplication(
    state.merchantId,
    state.applicationId,
    fields,
  );
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

function maskSensitive(value: string | undefined, keepLast = 4): string {
  if (!value) {
    return "";
  }

  const sanitized = value.replace(/\s+/g, "");
  if (sanitized.length <= keepLast) {
    return "*".repeat(sanitized.length);
  }
  return `${"*".repeat(Math.max(0, sanitized.length - keepLast))}${sanitized.slice(-keepLast)}`;
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
      return {
        state: nextState,
        reply: "Updated your business name. Let’s continue.",
      };
    }

    if (state.editField === "ADDRESS") {
      const address = parseAddress(text);
      nextState.businessAddress = address;
      await persistFields(
        nextState,
        buildAddressFieldPayload("ADDRESS", address),
      );
      return {
        state: nextState,
        reply: "Updated your business address. Let’s continue.",
      };
    }

    if (state.editField === "USER_ADDRESS") {
      const address = parseAddress(text);
      nextState.residentialAddress = address;
      await persistFields(
        nextState,
        buildAddressFieldPayload("USER_ADDRESS", address),
      );
      return {
        state: nextState,
        reply: "Updated your residential address. Let’s continue.",
      };
    }

    if (
      state.editField === "BANK" ||
      state.editField === "BANK_ACCOUNT_HOLDER_NAME"
    ) {
      const bankOcr = await runOcrExtract({
        documentType: "BANK_DOCUMENT",
        text,
      });
      nextState.bankName = bankOcr.bankName ?? state.bankName;
      nextState.bankAccountNumber =
        bankOcr.bankAccountNumber ?? state.bankAccountNumber;
      nextState.bankAccountHolderName =
        state.editField === "BANK_ACCOUNT_HOLDER_NAME"
          ? text
          : (bankOcr.bankAccountHolderName ?? state.bankAccountHolderName);

      await persistFields(nextState, {
        BANK_NAME: nextState.bankName,
        BANK_ACCOUNT_NUMBER: nextState.bankAccountNumber,
        BANK_ACCOUNT_HOLDER_NAME: nextState.bankAccountHolderName,
        BANK_ACCOUNT_TYPE: "CURRENT",
      });

      return {
        state: nextState,
        reply: "Updated your banking details. Let’s continue.",
      };
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
    logger.warn(
      { err: error },
      "Resume lookup failed; continuing with new application flow",
    );
  }

  if (inProgress?.applicationId) {
    nextState = {
      ...hydrateStateFromFields(nextState, inProgress.fields ?? {}),
      applicationId: inProgress.applicationId,
      step:
        inferStepFromApplicationFields(inProgress.fields ?? {}) ??
        "BUSINESS_NAME",
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
  const hasResidential = Boolean(
    fields.USER_ADDRESS_STREET1 || fields.USER_ADDRESS_CITY,
  );
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
      return {
        state: { ...state, helpActive: false },
        reply: "Great, let’s continue onboarding.",
      };
    }

    if (normalized === "2" || normalized.includes("change")) {
      return {
        state: { ...state, helpActive: false },
        reply:
          "What would you like to change? (business name, business address, residential address, bank)",
      };
    }

    if (normalized === "3" || normalized.includes("support")) {
      return {
        state: { ...state, helpActive: false },
        reply:
          "A support consultant will contact you shortly. You can still continue onboarding here anytime.",
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
      await backendClient.publishFlowEvent(
        state.applicationId,
        "message_received",
        {
          step: state.step,
          messageType: payload.type,
        },
      );
    } catch (error) {
      logger.warn({ err: error }, "Failed to publish funnel event");
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
      replyText:
        state.lastPrompt ?? "This onboarding session is closed for now.",
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
      step: state.isAIpoweredMccEnabled
        ? "BUSINESS_DESCRIPTION"
        : "BUSINESS_ADDRESS",
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

    const reply =
      "Please upload your South African ID document (image or PDF).";
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

    if (
      ocr.documentKind === "passport" ||
      ocr.isSouthAfricanCitizen === false
    ) {
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
    const idDob = extractDateFromSouthAfricanId(idNumber);
    const ocrDob = normalizeDateToIso(ocr.userDateOfBirth);
    let dob = idDob && ocrDob && idDob !== ocrDob ? idDob : (ocrDob ?? idDob);
    let dhaHasPhoto = false;
    let isSouthAfricanCitizen: boolean = ocr.isSouthAfricanCitizen ?? true;

    try {
      const dha = await backendClient.getDhaDetails(idNumber);
      if (typeof dha?.hasPhoto === "boolean") {
        dhaHasPhoto = dha.hasPhoto;
      }
      if (typeof dha?.dateOfBirth === "string" && dha.dateOfBirth) {
        const dhaDob = normalizeDateToIso(dha.dateOfBirth);
        if (dhaDob) {
          if (idDob && dhaDob !== idDob) {
            logger.warn(
              { idDob, dhaDob },
              "DHA DOB differs from SA ID-derived DOB; keeping ID-derived value",
            );
          } else {
            dob = dhaDob;
          }
        }
      }
      if (typeof dha?.isSouthAfricanCitizen === "boolean") {
        isSouthAfricanCitizen = dha.isSouthAfricanCitizen;
      }
    } catch (error) {
      logger.warn(
        { err: error },
        "DHA lookup failed; continuing with OCR data",
      );
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
      principalFirstName: ocr.principalFirstName,
      principalLastName: ocr.principalLastName,
      userDateOfBirth: dob,
      userIsSouthAfricanCitizen: true,
      dhaHasPhoto,
      step: "ID_CONFIRM",
      idDocRetries: 0,
    };

    await persistFields(nextState, {
      PRINCIPAL_ID_NUMBER: idNumber,
      ...(ocr.principalFirstName
        ? { PRINCIPAL_FIRST_NAME: ocr.principalFirstName }
        : {}),
      ...(ocr.principalLastName
        ? { PRINCIPAL_LAST_NAME: ocr.principalLastName }
        : {}),
      USER_IS_SOUTH_AFRICAN_CITIZEN: true,
      USER_DATE_OF_BIRTH: dob,
    });

    const pathNote = dhaHasPhoto
      ? "DHA photo found, so selfie handoff later will be enough."
      : "DHA photo missing; we will rely on your uploaded ID plus selfie handoff.";
    const nameLine =
      nextState.principalFirstName || nextState.principalLastName
        ? `- Name: ${[nextState.principalFirstName, nextState.principalLastName]
            .filter(Boolean)
            .join(" ")}\n`
        : "";
    const reply = `I extracted:\n${nameLine}- ID number: ${maskSensitive(idNumber)}\n- Date of birth: ${dob}\n${pathNote}\nReply YES to confirm or NO to retry.`;
    return { replyText: reply, state: { ...nextState, lastPrompt: reply } };
  }

  if (state.step === "ID_CONFIRM") {
    const normalized = text.toLowerCase();
    if (normalized !== "yes" && normalized !== "y") {
      const retries = (state.idDocRetries ?? 0) + 1;
      const nextState: OnboardingState = {
        ...state,
        step: "ID_DOCUMENT",
        idDocRetries: retries,
      };
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

    await persistFields(
      nextState,
      buildAddressFieldPayload("USER_ADDRESS", residentialAddress),
    );

    const reply =
      "Please upload your proof of banking (statement or bank letter).";
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

    const manualSource = [
      text,
      ocr.bankName,
      ocr.bankAccountNumber,
      ocr.bankAccountHolderName,
    ]
      .filter(Boolean)
      .join(", ");
    const manual = parseManualBankText(manualSource);

    const bankName =
      normalizeBankName(ocr.bankName) ?? normalizeBankName(manual.bankName);
    const bankAccountNumber =
      normalizeAccountNumber(ocr.bankAccountNumber) ??
      normalizeAccountNumber(manual.bankAccountNumber);
    const inferredHolderName = [
      state.principalFirstName,
      state.principalLastName,
    ]
      .filter(Boolean)
      .join(" ");
    const bankAccountHolderName =
      ocr.bankAccountHolderName ??
      manual.bankAccountHolderName ??
      (inferredHolderName || undefined);

    logger.info(
      {
        mediaPath: payload.mediaPath,
        ocr: {
          confidence: ocr.confidence,
          bankName: ocr.bankName,
          bankAccountNumberMasked: maskSensitive(ocr.bankAccountNumber),
          bankAccountHolderName: ocr.bankAccountHolderName,
        },
        manual: {
          bankName: manual.bankName,
          bankAccountNumberMasked: maskSensitive(manual.bankAccountNumber),
          bankAccountHolderName: manual.bankAccountHolderName,
        },
        resolved: {
          bankName,
          bankAccountNumberMasked: maskSensitive(bankAccountNumber),
          bankAccountHolderName,
        },
      },
      "Bank notification letter parsed",
    );

    if (!bankAccountNumber) {
      const resolvedBankName = bankName ?? state.bankName ?? undefined;
      const resolvedAccountHolder =
        bankAccountHolderName ?? state.bankAccountHolderName ?? undefined;
      const nextState: OnboardingState = {
        ...state,
        bankName: resolvedBankName,
        bankAccountHolderName: resolvedAccountHolder,
        pendingBankNeedsAccountHolder: !resolvedAccountHolder,
        bankDocRetries: (state.bankDocRetries ?? 0) + 1,
        step: "BANK_ACCOUNT_NUMBER",
      };

      await persistFields(nextState, {
        ...(resolvedBankName ? { BANK_NAME: resolvedBankName } : {}),
        ...(resolvedAccountHolder
          ? { BANK_ACCOUNT_HOLDER_NAME: resolvedAccountHolder }
          : {}),
      });

      const reply =
        "I could not read the account number clearly. Please type the account number.";
      logger.info(
        {
          mediaPath: payload.mediaPath,
          bankName: resolvedBankName,
          bankAccountHolderName: resolvedAccountHolder,
          retry: nextState.bankDocRetries,
        },
        "Bank notification letter missing account number; prompting manual entry",
      );
      return {
        replyText: reply,
        state: {
          ...nextState,
          lastPrompt: reply,
        },
      };
    }

    const effectiveConfidence = Math.max(ocr.confidence, 0.8);

    const resolvedBankName = bankName ?? state.bankName ?? undefined;
    const needsBankName = !resolvedBankName;
    const needsAccountHolder = !bankAccountHolderName;
    logger.info(
      {
        mediaPath: payload.mediaPath,
        bankName: resolvedBankName,
        bankAccountNumberMasked: maskSensitive(bankAccountNumber),
        bankAccountHolderName,
        needsBankName,
        needsAccountHolder,
      },
      "Bank notification letter extraction routed",
    );
    const nextState: OnboardingState = {
      ...state,
      bankName: resolvedBankName,
      bankAccountNumber,
      bankAccountHolderName,
      pendingBankNeedsAccountHolder: needsBankName || needsAccountHolder,
      bankDocRetries: 0,
      step: needsBankName
        ? "BANK_NAME"
        : needsAccountHolder
          ? "BANK_ACCOUNT_HOLDER"
          : "BANK_CONFIRM",
    };

    await persistFields(nextState, {
      ...(resolvedBankName ? { BANK_NAME: resolvedBankName } : {}),
      BANK_ACCOUNT_NUMBER: bankAccountNumber,
      BANK_ACCOUNT_TYPE: "CURRENT",
      ...(bankAccountHolderName
        ? { BANK_ACCOUNT_HOLDER_NAME: bankAccountHolderName }
        : {}),
    });

    if (nextState.merchantId) {
      await backendClient
        .saveBankAccount(nextState.merchantId, {
          ...(resolvedBankName ? { bankName: resolvedBankName } : {}),
          accountNumber: bankAccountNumber,
          accountType: "CURRENT",
          ...(bankAccountHolderName
            ? { accountHolderName: bankAccountHolderName }
            : {}),
        })
        .catch((error) => {
          logger.warn(
            { err: error },
            "Failed to persist bank account on profile API",
          );
        });
    }

    if (needsBankName) {
      const reply =
        "I could read the account number, but not the bank name. Please type the bank name.";
      return {
        replyText: reply,
        state: {
          ...nextState,
          lastPrompt: reply,
        },
      };
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

    const reply = `I extracted:\n- Bank: ${nextState.bankName}\n- Account number: ${maskSensitive(nextState.bankAccountNumber)}\n- Account holder: ${nextState.bankAccountHolderName}\nReply YES to confirm or NO to retry.`;
    return {
      replyText: reply,
      state: {
        ...nextState,
        lastPrompt: reply,
      },
    };
  }

  if (state.step === "BANK_ACCOUNT_NUMBER") {
    if (!text) {
      const reply = "Please type the bank account number to continue.";
      return { replyText: reply, state: { ...state, lastPrompt: reply } };
    }

    const bankAccountNumber = normalizeAccountNumber(text);
    if (!bankAccountNumber) {
      const reply =
        "That account number looks invalid. Please type digits only (6 to 16 numbers).";
      return { replyText: reply, state: { ...state, lastPrompt: reply } };
    }

    const needsBankName = !state.bankName;
    const needsAccountHolder = !state.bankAccountHolderName;
    const nextState: OnboardingState = {
      ...state,
      bankAccountNumber,
      pendingBankNeedsAccountHolder: needsAccountHolder,
      step: needsBankName
        ? "BANK_NAME"
        : needsAccountHolder
          ? "BANK_ACCOUNT_HOLDER"
          : "BANK_CONFIRM",
    };

    await persistFields(nextState, {
      BANK_ACCOUNT_NUMBER: bankAccountNumber,
      BANK_ACCOUNT_TYPE: "CURRENT",
      ...(state.bankName ? { BANK_NAME: state.bankName } : {}),
      ...(state.bankAccountHolderName
        ? { BANK_ACCOUNT_HOLDER_NAME: state.bankAccountHolderName }
        : {}),
    });

    if (nextState.merchantId) {
      await backendClient
        .saveBankAccount(nextState.merchantId, {
          ...(state.bankName ? { bankName: state.bankName } : {}),
          accountNumber: bankAccountNumber,
          accountType: "CURRENT",
          ...(state.bankAccountHolderName
            ? { accountHolderName: state.bankAccountHolderName }
            : {}),
        })
        .catch((error) => {
          logger.warn(
            { err: error },
            "Failed to persist bank account on profile API",
          );
        });
    }

    if (needsBankName) {
      const reply = "Please type the bank name.";
      return {
        replyText: reply,
        state: {
          ...nextState,
          lastPrompt: reply,
        },
      };
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

    const reply = `I extracted:\n- Bank: ${nextState.bankName}\n- Account number: ${maskSensitive(nextState.bankAccountNumber)}\n- Account holder: ${nextState.bankAccountHolderName}\nReply YES to confirm or NO to retry.`;
    return {
      replyText: reply,
      state: {
        ...nextState,
        lastPrompt: reply,
      },
    };
  }

  if (state.step === "BANK_NAME") {
    if (!text) {
      const reply = "Please type the bank name to continue.";
      return { replyText: reply, state: { ...state, lastPrompt: reply } };
    }

    const bankName = normalizeBankName(text) ?? text.trim();
    const nextState: OnboardingState = {
      ...state,
      bankName,
      step: state.bankAccountHolderName
        ? "BANK_CONFIRM"
        : "BANK_ACCOUNT_HOLDER",
      pendingBankNeedsAccountHolder: !state.bankAccountHolderName,
    };

    await persistFields(nextState, { BANK_NAME: bankName });

    if (state.merchantId && state.bankAccountNumber) {
      await backendClient
        .saveBankAccount(state.merchantId, {
          bankName,
          accountNumber: state.bankAccountNumber,
          accountType: "CURRENT",
          ...(state.bankAccountHolderName
            ? { accountHolderName: state.bankAccountHolderName }
            : {}),
        })
        .catch((error) => {
          logger.warn(
            { err: error },
            "Failed to persist bank account on profile API",
          );
        });
    }

    if (!state.bankAccountHolderName) {
      const reply = "Please type the bank account holder name.";
      return {
        replyText: reply,
        state: {
          ...nextState,
          lastPrompt: reply,
        },
      };
    }

    const reply = `I extracted:\n- Bank: ${nextState.bankName}\n- Account number: ${maskSensitive(nextState.bankAccountNumber)}\n- Account holder: ${nextState.bankAccountHolderName}\nReply YES to confirm or NO to retry.`;
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

    const reply = `Thanks. Please confirm:\n- Bank: ${nextState.bankName}\n- Account number: ${maskSensitive(nextState.bankAccountNumber)}\n- Account holder: ${nextState.bankAccountHolderName}\nReply YES to confirm or NO to retry.`;
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
    if (
      !["yes", "y", "confirm", "confirmed", "ok", "okay"].includes(normalized)
    ) {
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
      const reply =
        "Please reply DONE once you have completed the selfie step.";
      return { replyText: reply, state: { ...state, lastPrompt: reply } };
    }

    if (!state.merchantId || !state.applicationId) {
      throw new Error(
        "Missing merchant/application for selfie completion check",
      );
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
