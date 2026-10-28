export type RiskLevel = "low" | "medium" | "high";

export const RISK_THRESHOLDS = {
  medium: 0.5,
  high: 0.8,
};

export function classifyRiskProbability(probability: number): RiskLevel {
  if (!Number.isFinite(probability)) {
    throw new Error("Risk probability must be finite.");
  }

  if (probability >= RISK_THRESHOLDS.high) {
    return "high";
  }
  if (probability >= RISK_THRESHOLDS.medium) {
    return "medium";
  }
  return "low";
}

export function checkTriggerSimilarity(..._args: unknown[]): { deprecated: true; reason: string } {
  return {
    deprecated: true,
    reason: "Live risk predictions now come from the model inference API, not historical trigger similarity matching.",
  };
}
