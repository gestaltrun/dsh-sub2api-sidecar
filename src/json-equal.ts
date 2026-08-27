/**
 * Deep equality over JSON-compatible data. Local copy of the settings seam's
 * predicate (the sidecar package does not import the harness packages), kept
 * member-identical so profile change detection behaves exactly like a
 * settings-layer comparison would.
 *
 * @module dsh-sub2api-sidecar/json-equal
 */

/**
 * Compare two JSON-compatible values structurally.
 * @param a - one value.
 * @param b - the other value.
 * @returns whether the two values are structurally equal.
 */
export function deepEqualJson(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((entry, index) => deepEqualJson(entry, b[index]))
  }
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false
  return keys.every((key) => key in right && deepEqualJson(left[key], right[key]))
}
