/**
 * Minimal Standard Schema v1 interface plus a helper that wraps a synchronous
 * validation function in that interface. The Cordis Loader validates a
 * function plugin's exported `Config` through `Config['~standard'].validate`
 * (sync results only), so this is the dependency-free way to ship a real
 * schema from a standalone bundle package.
 *
 * @module dsh-sub2api-sidecar/standard-schema
 */

/** One validation failure at a (possibly empty) value path. */
export interface SchemaIssue {
  /** Human-readable failure naming the field. */
  message: string
  /** Path to the offending value, root first; empty at the root. */
  path: ReadonlyArray<PropertyKey>
}

/** Synchronous Standard Schema v1 validation result. */
export type SchemaResult<T> =
  | { readonly value: T; readonly issues?: undefined }
  | { readonly value?: undefined; readonly issues: readonly SchemaIssue[] }

/** Standard Schema v1 interface subset the Cordis Loader consumes. */
export interface StandardSchema<T> {
  '~standard': {
    readonly version: 1
    readonly vendor: string
    /**
     * Validate one value synchronously.
     * @param value - the raw value to validate.
     * @returns the validated value or the issue list.
     */
    validate(value: unknown): SchemaResult<T>
  }
}

/**
 * Wrap a validation function as a Standard Schema v1 schema.
 * @param vendor - schema vendor id (the package name).
 * @param validate - synchronous validation; returns the resolved value or throws {@link SchemaError}.
 * @returns the schema object for the plugin's `Config` export.
 */
export function defineSyncSchema<T>(
  vendor: string,
  validate: (value: unknown) => T,
): StandardSchema<T> {
  return {
    '~standard': {
      version: 1,
      vendor,
      validate(value: unknown): SchemaResult<T> {
        try {
          return { value: validate(value) }
        } catch (error) {
          if (error instanceof SchemaError) return { issues: error.issues }
          throw error
        }
      },
    },
  }
}

/** Thrown by validators; carries structured issues for the `~standard` result. */
export class SchemaError extends Error {
  /** The collected validation issues. */
  readonly issues: readonly SchemaIssue[]

  /**
   * @param issues - the validation failures to report.
   */
  constructor(issues: readonly SchemaIssue[]) {
    super(issues.map((issue) => `${issue.path.map(String).join('.') || '<root>'}: ${issue.message}`).join('; '))
    this.name = 'SchemaError'
    this.issues = issues
  }
}

/**
 * Join a path prefix with one more segment.
 * @param prefix - the path so far; empty at the root.
 * @param key - the next segment.
 * @returns the extended path.
 */
export function childPath(prefix: ReadonlyArray<PropertyKey>, key: PropertyKey): ReadonlyArray<PropertyKey> {
  return [...prefix, key]
}
