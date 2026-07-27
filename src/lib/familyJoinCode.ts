export const FAMILY_JOIN_CODE_LIFETIME_SECONDS = 2 * 60 * 60

export function secondsUntilJoinCodeRotation(
  expiresAt: string,
  serverTimeOffsetMs: number,
  nowMs = Date.now(),
) {
  return Math.max(0, Math.ceil((Date.parse(expiresAt) - (nowMs + serverTimeOffsetMs)) / 1000))
}

export function formatJoinCodeCountdown(totalSeconds: number) {
  const boundedSeconds = Math.max(0, Math.floor(totalSeconds))
  const hours = Math.floor(boundedSeconds / 3600)
  const minutes = Math.floor((boundedSeconds % 3600) / 60)
  const seconds = boundedSeconds % 60
  return [hours, minutes, seconds].map(value => String(value).padStart(2, '0')).join(':')
}
