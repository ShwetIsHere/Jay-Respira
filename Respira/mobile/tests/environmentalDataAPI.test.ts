import { describe, expect, it } from "vitest";
import {
  engineerEnvironmentalFeatures,
  fetchOpenMeteoAirQuality,
  HourlyAirQualityRow,
} from "../utils/environmentalDataAPI";
import { vi } from "vitest";

function makeDay(date: string): HourlyAirQualityRow[] {
  return Array.from({ length: 24 }, (_, hour) => ({
    timestamp: `${date}T${String(hour).padStart(2, "0")}:00`,
    pm2_5: hour,
    nitrogen_dioxide: 2,
    ozone: hour,
    timezone: "UTC",
  }));
}

describe("environmental feature engineering", () => {
  it("requests PM2.5, NO2, and ozone from Open-Meteo with validated concentration units", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        hourly_units: {
          pm2_5: "μg/m³",
          nitrogen_dioxide: "μg/m³",
          ozone: "μg/m³",
        },
        hourly: {
          time: ["2025-01-02T00:00"],
          pm2_5: [1],
          nitrogen_dioxide: [2],
          ozone: [3],
        },
        timezone: "UTC",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await fetchOpenMeteoAirQuality(22.3, 73.2);

    const requestUrl = new URL(fetchMock.mock.calls[0][0]);
    expect(requestUrl.searchParams.get("latitude")).toBe("22.3");
    expect(requestUrl.searchParams.get("longitude")).toBe("73.2");
    expect(requestUrl.searchParams.get("hourly")).toBe("pm2_5,nitrogen_dioxide,ozone");
    expect(requestUrl.searchParams.get("past_days")).toBe("2");
  });

  it("does not convert an environmental HTTP failure into observations", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));

    await expect(fetchOpenMeteoAirQuality(22.3, 73.2)).rejects.toThrow("status 503");
  });

  it("rejects malformed or missing hourly observations", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        hourly_units: { pm2_5: "μg/m³", nitrogen_dioxide: "μg/m³", ozone: "μg/m³" },
        hourly: { time: ["2025-01-02T00:00"], pm2_5: [], nitrogen_dioxide: [2], ozone: [3] },
      }),
    }));

    await expect(fetchOpenMeteoAirQuality(22.3, 73.2)).rejects.toThrow("missing or mismatched");
  });

  it("uses a complete prior day and finds the maximum rolling 8-hour ozone mean", () => {
    const features = engineerEnvironmentalFeatures(
      [...makeDay("2025-01-02"), ...makeDay("2025-01-03")],
      new Date("2025-01-03T12:00:00"),
    );

    expect(features.pm2_5_24h_mean).toBe(11.5);
    expect(features.nitrogen_dioxide_24h_mean).toBe(2);
    expect(features.ozone_8h_max).toBe(19.5);
    expect(features.observation_timestamp).toBe("2025-01-02T23:00");
    expect(features.data_freshness).toBe("historical");
  });

  it("rejects incomplete or gapped prior-day data rather than imputing", () => {
    const incomplete = makeDay("2025-01-02").filter((_, index) => index !== 8);

    expect(() =>
      engineerEnvironmentalFeatures(incomplete, new Date("2025-01-03T12:00:00")),
    ).toThrow(/complete, gap-free 24-hour/);
  });

  it("rejects 24 observations containing a time gap", () => {
    const gapped = makeDay("2025-01-02");
    gapped[10].timestamp = "2025-01-02T11:00";

    expect(() =>
      engineerEnvironmentalFeatures(gapped, new Date("2025-01-03T12:00:00")),
    ).toThrow(/complete, gap-free 24-hour/);
  });

  it("rejects invalid pollution values", () => {
    const invalid = makeDay("2025-01-02");
    invalid[3].nitrogen_dioxide = Number.NaN;

    expect(() =>
      engineerEnvironmentalFeatures(invalid, new Date("2025-01-03T12:00:00")),
    ).toThrow(/complete, gap-free 24-hour/);
  });

  it("uses the Open-Meteo location timezone to identify today's local date", () => {
    const priorDay = makeDay("2025-01-01").map((row) => ({ ...row, timezone: "America/Los_Angeles" }));
    const localToday = makeDay("2025-01-02").slice(0, 3).map((row) => ({ ...row, timezone: "America/Los_Angeles" }));

    const features = engineerEnvironmentalFeatures(
      [...priorDay, ...localToday],
      new Date("2025-01-03T03:00:00Z"),
    );

    expect(features.observation_timestamp).toBe("2025-01-01T23:00");
  });
});
