import { logDiagnostic } from "./diagnostics";
import { getRiskModelApiBaseUrl } from "./riskModelAPI";

export interface Destination {
  id: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
}

interface DestinationResponse {
  results?: unknown;
}

function isDestination(value: unknown): value is Destination {
  if (!value || typeof value !== "object") {
    return false;
  }
  const place = value as Partial<Destination>;
  return (
    typeof place.id === "string" &&
    place.id.trim().length > 0 &&
    typeof place.name === "string" &&
    place.name.trim().length > 0 &&
    typeof place.address === "string" &&
    place.address.trim().length > 0 &&
    typeof place.latitude === "number" &&
    Number.isFinite(place.latitude) &&
    place.latitude >= -90 &&
    place.latitude <= 90 &&
    typeof place.longitude === "number" &&
    Number.isFinite(place.longitude) &&
    place.longitude >= -180 &&
    place.longitude <= 180
  );
}

export async function searchDestinations(
  query: string,
  requestId: string,
): Promise<Destination[]> {
  const normalizedQuery = query.trim();
  if (normalizedQuery.length < 3) {
    return [];
  }
  if (normalizedQuery.length > 200) {
    throw new Error("Destination search must be 200 characters or fewer.");
  }

  const endpoint = new URL("/geocode", getRiskModelApiBaseUrl());
  endpoint.searchParams.set("q", normalizedQuery);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  logDiagnostic(requestId, "DESTINATION_SEARCH", {
    event: "request_started",
    query: normalizedQuery,
    endpoint: endpoint.origin + endpoint.pathname,
    provider: "Photon/OpenStreetMap",
  });

  let response: Response;
  try {
    response = await fetch(endpoint.toString(), {
      headers: { "X-Request-ID": requestId },
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("Destination search timed out. Check your connection and try again.");
    }
    throw new Error(`Destination search failed: ${error instanceof Error ? error.message : "Network error"}`);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const body = await response.text();
    let detail = body;
    try {
      const payload: unknown = JSON.parse(body);
      if (
        payload &&
        typeof payload === "object" &&
        "detail" in payload &&
        typeof payload.detail === "string"
      ) {
        detail = payload.detail;
      }
    } catch {
      // Keep the backend response text when it is not JSON.
    }

    if (response.status === 404) {
      throw new Error(
        "This backend does not have the destination-search endpoint. Restart FastAPI from the updated risk-model-api folder and check that the app URL points to it.",
      );
    }
    throw new Error(`Destination search failed (${response.status}): ${detail || "unknown error"}`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Destination search returned an unreadable response.");
  }

  if (!payload || typeof payload !== "object") {
    throw new Error("Destination search returned an invalid response.");
  }
  const results = (payload as DestinationResponse).results;
  if (!Array.isArray(results) || !results.every(isDestination)) {
    throw new Error("Destination search returned invalid place results.");
  }

  logDiagnostic(requestId, "DESTINATION_SEARCH", {
    event: results.length ? "suggestions_received" : "no_results",
    count: results.length,
  });
  return results;
}
