import { describe, expect, it, vi, beforeEach } from "vitest";
import { classifyRiskProbability } from "../utils/riskAssessment";
import { fetchRiskPrediction, isValidRiskModelOutput, validateRiskModelInput } from "../utils/riskModelAPI";
import { sendRiskNotification, hasNotificationCooldown } from "../utils/notificationService";

beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubGlobal("fetch", vi.fn());
  vi.stubEnv("EXPO_PUBLIC_RISK_MODEL_API_URL", "http://localhost:8000");
});

describe("risk assessment utilities", () => {
  it("classifies probability boundaries", () => {
    expect(classifyRiskProbability(0.49)).toBe("low");
    expect(classifyRiskProbability(0.5)).toBe("medium");
    expect(classifyRiskProbability(0.79)).toBe("medium");
    expect(classifyRiskProbability(0.8)).toBe("high");
    expect(classifyRiskProbability(0.85)).toBe("high");
  });

  it("validates risk model inputs", () => {
    expect(validateRiskModelInput({ pm2_5_24h_mean: 20, nitrogen_dioxide_24h_mean: 12, ozone_8h_max: 50 })).toEqual({
      pm2_5_24h_mean: 20,
      nitrogen_dioxide_24h_mean: 12,
      ozone_8h_max: 50,
    });

    expect(() => validateRiskModelInput({ pm2_5_24h_mean: -1, nitrogen_dioxide_24h_mean: 12, ozone_8h_max: 50 })).toThrow();
  });

  it("validates risk model output payloads", () => {
    expect(isValidRiskModelOutput({
      prediction: 1,
      risk_probability: 0.72,
      risk_level: "high",
      features: {
        pm2_5_24h_mean: 35,
        nitrogen_dioxide_24h_mean: 10,
        ozone_8h_max: 90,
      },
    })).toBe(true);

    expect(isValidRiskModelOutput({ prediction: 0, risk_probability: 1.2, risk_level: "low", features: { pm2_5_24h_mean: 1, nitrogen_dioxide_24h_mean: 1, ozone_8h_max: 1 } })).toBe(false);
    expect(isValidRiskModelOutput({ prediction: 2, risk_probability: 0.2, risk_level: "low", features: { pm2_5_24h_mean: 1, nitrogen_dioxide_24h_mean: 1, ozone_8h_max: 1 } })).toBe(false);
  });

  it("fetches prediction from the risk API", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        prediction: 1,
        risk_probability: 0.82,
        risk_level: "high",
        features: {
          pm2_5_24h_mean: 35,
          nitrogen_dioxide_24h_mean: 10,
          ozone_8h_max: 90,
        },
      }),
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await fetchRiskPrediction({ pm2_5_24h_mean: 35, nitrogen_dioxide_24h_mean: 10, ozone_8h_max: 90 });
    expect(result.risk_level).toBe("high");
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:8000/predict",
      expect.objectContaining({
        headers: expect.objectContaining({ "X-Request-ID": "not-linked" }),
        body: JSON.stringify({ pm2_5_24h_mean: 35, nitrogen_dioxide_24h_mean: 10, ozone_8h_max: 90 }),
      }),
    );
  });

  it("rejects failed model requests instead of returning a prediction", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => "model unavailable",
    }));

    await expect(fetchRiskPrediction({
      pm2_5_24h_mean: 35,
      nitrogen_dioxide_24h_mean: 10,
      ozone_8h_max: 90,
    })).rejects.toThrow("Model API failed (503)");
  });
});

describe("notifications", () => {
  it("blocks low risk notifications and enforces cooldown", async () => {
    const lowRisk = { risk_level: "low" as const, risk_probability: 0.2, pm2_5_24h_mean: 10, nitrogen_dioxide_24h_mean: 4, ozone_8h_max: 35, source: "model-based environmental risk estimate" as const };
    expect(await sendRiskNotification(lowRisk)).toBe(false);

    const mediumRisk = { risk_level: "medium" as const, risk_probability: 0.6, pm2_5_24h_mean: 30, nitrogen_dioxide_24h_mean: 20, ozone_8h_max: 70, source: "model-based environmental risk estimate" as const };
    expect(await sendRiskNotification(mediumRisk)).toBe(false);
    expect(hasNotificationCooldown("respira-risk-monitor")).toBe(false);
  });
});
