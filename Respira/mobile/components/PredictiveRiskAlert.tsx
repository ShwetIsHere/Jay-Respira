import React from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { RiskLevel } from "../utils/riskAssessment";

export interface PredictiveRiskAlertProps {
  loading: boolean;
  error: string | null;
  riskLevel: RiskLevel | null;
  probability: number | null;
  pm2_5_24h_mean: number | null;
  nitrogen_dioxide_24h_mean: number | null;
  ozone_8h_max: number | null;
  observationTimestamp: string | null;
}

const riskColors = {
  low: { background: "#e7f5ed", foreground: "#18764b", label: "Lower estimate" },
  medium: { background: "#fff2d6", foreground: "#946200", label: "Moderate estimate" },
  high: { background: "#fde9e7", foreground: "#b43b32", label: "Higher estimate" },
};

function Metric({ label, value, unit }: { label: string; value: number | null; unit: string }) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricValue}>{value === null ? "--" : value.toFixed(1)}</Text>
      <Text style={styles.metricUnit}>{unit}</Text>
      <Text style={styles.metricLabel}>{label}</Text>
    </View>
  );
}

export function PredictiveRiskAlert({
  loading,
  error,
  riskLevel,
  probability,
  pm2_5_24h_mean,
  nitrogen_dioxide_24h_mean,
  ozone_8h_max,
  observationTimestamp,
}: PredictiveRiskAlertProps) {
  const riskColor = riskLevel ? riskColors[riskLevel] : null;
  const observedAt = observationTimestamp ? new Date(observationTimestamp) : null;

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <View>
          <Text style={styles.eyebrow}>ENVIRONMENTAL OUTLOOK</Text>
          <Text style={styles.title}>Air & breathing</Text>
        </View>
        <View style={styles.historicalDot} />
      </View>

      {loading ? (
        <View style={styles.statusBox}>
          <ActivityIndicator color="#18764b" />
          <Text style={styles.statusText}>Checking local air conditions…</Text>
        </View>
      ) : error ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorTitle}>Estimate unavailable</Text>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : riskLevel && riskColor ? (
        <>
          <View style={[styles.riskBanner, { backgroundColor: riskColor.background }]}>
            <View style={styles.riskCopy}>
              <Text style={[styles.riskLabel, { color: riskColor.foreground }]}>{riskColor.label}</Text>
              <Text style={[styles.riskName, { color: riskColor.foreground }]}>{riskLevel}</Text>
            </View>
            <View style={styles.probability}>
              <Text style={[styles.probabilityValue, { color: riskColor.foreground }]}>
                {probability === null ? "--" : `${(probability * 100).toFixed(0)}%`}
              </Text>
              <Text style={[styles.probabilityLabel, { color: riskColor.foreground }]}>class-1 score</Text>
            </View>
          </View>

          <View style={styles.metrics}>
            <Metric label="PM2.5 daily mean" value={pm2_5_24h_mean} unit="µg/m³" />
            <Metric label="NO₂ daily mean" value={nitrogen_dioxide_24h_mean} unit="µg/m³" />
            <Metric label="O₃ rolling 8h max" value={ozone_8h_max} unit="µg/m³" />
          </View>

          <View style={styles.freshness}>
            <Text style={styles.freshnessDot}>●</Text>
            <Text style={styles.freshnessText}>
              Previous complete day{observedAt ? ` · updated ${observedAt.toLocaleString()}` : ""}
            </Text>
          </View>
        </>
      ) : (
        <View style={styles.statusBox}>
          <Text style={styles.statusText}>Turn on location monitoring to check your area.</Text>
        </View>
      )}

      <View style={styles.disclaimer}>
        <Text style={styles.disclaimerTitle}>Not an asthma-attack probability</Text>
        <Text style={styles.disclaimerText}>
          This score estimates environmental conditions from air-quality data. It cannot predict or rule out an asthma attack for an individual. Follow your clinician’s asthma action plan.
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: "#ffffff",
    borderRadius: 24,
    padding: 20,
    marginTop: 18,
    borderWidth: 1,
    borderColor: "#e8eee8",
    shadowColor: "#183b2c",
    shadowOpacity: 0.06,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 3,
  },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 18 },
  eyebrow: { color: "#688076", fontSize: 10, fontWeight: "800", letterSpacing: 1.4 },
  title: { color: "#19382c", fontSize: 21, fontWeight: "800", marginTop: 4 },
  historicalDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: "#d59b32" },
  riskBanner: { borderRadius: 18, padding: 17, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  riskCopy: { flex: 1 },
  riskLabel: { fontSize: 12, fontWeight: "700" },
  riskName: { fontSize: 26, fontWeight: "800", textTransform: "capitalize", marginTop: 2 },
  probability: { alignItems: "flex-end" },
  probabilityValue: { fontSize: 28, fontWeight: "800" },
  probabilityLabel: { fontSize: 11, fontWeight: "600" },
  metrics: { flexDirection: "row", marginTop: 18, marginHorizontal: -5 },
  metric: { flex: 1, backgroundColor: "#f6f8f5", borderRadius: 14, marginHorizontal: 5, paddingVertical: 13, paddingHorizontal: 8 },
  metricValue: { color: "#203c30", fontSize: 18, fontWeight: "800" },
  metricUnit: { color: "#6d7f75", fontSize: 9, marginTop: 2 },
  metricLabel: { color: "#566b60", fontSize: 10, fontWeight: "600", marginTop: 8, lineHeight: 14 },
  freshness: { flexDirection: "row", alignItems: "center", marginTop: 14 },
  freshnessDot: { color: "#d59b32", fontSize: 9, marginRight: 7 },
  freshnessText: { color: "#687a70", fontSize: 11, flex: 1 },
  statusBox: { minHeight: 88, justifyContent: "center", alignItems: "center", paddingHorizontal: 20 },
  statusText: { color: "#5c7166", fontSize: 14, textAlign: "center", marginTop: 10, lineHeight: 20 },
  errorBox: { padding: 15, backgroundColor: "#fff1ee", borderRadius: 15 },
  errorTitle: { color: "#a83b31", fontWeight: "800", fontSize: 15, marginBottom: 5 },
  errorText: { color: "#7c4c46", fontSize: 13, lineHeight: 19 },
  disclaimer: { marginTop: 18, paddingTop: 14, borderTopWidth: 1, borderTopColor: "#edf0ed" },
  disclaimerTitle: { color: "#4b6155", fontSize: 11, fontWeight: "800", marginBottom: 4 },
  disclaimerText: { color: "#77877e", fontSize: 11, lineHeight: 16 },
});
