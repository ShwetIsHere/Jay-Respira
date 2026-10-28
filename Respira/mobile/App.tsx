import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import * as Location from "expo-location";
import MapView, { Marker, PROVIDER_GOOGLE, Region } from "react-native-maps";
import { PredictiveRiskAlert } from "./components/PredictiveRiskAlert";
import {
  EnvironmentalFeatureSet,
  engineerEnvironmentalFeatures,
  fetchOpenMeteoAirQuality,
} from "./utils/environmentalDataAPI";
import { fetchRiskPrediction, RiskModelOutput } from "./utils/riskModelAPI";
import { createRequestId, logDiagnostic } from "./utils/diagnostics";
import { Destination, searchDestinations } from "./utils/destinationAPI";

interface UserLocation {
  latitude: number;
  longitude: number;
}

type AppPage = "map" | "destination";

interface Assessment {
  features: EnvironmentalFeatureSet;
  prediction: RiskModelOutput;
}

function ComparisonRow({
  label,
  current,
  destination,
  suffix = "",
}: {
  label: string;
  current: number | string;
  destination: number | string;
  suffix?: string;
}) {
  const format = (value: number | string) =>
    typeof value === "number" ? `${value.toFixed(1)}${suffix}` : value.toUpperCase();

  return (
    <View style={styles.comparisonRow}>
      <Text style={styles.comparisonMetricLabel}>{label}</Text>
      <Text style={styles.comparisonValue}>{format(current)}</Text>
      <Text style={styles.comparisonValue}>{format(destination)}</Text>
    </View>
  );
}

async function assessCoordinates(
  coordinates: UserLocation,
  requestId: string,
): Promise<Assessment> {
  const rows = await fetchOpenMeteoAirQuality(
    coordinates.latitude,
    coordinates.longitude,
    requestId,
  );
  const features = engineerEnvironmentalFeatures(rows, new Date(), requestId);
  const prediction = await fetchRiskPrediction({
    pm2_5_24h_mean: features.pm2_5_24h_mean,
    nitrogen_dioxide_24h_mean: features.nitrogen_dioxide_24h_mean,
    ozone_8h_max: features.ozone_8h_max,
  }, requestId);
  return { features, prediction };
}

