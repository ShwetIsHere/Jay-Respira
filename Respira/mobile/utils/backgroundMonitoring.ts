import { fetchRiskPrediction, RiskModelInput, RiskModelOutput } from "./riskModelAPI";
import { classifyRiskProbability, RiskLevel } from "./riskAssessment";
import {
  engineerEnvironmentalFeatures,
  fetchOpenMeteoAirQuality,
} from "./environmentalDataAPI";
import { createRequestId } from "./diagnostics";

export type MonitoringStatus = "idle" | "unavailable" | "warning" | "ready";

export interface EnvironmentalObservation {
  timestamp: string;
  pm2_5: number | null;
  nitrogen_dioxide: number | null;
  ozone: number | null;
  timezone?: string;
}

export interface BackgroundRiskResult {
  status: MonitoringStatus;
  risk_level: RiskLevel | null;
  probability: number | null;
  message: string;
  prediction?: RiskModelOutput;
}

export async function fetchEnvironmentalDataForRiskCheck(
  latitude: number,
  longitude: number,
  requestId = createRequestId(),
): Promise<EnvironmentalObservation[]> {
  return fetchOpenMeteoAirQuality(latitude, longitude, requestId);
}

export function deriveDailyFeatures(
  observations: EnvironmentalObservation[],
  requestId = "not-linked",
): RiskModelInput {
  const features = engineerEnvironmentalFeatures(observations, new Date(), requestId);
  return {
    pm2_5_24h_mean: features.pm2_5_24h_mean,
    nitrogen_dioxide_24h_mean: features.nitrogen_dioxide_24h_mean,
    ozone_8h_max: features.ozone_8h_max,
  };
}

export async function runBackgroundRiskCheck(latitude: number, longitude: number): Promise<BackgroundRiskResult> {
  const requestId = createRequestId();
  try {
    const observations = await fetchEnvironmentalDataForRiskCheck(latitude, longitude, requestId);
    if (observations.length === 0) {
      return {
        status: "unavailable",
        risk_level: null,
        probability: null,
        message: "Environmental data is unavailable.",
      };
    }

    const features = deriveDailyFeatures(observations, requestId);
    const prediction = await fetchRiskPrediction(features, requestId);
    const risk_level = prediction.risk_level;

    return {
      status: "ready",
      risk_level,
      probability: prediction.risk_probability,
      message: "Risk check completed.",
      prediction,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown background monitoring failure.";
    return {
      status: "warning",
      risk_level: null,
      probability: null,
      message: `Risk check unavailable: ${message}`,
    };
  }
}
