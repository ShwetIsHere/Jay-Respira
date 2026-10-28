export type NotificationPermissionStatus = "granted" | "denied" | "unsupported";

export interface NotificationPayload {
  risk_level: "low" | "medium" | "high";
  risk_probability: number;
  pm2_5_24h_mean: number;
  nitrogen_dioxide_24h_mean: number;
  ozone_8h_max: number;
  source: "model-based environmental risk estimate";
}

const DEFAULT_COOLDOWN_MS = 60_000;
const lastNotificationState: Record<string, number> = {};

export async function requestNotificationPermission(): Promise<NotificationPermissionStatus> {
  return "unsupported";
}

export function hasNotificationCooldown(notificationKey: string, cooldownMs = DEFAULT_COOLDOWN_MS): boolean {
  const now = Date.now();
  const lastSent = lastNotificationState[notificationKey] ?? 0;
  return now - lastSent < cooldownMs;
}

export function isRiskNotificationEligible(payload: NotificationPayload): boolean {
  return payload.risk_level === "medium" || payload.risk_level === "high";
}

export async function sendRiskNotification(payload: NotificationPayload, notificationKey = "respira-risk-monitor", cooldownMs = DEFAULT_COOLDOWN_MS): Promise<boolean> {
  if (!isRiskNotificationEligible(payload)) {
    return false;
  }

  const permission = await requestNotificationPermission();
  if (permission !== "granted") {
    if (typeof __DEV__ !== "undefined" && __DEV__) {
      console.warn(`[RESPIRA][NOTIFICATION] Notifications are unavailable (${permission}); no notification was sent.`);
    }
    return false;
  }

  if (hasNotificationCooldown(notificationKey, cooldownMs)) {
    return false;
  }

  return false;
}
