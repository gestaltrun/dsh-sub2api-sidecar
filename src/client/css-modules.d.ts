/**
 * CSS Modules carry hashed class names; the runtime contract here is a plain
 * `Record<string, string>` of local name to emitted class.
 */
declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}
