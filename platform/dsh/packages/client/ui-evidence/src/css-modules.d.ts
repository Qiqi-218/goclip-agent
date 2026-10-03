/**
 * Global stylesheet and CSS Modules declarations for the evidence panel.
 *
 * The repository compiles with `noUncheckedIndexedAccess`, so a class-name read
 * is `string | undefined` even for a class this package's own sheet defines.
 * Components here therefore take `className?: string`, the same currency the
 * intrinsic elements use, rather than asserting non-null at every call site.
 * @module
 */
declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}

declare module '*.css'
