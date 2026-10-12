/** Browser WebSocket retry pacing. HTTP polling remains active independently. */
export function realtimeRetryDelay(failures) {
  const attempts=Math.max(1,Math.floor(Number(failures)||1));
  return Math.min(60_000,3500*2**Math.min(5,attempts-1));
}
export function realtimeConnectionState(failures) {
  return failures>=3?"polling":"reconnecting";
}
