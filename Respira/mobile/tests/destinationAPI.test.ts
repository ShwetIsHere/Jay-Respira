import { beforeEach, describe, expect, it, vi } from "vitest";
import { searchDestinations } from "../utils/destinationAPI";

beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubGlobal("fetch", vi.fn());
  vi.stubEnv("EXPO_PUBLIC_RISK_MODEL_API_URL", "http://localhost:8000");
});

describe("destination search API", () => {
  it("uses the backend geocoding proxy and validates returned places", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [{
          id: "place-1",
          name: "Vadodara",
          address: "Vadodara, Gujarat, India",
          latitude: 22.3,
          longitude: 73.2,
        }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(searchDestinations(" Vadodara ", "request-1")).resolves.toEqual([
      {
        id: "place-1",
        name: "Vadodara",
        address: "Vadodara, Gujarat, India",
        latitude: 22.3,
        longitude: 73.2,
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8000/geocode?q=Vadodara",
      expect.objectContaining({ headers: { "X-Request-ID": "request-1" } }),
    );
  });

  it("does not make a request for short queries", async () => {
    const fetchMock = vi.mocked(fetch);
    await expect(searchDestinations("ab", "request-1")).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts a real empty result set", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] }),
    }));

    await expect(searchDestinations("Unknown place", "request-2")).resolves.toEqual([]);
  });

  it("rejects malformed or out-of-range place coordinates", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [{
          id: "place-1",
          name: "Invalid",
          address: "Invalid place",
          latitude: 91,
          longitude: 73,
        }],
      }),
    }));

    await expect(searchDestinations("Invalid place", "request-3"))
      .rejects.toThrow("invalid place results");
  });

  it("rejects non-object responses instead of throwing a runtime property error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => null,
    }));

    await expect(searchDestinations("Vadodara", "request-3"))
      .rejects.toThrow("Destination search returned an invalid response.");
  });

  it("reports backend status and network errors without returning fallback places", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => JSON.stringify({ detail: "Geocoding is not configured" }),
    }));
    await expect(searchDestinations("Vadodara", "request-4"))
      .rejects.toThrow("Destination search failed (503): Geocoding is not configured");

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(searchDestinations("Vadodara", "request-5"))
      .rejects.toThrow("Destination search failed: offline");
  });

  it("explains that a backend 404 means the running API lacks the endpoint", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => JSON.stringify({ detail: "Not Found" }),
    }));

    await expect(searchDestinations("Delhi", "request-6"))
      .rejects.toThrow("This backend does not have the destination-search endpoint");
  });
});