export default function App() {
  const mapRef = useRef<MapView | null>(null);
  const searchSequence = useRef(0);
  const destinationSequence = useRef(0);
  const [activePage, setActivePage] = useState<AppPage>("map");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [destinationLoading, setDestinationLoading] = useState(false);
  const [destinationError, setDestinationError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchHasRun, setSearchHasRun] = useState(false);
  const [searchRetry, setSearchRetry] = useState(0);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<Destination[]>([]);
  const [selectedDestination, setSelectedDestination] = useState<Destination | null>(null);
  const [currentAssessment, setCurrentAssessment] = useState<Assessment | null>(null);
  const [destinationAssessment, setDestinationAssessment] = useState<Assessment | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [mapLoadTimedOut, setMapLoadTimedOut] = useState(false);
  const [location, setLocation] = useState<UserLocation | null>(null);
  const [locationTimestamp, setLocationTimestamp] = useState<string | null>(null);
  async function updateLocalEstimate() {
    const requestId = createRequestId();
    setLoading(true);
    setError(null);
    logDiagnostic(requestId, "LOCATION", { event: "permission_request_started" });

    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      logDiagnostic(requestId, "LOCATION", {
        event: "permission_response",
        status: permission.status,
        granted: permission.status === "granted",
      });
      if (permission.status !== "granted") {
        throw new Error("Location permission is needed to check air quality near you. Enable it in your phone settings and try again.");
      }

      const currentPosition = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      if (
        !Number.isFinite(currentPosition.coords.latitude) ||
        !Number.isFinite(currentPosition.coords.longitude) ||
        !Number.isFinite(currentPosition.timestamp) ||
        currentPosition.coords.latitude < -90 ||
        currentPosition.coords.latitude > 90 ||
        currentPosition.coords.longitude < -180 ||
        currentPosition.coords.longitude > 180
      ) {
        throw new Error("The location service returned invalid coordinates.");
      }

      const currentLocation = {
        latitude: currentPosition.coords.latitude,
        longitude: currentPosition.coords.longitude,
      };
      setLocation(currentLocation);
      const locationTime = new Date(currentPosition.timestamp).toISOString();
      setLocationTimestamp(locationTime);
      logDiagnostic(requestId, "LOCATION", {
        event: "location_received",
        source: "device_location_service",
        coordinates: currentLocation,
        timestamp: locationTime,
        ageMs: Math.max(0, Date.now() - currentPosition.timestamp),
      });

      const assessment = await assessCoordinates(currentLocation, requestId);
      setCurrentAssessment(assessment);
      logDiagnostic(requestId, "UI", {
        event: "prediction_accepted",
        updatedState: ["currentAssessment", "location"],
        riskLevel: assessment.prediction.risk_level,
        probability: assessment.prediction.risk_probability,
        dataFreshness: assessment.features.data_freshness,
      });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "The location risk check could not be completed.";
      setError(message);
      logDiagnostic(requestId, "UI", { event: "update_failed", error: message });
    } finally {
      setLoading(false);
    }
  }

  function showCurrentLocation() {
    destinationSequence.current += 1;
    searchSequence.current += 1;
    setSelectedDestination(null);
    setDestinationAssessment(null);
    setDestinationError(null);
    setDestinationLoading(false);
    setSearchQuery("");
    setSuggestions([]);
    void updateLocalEstimate();
  }

  useEffect(() => {
    void updateLocalEstimate();
  }, []);

  useEffect(() => {
    const query = searchQuery.trim();
    const sequence = ++searchSequence.current;
    if (selectedDestination && query === selectedDestination.name.trim()) {
      setSuggestions([]);
      setSearchLoading(false);
      setSearchError(null);
      setSearchHasRun(false);
      return;
    }
    if (query.length < 3) {
      setSuggestions([]);
      setSearchLoading(false);
      setSearchError(null);
      setSearchHasRun(false);
      return;
    }

    setSearchHasRun(false);
    const timeout = setTimeout(async () => {
      const requestId = createRequestId();
      setSearchLoading(true);
      setSearchError(null);
      try {
        const results = await searchDestinations(query, requestId);
        if (sequence === searchSequence.current) {
          setSuggestions(results);
          setSearchHasRun(true);
        }
      } catch (caught) {
        if (sequence === searchSequence.current) {
          setSuggestions([]);
          setSearchError(caught instanceof Error ? caught.message : "Destination search failed.");
          setSearchHasRun(true);
        }
      } finally {
        if (sequence === searchSequence.current) {
          setSearchLoading(false);
        }
      }
    }, 1_000);

    return () => clearTimeout(timeout);
  }, [searchQuery, searchRetry, selectedDestination]);

  async function chooseDestination(destination: Destination) {
    const requestId = createRequestId();
    const sequence = ++destinationSequence.current;
    searchSequence.current += 1;
    setSelectedDestination(destination);
    setSuggestions([]);
    setSearchQuery(destination.name);
    setSearchError(null);
    setDestinationError(null);
    setDestinationAssessment(null);
    setDestinationLoading(true);
    setMapLoaded(false);
    setMapReady(false);
    setMapLoadTimedOut(false);
    setActivePage("map");
    logDiagnostic(requestId, "DESTINATION_SEARCH", {
      event: "destination_selected",
      query: searchQuery.trim(),
      selectedDestination: destination.name,
      address: destination.address,
      latitude: destination.latitude,
      longitude: destination.longitude,
    });

    try {
      const assessment = await assessCoordinates(
        { latitude: destination.latitude, longitude: destination.longitude },
        requestId,
      );
      if (sequence !== destinationSequence.current) {
        return;
      }
      setDestinationAssessment(assessment);
      logDiagnostic(requestId, "DESTINATION_RESULT", {
        destination: destination.name,
        dataFreshness: assessment.features.data_freshness,
        riskLevel: assessment.prediction.risk_level,
        probability: assessment.prediction.risk_probability,
      });
    } catch (caught) {
      if (sequence !== destinationSequence.current) {
        return;
      }
      const message = caught instanceof Error ? caught.message : "Destination risk assessment failed.";
      setDestinationError(message);
      logDiagnostic(requestId, "DESTINATION_RESULT", {
        destination: destination.name,
        event: "assessment_failed",
        error: message,
      });
    } finally {
      if (sequence === destinationSequence.current) {
        setDestinationLoading(false);
      }
    }
  }

  const mapFocus = selectedDestination ?? location;
  const mapRegion: Region | null = mapFocus
    ? { latitude: mapFocus.latitude, longitude: mapFocus.longitude, latitudeDelta: 0.018, longitudeDelta: 0.018 }
    : null;
  const displayedAssessment = selectedDestination ? destinationAssessment : currentAssessment;
  const displayedError = selectedDestination ? destinationError : error;
  const displayedLoading = selectedDestination ? destinationLoading : loading;
  const comparisonCompatible = Boolean(
    currentAssessment &&
    destinationAssessment &&
    currentAssessment.features.observation_timestamp.slice(0, 10) ===
      destinationAssessment.features.observation_timestamp.slice(0, 10),
  );

  useEffect(() => {
    const mapFocus = selectedDestination ?? location;
    if (mapFocus) {
      mapRef.current?.animateToRegion(
        { latitude: mapFocus.latitude, longitude: mapFocus.longitude, latitudeDelta: 0.018, longitudeDelta: 0.018 },
        700,
      );
    }
  }, [location, selectedDestination]);

  useEffect(() => {
    if (!mapFocus || mapLoaded) {
      setMapLoadTimedOut(false);
      return;
    }

    const timeout = setTimeout(() => setMapLoadTimedOut(true), 20_000);
    return () => clearTimeout(timeout);
  }, [mapFocus, mapLoaded]);

  return (
    <View style={styles.screen}>
      <StatusBar barStyle="dark-content" translucent backgroundColor="transparent" />
      {activePage === "map" ? (
        <>
          {mapFocus && mapRegion ? (
            <MapView
              ref={mapRef}
              style={styles.map}
              provider={PROVIDER_GOOGLE}
              initialRegion={mapRegion}
              mapType="standard"
              showsUserLocation={Boolean(location)}
              showsMyLocationButton={false}
              toolbarEnabled={false}
              onMapLoaded={() => {
                setMapLoaded(true);
                logDiagnostic("map", "MAP", { event: "tiles_loaded", provider: "Google Maps" });
              }}
              onMapReady={() => {
                setMapReady(true);
                logDiagnostic("map", "MAP", { event: "native_map_ready", provider: "Google Maps" });
              }}
              accessibilityLabel={`Google map centered on ${selectedDestination?.name ?? "your current location"}`}
            >
              {selectedDestination ? (
                <Marker
                  coordinate={{ latitude: selectedDestination.latitude, longitude: selectedDestination.longitude }}
                  title={selectedDestination.name}
                  description={selectedDestination.address}
                  pinColor="#a84f3b"
                />
              ) : null}
            </MapView>
          ) : (
            <View style={styles.mapFallback}>
              {loading ? <ActivityIndicator size="small" color="#23734e" style={styles.mapFallbackSpinner} /> : null}
              <Text style={styles.mapFallbackTitle}>
                {loading ? "Finding your location…" : "Map needs your location"}
              </Text>
              <Text style={styles.mapFallbackText}>
                {error ?? "Share your location to open Google Maps centered on your position."}
              </Text>
            </View>
          )}
          <View style={styles.mapHeader}>
            <View style={styles.brandMark}>
              <Text style={styles.brandLeaf}>✳</Text>
            </View>
            <View style={styles.brandCopy}>
              <Text style={styles.brandName}>respira</Text>
              <Text style={styles.brandCaption}>YOUR LOCAL AIR</Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Refresh location and air estimate"
              onPress={() => void updateLocalEstimate()}
              disabled={loading}
              style={({ pressed }) => [styles.refreshButton, pressed && styles.pressed]}
            >
              {loading ? (
                <ActivityIndicator size="small" color="#206a4b" />
              ) : (
                <Text style={styles.refreshGlyph}>↻</Text>
              )}
              <Text style={styles.refreshText}>{loading ? "Checking" : "Refresh"}</Text>
            </Pressable>
          </View>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Find my location and update air estimate"
            onPress={showCurrentLocation}
            disabled={loading}
            style={({ pressed }) => [styles.recenterButton, pressed && styles.pressed]}
          >
            <Text style={styles.recenterGlyph}>⌖</Text>
          </Pressable>

          <View style={styles.mapLabel}>
            <View style={[styles.mapLabelDot, (!mapFocus || !mapLoaded) && styles.mapLabelDotMuted]} />
            <Text style={styles.mapLabelText}>
              {!mapFocus
                ? "WAITING FOR GPS"
                : `${mapLoaded ? "GOOGLE MAP" : "MAP LOADING"} · ${selectedDestination?.name ?? "CURRENT LOCATION"}`}
            </Text>
          </View>

          {mapFocus && !mapLoaded ? (
            <View style={styles.mapStatus}>
              {mapLoadTimedOut ? (
                <>
                  <Text style={styles.mapStatusTitle}>Google Maps tiles have not confirmed loading</Text>
                  <Text style={styles.mapStatusText}>
                    {mapReady
                      ? "The map view initialized but has not reported its tiles loaded. Check internet access and Google Play Services, then close and reopen Expo Go. Expo Go includes map support; your custom API key is needed for a native build, not Expo Go."
                      : "The native map has not initialized. Check internet access and Google Play Services, then close and reopen Expo Go. Expo Go includes map support; your custom API key is needed for a native build, not Expo Go."}
                  </Text>
                </>
              ) : (
                <>
                  <ActivityIndicator size="small" color="#23734e" />
                  <Text style={styles.mapStatusText}>
                    {mapReady ? "Map opened; waiting for Google Maps tiles…" : "Initializing Google Maps…"}
                  </Text>
                </>
              )}
            </View>
          ) : null}

          <View style={styles.bottomSheet}>
            <View style={styles.sheetHandle} />
            <View style={styles.sheetHeading}>
              <View style={styles.sheetTitleGroup}>
                <Text style={styles.sheetEyebrow}>LOCAL CONDITIONS</Text>
                <Text style={styles.sheetTitle}>Air & breathing</Text>
              </View>
              {locationTimestamp ? (
                <View style={styles.locationChip}>
                  <View style={styles.locationChipDot} />
                  <Text style={styles.locationChipText}>GPS {new Date(locationTimestamp).toLocaleTimeString()}</Text>
                </View>
              ) : null}
            </View>

            {!location && !loading ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => void updateLocalEstimate()}
                style={({ pressed }) => [styles.locationButton, pressed && styles.pressed]}
              >
                <Text style={styles.locationButtonText}>Use my location</Text>
                <Text style={styles.locationButtonArrow}>→</Text>
              </Pressable>
            ) : null}

            <ScrollView
              style={styles.resultScroll}
              contentContainerStyle={styles.resultContent}
              showsVerticalScrollIndicator={false}
            >
              {selectedDestination ? (
                <Text style={styles.selectedDestinationAddress}>{selectedDestination.address}</Text>
              ) : null}
              <PredictiveRiskAlert
                loading={displayedLoading}
                error={displayedError}
                riskLevel={displayedAssessment?.prediction.risk_level ?? null}
                probability={displayedAssessment?.prediction.risk_probability ?? null}
                pm2_5_24h_mean={displayedAssessment?.features.pm2_5_24h_mean ?? null}
                nitrogen_dioxide_24h_mean={displayedAssessment?.features.nitrogen_dioxide_24h_mean ?? null}
                ozone_8h_max={displayedAssessment?.features.ozone_8h_max ?? null}
                observationTimestamp={displayedAssessment?.features.observation_timestamp ?? null}
              />
              {displayedAssessment ? (
                <Text style={styles.freshnessBadge}>
                  {__DEV__ ? `LIVE API · HISTORICAL AIR DATA · ${displayedAssessment.features.data_freshness.toUpperCase()}` : "Historical air-quality observations"}
                </Text>
              ) : null}
              <Text style={styles.sheetFootnote}>
                Location checks run on request. Air data and model output are not a medical diagnosis.
              </Text>
            </ScrollView>
          </View>
        </>
      ) : (
        <ScrollView
          style={styles.destinationPage}
          contentContainerStyle={styles.destinationPageContent}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.moreHeader}>
            <View style={styles.brandMark}>
              <Text style={styles.brandLeaf}>✳</Text>
            </View>
            <View style={styles.brandCopy}>
              <Text style={styles.brandName}>respira</Text>
              <Text style={styles.brandCaption}>PLAN AHEAD WITH LOCAL AIR DATA</Text>
            </View>
          </View>

          <Text style={styles.destinationEyebrow}>DESTINATION RISK CHECKER</Text>
          <Text style={styles.destinationTitle}>Check the air before you go.</Text>
          <Text style={styles.destinationIntro}>
            Search a place and compare its previous complete day of air-quality data with your current location.
          </Text>

          <View style={styles.searchBox}>
            <Text style={styles.searchIcon}>⌕</Text>
            <TextInput
              accessibilityLabel="Search destination"
              value={searchQuery}
              onChangeText={setSearchQuery}
              placeholder="Search a place, city, landmark or address..."
              placeholderTextColor="#87948b"
              style={styles.searchInput}
              returnKeyType="search"
              autoCorrect={false}
            />
            {searchLoading ? <ActivityIndicator size="small" color="#23734e" /> : null}
          </View>
          <Text style={styles.searchAttribution}>
            Place search by Photon · © OpenStreetMap contributors
          </Text>

          {searchQuery.trim().length > 0 && searchQuery.trim().length < 3 ? (
            <Text style={styles.searchHint}>Enter at least 3 characters to search.</Text>
          ) : null}
          {searchError ? (
            <View>
              <Text style={styles.searchError}>{searchError}</Text>
              <Pressable
                accessibilityRole="button"
                onPress={() => setSearchRetry((retry) => retry + 1)}
                style={({ pressed }) => [styles.retryButton, pressed && styles.pressed]}
              >
                <Text style={styles.retryButtonText}>Retry search</Text>
              </Pressable>
            </View>
          ) : null}
          {searchHasRun && !searchLoading && !searchError && searchQuery.trim().length >= 3 && suggestions.length === 0 ? (
            <Text style={styles.searchHint}>No matching places found. Try a nearby city or landmark.</Text>
          ) : null}

          {suggestions.map((suggestion) => (
            <Pressable
              key={suggestion.id}
              accessibilityRole="button"
              onPress={() => void chooseDestination(suggestion)}
              style={({ pressed }) => [styles.suggestion, pressed && styles.pressed]}
            >
              <Text style={styles.suggestionTitle}>{suggestion.name}</Text>
              <Text style={styles.suggestionAddress}>{suggestion.address}</Text>
            </Pressable>
          ))}

          {destinationLoading ? (
            <View style={styles.destinationStatus}>
              <ActivityIndicator color="#23734e" />
              <Text style={styles.destinationStatusText}>Fetching air data and running the model…</Text>
            </View>
          ) : null}
          {destinationError ? (
            <View style={styles.destinationErrorBox}>
              <Text style={styles.destinationErrorTitle}>Risk unavailable</Text>
              <Text style={styles.destinationErrorText}>{destinationError}</Text>
              {selectedDestination ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => void chooseDestination(selectedDestination)}
                  style={({ pressed }) => [styles.retryButton, pressed && styles.pressed]}
                >
                  <Text style={styles.retryButtonText}>Retry destination check</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}

          {selectedDestination && destinationAssessment ? (
            <View style={styles.destinationResultCard}>
              <Text style={styles.comparisonEyebrow}>SELECTED DESTINATION</Text>
              <Text style={styles.comparisonTitle}>{selectedDestination.name}</Text>
              <Text style={styles.suggestionAddress}>{selectedDestination.address}</Text>
              <PredictiveRiskAlert
                loading={destinationLoading}
                error={destinationError}
                riskLevel={destinationAssessment.prediction.risk_level}
                probability={destinationAssessment.prediction.risk_probability}
                pm2_5_24h_mean={destinationAssessment.features.pm2_5_24h_mean}
                nitrogen_dioxide_24h_mean={destinationAssessment.features.nitrogen_dioxide_24h_mean}
                ozone_8h_max={destinationAssessment.features.ozone_8h_max}
                observationTimestamp={destinationAssessment.features.observation_timestamp}
              />
              <Text style={styles.freshnessBadge}>
                Historical data · {new Date(destinationAssessment.features.observation_timestamp).toLocaleDateString()}
              </Text>
              <Pressable
                accessibilityRole="button"
                onPress={() => setActivePage("map")}
                style={({ pressed }) => [styles.locationButton, pressed && styles.pressed]}
              >
                <Text style={styles.locationButtonText}>Show destination on map</Text>
                <Text style={styles.locationButtonArrow}>→</Text>
              </Pressable>
            </View>
          ) : null}

          {selectedDestination && destinationAssessment && currentAssessment ? (
            <View style={styles.comparisonCard}>
              <Text style={styles.comparisonEyebrow}>ENVIRONMENTAL COMPARISON</Text>
              <Text style={styles.comparisonTitle}>Your location and destination</Text>
              <Text style={styles.comparisonNote}>
                Estimates use the latest complete prior local day available for each location. We only compare values when both observation dates match.
              </Text>
              {comparisonCompatible ? (
                <>
                  <View style={styles.comparisonHeaderRow}>
                    <Text style={styles.comparisonMetricLabel}>Metric</Text>
                    <Text style={styles.comparisonColumn}>Your location</Text>
                    <Text style={styles.comparisonColumn}>{selectedDestination.name}</Text>
                  </View>
                  <ComparisonRow
                    label="PM2.5 daily mean"
                    current={currentAssessment.features.pm2_5_24h_mean}
                    destination={destinationAssessment.features.pm2_5_24h_mean}
                  />
                  <ComparisonRow
                    label="NO₂ daily mean"
                    current={currentAssessment.features.nitrogen_dioxide_24h_mean}
                    destination={destinationAssessment.features.nitrogen_dioxide_24h_mean}
                  />
                  <ComparisonRow
                    label="O₃ rolling 8h max"
                    current={currentAssessment.features.ozone_8h_max}
                    destination={destinationAssessment.features.ozone_8h_max}
                  />
                  <ComparisonRow
                    label="Class-1 score"
                    current={currentAssessment.prediction.risk_probability * 100}
                    destination={destinationAssessment.prediction.risk_probability * 100}
                    suffix="%"
                  />
                  <ComparisonRow
                    label="Model category"
                    current={currentAssessment.prediction.risk_level}
                    destination={destinationAssessment.prediction.risk_level}
                  />
                  <Text style={styles.comparisonNote}>
                    Shared observation date: {currentAssessment.features.observation_timestamp.slice(0, 10)}.
                  </Text>
                </>
              ) : (
                <Text style={styles.comparisonNote}>
                  These results use different observation dates, so a side-by-side comparison is withheld.
                  Current: {currentAssessment.features.observation_timestamp.slice(0, 10)}; destination: {destinationAssessment.features.observation_timestamp.slice(0, 10)}.
                </Text>
              )}
              <Text style={styles.comparisonDisclaimer}>
                This is a model-based environmental estimate, not a medical assessment or guarantee of travel safety.
              </Text>
            </View>
          ) : null}
        </ScrollView>
      )}

      <View style={styles.bottomNavigation}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ selected: activePage === "map" }}
          onPress={() => setActivePage("map")}
          style={({ pressed }) => [styles.navItem, pressed && styles.pressed]}
        >
          <Text style={[styles.navIcon, activePage === "map" && styles.navIconActive]}>⌖</Text>
          <Text style={[styles.navLabel, activePage === "map" && styles.navLabelActive]}>Map</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ selected: activePage === "destination" }}
          onPress={() => setActivePage("destination")}
          style={({ pressed }) => [styles.navItem, pressed && styles.pressed]}
        >
          <Text style={[styles.navIcon, activePage === "destination" && styles.navIconActive]}>⌕</Text>
          <Text style={[styles.navLabel, activePage === "destination" && styles.navLabelActive]}>Explore</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#eaf0e9" },
  map: { ...StyleSheet.absoluteFillObject },
  mapFallback: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 36, paddingBottom: 300, backgroundColor: "#eaf0e9" },
  mapFallbackSpinner: { marginBottom: 12 },
  mapFallbackTitle: { color: "#19382c", fontSize: 18, fontWeight: "800", textAlign: "center" },
  mapFallbackText: { color: "#718077", fontSize: 13, lineHeight: 19, textAlign: "center", marginTop: 8 },
  mapHeader: {
    position: "absolute",
    top: 52,
    left: 18,
    right: 18,
    minHeight: 58,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.96)",
    borderRadius: 18,
    shadowColor: "#19382c",
    shadowOpacity: 0.14,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 5 },
    elevation: 5,
  },
  brandMark: { width: 38, height: 38, borderRadius: 13, backgroundColor: "#dcefe1", alignItems: "center", justifyContent: "center" },
  brandLeaf: { color: "#23734e", fontSize: 23, fontWeight: "700" },
  brandCopy: { flex: 1, marginLeft: 10 },
  brandName: { color: "#19382c", fontSize: 19, fontWeight: "800", letterSpacing: -0.5 },
  brandCaption: { color: "#829087", fontSize: 8, fontWeight: "800", letterSpacing: 1.1, marginTop: 1 },
  refreshButton: { backgroundColor: "#e5f1e7", borderRadius: 12, paddingHorizontal: 11, paddingVertical: 9, flexDirection: "row", alignItems: "center", minWidth: 82, justifyContent: "center" },
  refreshGlyph: { color: "#206a4b", fontSize: 18, fontWeight: "800", marginRight: 5 },
  refreshText: { color: "#206a4b", fontWeight: "700", fontSize: 11 },
  pressed: { opacity: 0.75 },
  mapLabel: { position: "absolute", top: 123, left: 20, flexDirection: "row", alignItems: "center", paddingVertical: 8, paddingHorizontal: 10, borderRadius: 12, backgroundColor: "rgba(255,255,255,0.95)" },
  mapLabelDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: "#3d9b67", marginRight: 7 },
  mapLabelDotMuted: { backgroundColor: "#90a098" },
  mapLabelText: { color: "#426352", fontSize: 9, fontWeight: "800", letterSpacing: 0.7 },
  mapStatus: { position: "absolute", top: 164, left: 20, right: 20, alignItems: "center", padding: 14, borderRadius: 16, backgroundColor: "rgba(255,255,255,0.96)" },
  mapStatusTitle: { color: "#9b443a", fontSize: 13, fontWeight: "800", textAlign: "center" },
  mapStatusText: { color: "#5e7065", fontSize: 11, lineHeight: 16, textAlign: "center", marginTop: 7 },
  recenterButton: { position: "absolute", right: 18, bottom: "58%", width: 46, height: 46, alignItems: "center", justifyContent: "center", borderRadius: 15, backgroundColor: "#ffffff", shadowColor: "#19382c", shadowOpacity: 0.16, shadowRadius: 10, shadowOffset: { width: 0, height: 3 }, elevation: 5 },
  recenterGlyph: { color: "#23734e", fontSize: 25, fontWeight: "700" },
  bottomSheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 76,
    maxHeight: "49%",
    backgroundColor: "#f8faf7",
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingTop: 9,
    paddingHorizontal: 18,
    paddingBottom: 8,
    shadowColor: "#19382c",
    shadowOpacity: 0.14,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: -5 },
    elevation: 12,
  },
  sheetHandle: { width: 38, height: 4, alignSelf: "center", backgroundColor: "#d8e1d9", borderRadius: 3, marginBottom: 13 },
  sheetHeading: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 3 },
  sheetTitleGroup: { flex: 1 },
  sheetEyebrow: { color: "#688076", fontSize: 9, fontWeight: "800", letterSpacing: 1.2 },
  sheetTitle: { color: "#19382c", fontSize: 20, fontWeight: "800", marginTop: 3 },
  locationChip: { flexDirection: "row", alignItems: "center", backgroundColor: "#e5f3e8", paddingHorizontal: 9, paddingVertical: 6, borderRadius: 10 },
  locationChipDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: "#3d9b67", marginRight: 6 },
  locationChipText: { color: "#28704d", fontSize: 9, fontWeight: "800", letterSpacing: 0.5 },
  locationButton: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", backgroundColor: "#23734e", borderRadius: 14, paddingVertical: 13, paddingHorizontal: 16, marginTop: 12 },
  locationButtonText: { color: "#ffffff", fontWeight: "800", fontSize: 13 },
  locationButtonArrow: { color: "#ffffff", fontSize: 18, fontWeight: "700" },
  resultScroll: { flexGrow: 0 },
  resultContent: { paddingBottom: 4 },
  freshnessBadge: { color: "#697d70", fontSize: 9, fontWeight: "700", marginTop: 7, letterSpacing: 0.3 },
  sheetFootnote: { color: "#87948b", fontSize: 10, lineHeight: 14, marginTop: 8, marginBottom: 2 },
  morePage: { flex: 1, backgroundColor: "#f4f7f2", paddingHorizontal: 20, paddingTop: 55, paddingBottom: 100 },
  destinationPage: { flex: 1, backgroundColor: "#f4f7f2" },
  destinationPageContent: { paddingHorizontal: 20, paddingTop: 55, paddingBottom: 105 },
  moreHeader: { flexDirection: "row", alignItems: "center" },
  destinationEyebrow: { color: "#568064", fontSize: 10, fontWeight: "800", letterSpacing: 1.2, marginTop: 30 },
  destinationTitle: { color: "#19382c", fontSize: 27, lineHeight: 33, fontWeight: "800", marginTop: 7 },
  destinationIntro: { color: "#718077", fontSize: 13, lineHeight: 19, marginTop: 8, marginBottom: 18 },
  searchBox: { minHeight: 52, borderRadius: 15, paddingHorizontal: 14, flexDirection: "row", alignItems: "center", backgroundColor: "#ffffff", borderWidth: 1, borderColor: "#dfe8df" },
  searchIcon: { color: "#568064", fontSize: 23, marginRight: 9 },
  searchInput: { flex: 1, color: "#203c30", fontSize: 13, paddingVertical: 12 },
  searchAttribution: { color: "#87948b", fontSize: 9, lineHeight: 14, marginTop: 7 },
  searchHint: { color: "#718077", fontSize: 12, lineHeight: 18, marginTop: 10 },
  searchError: { color: "#a83b31", fontSize: 12, lineHeight: 18, marginTop: 10 },
  suggestion: { padding: 14, backgroundColor: "#ffffff", borderBottomWidth: 1, borderColor: "#edf0ed" },
  suggestionTitle: { color: "#203c30", fontSize: 13, fontWeight: "800" },
  suggestionAddress: { color: "#718077", fontSize: 11, lineHeight: 16, marginTop: 4 },
  destinationStatus: { flexDirection: "row", alignItems: "center", justifyContent: "center", marginTop: 18, padding: 14, backgroundColor: "#eaf3eb", borderRadius: 14 },
  destinationStatusText: { color: "#426352", fontSize: 12, marginLeft: 9 },
  destinationErrorBox: { backgroundColor: "#fff1ee", borderRadius: 15, padding: 15, marginTop: 15 },
  destinationErrorTitle: { color: "#a83b31", fontSize: 14, fontWeight: "800" },
  destinationErrorText: { color: "#7c4c46", fontSize: 12, lineHeight: 18, marginTop: 5 },
  retryButton: { backgroundColor: "#a83b31", alignSelf: "flex-start", paddingHorizontal: 13, paddingVertical: 9, borderRadius: 10, marginTop: 11 },
  retryButtonText: { color: "#ffffff", fontWeight: "700", fontSize: 11 },
  destinationResultCard: { padding: 15, borderRadius: 20, marginTop: 20, backgroundColor: "#ffffff", borderWidth: 1, borderColor: "#e5ece5" },
  selectedDestinationAddress: { color: "#718077", fontSize: 11, lineHeight: 16, marginTop: 7 },
  comparisonCard: { padding: 17, borderRadius: 20, marginTop: 18, backgroundColor: "#ffffff", borderWidth: 1, borderColor: "#e5ece5" },
  comparisonEyebrow: { color: "#568064", fontSize: 9, fontWeight: "800", letterSpacing: 1.1 },
  comparisonTitle: { color: "#19382c", fontSize: 18, fontWeight: "800", marginTop: 5 },
  comparisonNote: { color: "#718077", fontSize: 10, lineHeight: 15, marginTop: 8 },
  comparisonHeaderRow: { flexDirection: "row", alignItems: "flex-start", borderBottomWidth: 1, borderColor: "#e8eee8", paddingVertical: 10, marginTop: 10 },
  comparisonRow: { flexDirection: "row", alignItems: "center", borderBottomWidth: 1, borderColor: "#edf0ed", paddingVertical: 10 },
  comparisonMetricLabel: { flex: 1.2, color: "#566b60", fontSize: 10, fontWeight: "700" },
  comparisonColumn: { flex: 1, color: "#426352", fontSize: 9, fontWeight: "800", textAlign: "right", paddingLeft: 4 },
  comparisonValue: { flex: 1, color: "#203c30", fontSize: 10, fontWeight: "700", textAlign: "right" },
  comparisonDisclaimer: { color: "#87948b", fontSize: 10, lineHeight: 15, marginTop: 12 },
  comingSoonCard: { marginTop: 42, borderRadius: 24, padding: 22, backgroundColor: "#ffffff", borderWidth: 1, borderColor: "#e5ece5" },
  comingSoonIcon: { color: "#23734e", fontSize: 30, fontWeight: "500", marginBottom: 18 },
  comingSoonEyebrow: { color: "#568064", fontSize: 10, fontWeight: "800", letterSpacing: 1.2 },
  comingSoonTitle: { color: "#19382c", fontSize: 24, fontWeight: "800", marginTop: 7 },
  comingSoonCopy: { color: "#718077", fontSize: 14, lineHeight: 21, marginTop: 9 },
  bottomNavigation: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: 78,
    paddingBottom: 9,
    backgroundColor: "#ffffff",
    borderTopWidth: 1,
    borderTopColor: "#e8eee8",
    flexDirection: "row",
    justifyContent: "space-around",
    alignItems: "center",
  },
  navItem: { alignItems: "center", justifyContent: "center", minWidth: 88, height: 58 },
  navIcon: { color: "#89958d", fontSize: 21, lineHeight: 25 },
  navIconActive: { color: "#23734e" },
  navLabel: { color: "#89958d", fontSize: 10, fontWeight: "700", marginTop: 1 },
  navLabelActive: { color: "#23734e" },
});
