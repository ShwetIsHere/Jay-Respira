export function createRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function logDiagnostic(requestId: string, stage: string, details: Record<string, unknown>): void {
  if (typeof __DEV__ !== "undefined" && __DEV__) {
    console.info(`[RESPIRA][${stage}]`, JSON.stringify({ requestId, ...details }));
  }
}
