export function createPosHeartbeatCanonicalMessage(
  businessId: string,
  posUuid: string,
  nonce: string,
  issuedAtUnixMilliseconds: number,
): string {
  return [
    "fiskalo-atk-heartbeat-v1",
    "ATK TEST",
    businessId.toLowerCase(),
    posUuid.toLowerCase(),
    nonce,
    String(issuedAtUnixMilliseconds),
  ].join("\n");
}
