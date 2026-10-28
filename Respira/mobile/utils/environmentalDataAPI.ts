import { logDiagnostic } from "./diagnostics";

export interface HourlyAirQualityRow {
  timestamp: string;
  pm2_5: number | null;
  nitrogen_dioxide: number | null;
  ozone: number | null;
  timezone?: string;
}

export interface EnvironmentalFeatureSet {
  pm2_5_24h_mean: number;
  nitrogen_dioxide_24h_mean: number;
  ozone_8h_max: number;
  observation_timestamp: string;
  data_freshness: "historical";
}

interface OpenMeteoResponse {
  timezone?: string;
  hourly_units?: {
    pm2_5?: string;
    nitrogen_dioxide?: string;
    ozone?: string;
  };
  hourly?: {
    time?: string[];
    pm2_5?: Array<number | null>;
    nitrogen_dioxide?: Array<number | null>;
    ozone?: Array<number | null>;
  };
}

export async function fetchOpenMeteoAirQuality(
  latitude: number,
  longitude: number,
  requestId = "not-linked",
): Promise<HourlyAirQualityRow[]> {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    throw new Error("A valid GPS location is required to fetch air-quality data.");
  }

  const url = new URL("https://air-quality-api.open-meteo.com/v1/air-quality");
  url.searchParams.set("latitude", String(latitude));
  url.searchParams.set("longitude", String(longitude));
  url.searchParams.set("hourly", "pm2_5,nitrogen_dioxide,ozone");
  url.searchParams.set("timezone", "auto");
  url.searchParams.set("past_days", "2");
  url.searchParams.set("forecast_days", "1");

  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  logDiagnostic(requestId, "ENVIRONMENT", {
    event: "request_started",
    provider: "Open-Meteo Air Quality API",
    endpoint: url.origin + url.pathname,
    coordinates: { latitude, longitude },
    variables: ["pm2_5", "nitrogen_dioxide", "ozone"],
  });

  let response: Response;
  try {
    response = await fetch(url.toString(), { method: "GET", signal: controller.signal });
  } catch (error) {
    logDiagnostic(requestId, "ENVIRONMENT", {
      event: "request_failed",
      durationMs: Date.now() - startedAt,
      reason: error instanceof Error ? error.message : "Network error",
    });
    if (controller.signal.aborted) {
      throw new Error("Open-Meteo request timed out after 20 seconds.");
    }
    throw new Error(`Open-Meteo request failed: ${error instanceof Error ? error.message : "Network error"}`);
  } finally {
    clearTimeout(timeout);
  }
  const durationMs = Date.now() - startedAt;
  logDiagnostic(requestId, "ENVIRONMENT", {
    event: "response_received",
    status: response.status,
    durationMs,
  });
  if (!response.ok) {
    throw new Error(`Open-Meteo request failed with status ${response.status}.`);
  }

  let payload: OpenMeteoResponse;
  try {
    payload = await response.json() as OpenMeteoResponse;
  } catch (error) {
    logDiagnostic(requestId, "ENVIRONMENT", {
      event: "response_parse_failed",
      reason: error instanceof Error ? error.message : "Invalid JSON",
    });
    throw new Error("Open-Meteo returned an unreadable JSON response.");
  }
  if (!payload || typeof payload !== "object") {
    throw new Error("Open-Meteo returned a malformed response.");
  }
  const units = payload.hourly_units;
  const expectedUnit = "μg/m³";
  if (
    units?.pm2_5 !== expectedUnit ||
    units.nitrogen_dioxide !== expectedUnit ||
    units.ozone !== expectedUnit
  ) {
    throw new Error("Open-Meteo returned unexpected pollution units; the model input unit contract cannot be verified.");
  }

  const times = payload.hourly?.time ?? [];
  const pm2_5 = payload.hourly?.pm2_5 ?? [];
  const no2 = payload.hourly?.nitrogen_dioxide ?? [];
  const ozone = payload.hourly?.ozone ?? [];

  if (times.length === 0 || times.length !== pm2_5.length || times.length !== no2.length || times.length !== ozone.length) {
    throw new Error("Open-Meteo returned missing or mismatched hourly pollution data.");
  }
  if (typeof payload.timezone !== "string" || payload.timezone.length === 0) {
    throw new Error("Open-Meteo did not return a timezone; local observation dates cannot be verified.");
  }

  const rows = times.map((timestamp, index) => ({
    timestamp,
    pm2_5: pm2_5[index] ?? null,
    nitrogen_dioxide: no2[index] ?? null,
    ozone: ozone[index] ?? null,
    timezone: payload.timezone,
  }));

  if (rows.some((row) => typeof row.timestamp !== "string" || row.timestamp.length < 13)) {
    throw new Error("Open-Meteo returned invalid observation timestamps.");
  }

  logDiagnostic(requestId, "ENVIRONMENT", {
    event: "observations_parsed",
    source: "live_api_response",
    timezone: payload.timezone ?? "unavailable",
    units,
    observationCount: rows.length,
    observations: rows.map((row) => ({
      timestamp: row.timestamp,
      pm2_5: row.pm2_5,
      nitrogen_dioxide: row.nitrogen_dioxide,
      ozone: row.ozone,
    })),
    invalidValueCount: rows.filter((row) =>
      [row.pm2_5, row.nitrogen_dioxide, row.ozone].some((value) =>
        typeof value !== "number" || !Number.isFinite(value) || value < 0,
      ),
    ).length,
  });

  return rows;
}

