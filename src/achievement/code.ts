/** Compare notation only: never infer a subject, grade band, or curriculum year. */
export function normalizeAchievementCode(value: string): string {
  const compact = value.trim().replace(/\s+/gu, "");
  // Remove only a balanced outer pair; malformed brackets are not corrected.
  return compact.startsWith("[") && compact.endsWith("]")
    ? compact.slice(1, -1) : compact;
}

export function matchesAchievementCode(field: {raw: string} | undefined, requested: string): boolean {
  // The source spelling is authoritative. A normalized alias cannot change its identity.
  return !!field && normalizeAchievementCode(field.raw) === normalizeAchievementCode(requested);
}
