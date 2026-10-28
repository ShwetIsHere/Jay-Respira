import { logDiagnostic } from "./diagnostics";

export type RiskLevel = "low" | "medium" | "high";

export interface RiskModelInput {
  pm2_5_24h_mean: number;
  nitrogen_dioxide_24h_mean: number;
  ozone_8h_max: number;
}

export interface RiskModelOutput {
  prediction: number;
  risk_probability: number;
  risk_level: RiskLevel;
  features: RiskModelInput;
}

export function getRiskModelApiBaseUrl(): string {
  const value = process.env.EXPO_PUBLIC_RISK_MODEL_API_URL;
  if (!value) {
    throw new Error("EXPO_PUBLIC_RISK_MODEL_API_URL is not configured. Set it in mobile/.env and restart Expo.");
  }

  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Unsupported protocol");
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    throw new Error("EXPO_PUBLIC_RISK_MODEL_API_URL must be a valid HTTP(S) URL.");
  }
}

export function validateRiskModelInput(input: RiskModelInput): RiskModelInput {
  const payload: RiskModelInput = {
    pm2_5_24h_mean: Number(input.pm2_5_24h_mean),
    nitrogen_dioxide_24h_mean: Number(input.nitrogen_dioxide_24h_mean),
    ozone_8h_max: Number(input.ozone_8h_max),
  };

  for (const [key, value] of Object.entries(payload)) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Invalid model input for ${key}: ${value}`);
    }
  }

  return payload;
}

export function isValidRiskModelOutput(value: unknown): value is RiskModelOutput {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<RiskModelOutput>;
  return (
    (candidate.prediction === 0 || candidate.prediction === 1) &&
    typeof candidate.risk_probability === "number" &&
    Number.isFinite(candidate.risk_probability) &&
    candidate.risk_probability >= 0 &&
    candidate.risk_probability <= 1 &&
    (candidate.risk_level === "low" || candidate.risk_level === "medium" || candidate.risk_level === "high") &&
    typeof candidate.features === "object" && candidate.features !== null &&
    typeof candidate.features.pm2_5_24h_mean === "number" &&
    Number.isFinite(candidate.features.pm2_5_24h_mean) &&
    typeof candidate.features.nitrogen_dioxide_24h_mean === "number" &&
    Number.isFinite(candidate.features.nitrogen_dioxide_24h_mean) &&
    typeof candidate.features.ozone_8h_max === "number" &&
    Number.isFinite(candidate.features.ozone_8h_max)
  );
}

export async function fetchRiskPrediction(
  input: RiskModelInput,
  requestId = "not-linked",
): Promise<RiskModelOutput> {
  const sanitized = validateRiskModelInput(input);
  const baseUrl = getRiskModelApiBaseUrl();
  const endpoint = new URL("/predict", baseUrl);
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  logDiagnostic(requestId, "MODEL_REQUEST", {
    event: "request_started",
    endpoint: endpoint.origin + endpoint.pathname,
    features: sanitized,
  });

  let response: Response;
  try {
    response = await fetch(endpoint.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Request-ID": requestId },
      body: JSON.stringify(sanitized),
      signal: controller.signal,
    });
  } catch (error) {
    logDiagnostic(requestId, "MODEL_REQUEST", {
      event: "request_failed",
      durationMs: Date.now() - startedAt,
      reason: error instanceof Error ? error.message : "Network error",
    });
    if (controller.signal.aborted) {
      throw new Error("Risk model API request timed out after 15 seconds.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  const durationMs = Date.now() - startedAt;
  logDiagnostic(requestId, "MODEL_REQUEST", {
    event: "response_received",
    status: response.status,
    durationMs,
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Model API failed (${response.status}): ${detail || "unknown error"}`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    logDiagnostic(requestId, "MODEL_RESPONSE", { event: "response_parse_failed" });
    throw new Error("Model API returned an unreadable JSON response.");
  }
  if (!isValidRiskModelOutput(payload)) {
    logDiagnostic(requestId, "MODEL_RESPONSE", { event: "response_validation_failed" });
    throw new Error("Model API returned an invalid risk payload.");
  }

  if (
    payload.features.pm2_5_24h_mean !== sanitized.pm2_5_24h_mean ||
    payload.features.nitrogen_dioxide_24h_mean !== sanitized.nitrogen_dioxide_24h_mean ||
    payload.features.ozone_8h_max !== sanitized.ozone_8h_max
  ) {
    logDiagnostic(requestId, "MODEL_RESPONSE", {
      event: "response_validation_failed",
      reason: "features_do_not_match_request",
    });
    throw new Error("Model API response features do not match the request.");
  }

  logDiagnostic(requestId, "MODEL_RESPONSE", {
    event: "response_validated",
    prediction: payload.prediction,
    probability: payload.risk_probability,
    riskLevel: payload.risk_level,
    features: payload.features,
    durationMs,
    validation: "PASS",
  });

  return payload;
}