function localDateKey(date: Date, timezone?: string): string {
  if (!timezone) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  const dateParts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const parts = Object.fromEntries(dateParts.map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function timestampValue(timestamp: string): number {
  const value = Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(timestamp) ? timestamp : `${timestamp}Z`);
  if (!Number.isFinite(value)) {
    throw new Error(`Open-Meteo returned an invalid hourly timestamp: ${timestamp}.`);
  }
  return value;
}

export function engineerEnvironmentalFeatures(
  rows: HourlyAirQualityRow[],
  now = new Date(),
  requestId = "not-linked",
): EnvironmentalFeatureSet {
  logDiagnostic(requestId, "FEATURES", {
    event: "engineering_started",
    observationCount: rows.length,
  });

  if (rows.length === 0) {
    throw new Error("Open-Meteo returned no hourly observations.");
  }

  const today = localDateKey(now, rows[0].timezone);
  const groups = new Map<string, HourlyAirQualityRow[]>();
  for (const row of rows) {
    if (typeof row.timestamp !== "string" || !row.timestamp || !Number.isFinite(timestampValue(row.timestamp))) {
      throw new Error("Environmental observations contain an invalid timestamp.");
    }

    const dateKey = row.timestamp.slice(0, 10);
    const group = groups.get(dateKey) ?? [];
    group.push(row);
    groups.set(dateKey, group);
  }

  const eligibleDays = [...groups.keys()].filter((dateKey) => dateKey < today).sort().reverse();
  for (const dateKey of eligibleDays) {
    const dayRows = groups.get(dateKey)!.slice().sort((left, right) => left.timestamp.localeCompare(right.timestamp));
    if (dayRows.length !== 24) {
      continue;
    }

    const timestamps = dayRows.map((row) => timestampValue(row.timestamp));
    const hasContinuousHours = timestamps.every((value, index) =>
      index === 0 || value - timestamps[index - 1] === 60 * 60 * 1000,
    );
    const hasCompleteValues = dayRows.every((row) =>
      [row.pm2_5, row.nitrogen_dioxide, row.ozone].every((value) =>
        typeof value === "number" && Number.isFinite(value) && value >= 0,
      ),
    );

    if (!hasContinuousHours || !hasCompleteValues) {
      logDiagnostic(requestId, "FEATURES", {
        event: "day_rejected",
        date: dateKey,
        observationCount: dayRows.length,
        continuousHours: hasContinuousHours,
        completeValues: hasCompleteValues,
      });
      continue;
    }

    const pm2_5_24h_mean = dayRows.reduce((total, row) => total + row.pm2_5!, 0) / 24;
    const nitrogen_dioxide_24h_mean = dayRows.reduce((total, row) => total + row.nitrogen_dioxide!, 0) / 24;
    const ozoneValues = dayRows.map((row) => row.ozone!);
    const rollingOzoneMeans = Array.from({ length: 17 }, (_, start) => {
      const window = ozoneValues.slice(start, start + 8);
      return window.reduce((total, value) => total + value, 0) / 8;
    });

    const features: EnvironmentalFeatureSet = {
      pm2_5_24h_mean,
      nitrogen_dioxide_24h_mean,
      ozone_8h_max: Math.max(...rollingOzoneMeans),
      observation_timestamp: dayRows[23].timestamp,
      data_freshness: "historical",
    };
    logDiagnostic(requestId, "FEATURES", {
      event: "engineering_completed",
      selectedWindow: { start: dayRows[0].timestamp, end: dayRows[23].timestamp, date: dateKey },
      validObservationCount: dayRows.length,
      rejectedTimestampCount: 0,
      validOzoneWindowCount: rollingOzoneMeans.length,
      rollingOzoneMeans,
      features: {
        pm2_5_24h_mean,
        nitrogen_dioxide_24h_mean,
        ozone_8h_max: features.ozone_8h_max,
      },
      validation: "PASS",
      dataFreshness: features.data_freshness,
    });
    return features;
  }

  logDiagnostic(requestId, "FEATURES", {
    event: "engineering_failed",
    validation: "FAIL",
    reason: "No complete gap-free prior local day was found.",
  });
  throw new Error("A complete, gap-free 24-hour pollution record from a previous day is not available. No risk estimate was made.");
}
