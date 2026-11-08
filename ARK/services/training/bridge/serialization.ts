/**
 * JSON-safe serialization for bridge results. JSON.stringify silently converts
 * NaN/Infinity to null, which would corrupt training data — every number is
 * checked finite, and typed arrays are converted to plain arrays first.
 */

export class NonFiniteValueError extends Error {
  public readonly path: string

  public constructor(path: string) {
    super(`Non-finite number at ${path}: refusing to serialize.`)
    this.name = 'NonFiniteValueError'
    this.path = path
  }
}

/** Converts typed arrays to plain arrays so the result is JSON-serializable. */
export function toJsonable(value: unknown): unknown {
  if (value instanceof Float32Array || value instanceof Float64Array || value instanceof Array) {
    return Array.from(value as ArrayLike<unknown>).map(toJsonable)
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = toJsonable(entry)
    }
    return out
  }
  return value
}

/** Throws NonFiniteValueError on the first non-finite number found. */
export function assertFiniteDeep(value: unknown, path = '$'): void {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new NonFiniteValueError(path)
    return
  }
  if (value instanceof Float32Array || value instanceof Float64Array || Array.isArray(value)) {
    const items = Array.from(value as ArrayLike<unknown>)
    for (let i = 0; i < items.length; i += 1) assertFiniteDeep(items[i], `${path}[${i}]`)
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      assertFiniteDeep(entry, `${path}.${key}`)
    }
  }
}

/** Validates finiteness, then returns a JSON-safe deep copy. */
export function serializeResult(value: unknown): unknown {
  assertFiniteDeep(value)
  return toJsonable(value)
}
