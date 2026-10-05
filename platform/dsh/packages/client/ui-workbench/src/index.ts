/**
 * Workbench plugin, node half. Pure UI plugin: the empty apply exists so the
 * plugin appears in the profile's cordis patch and the Loader mounts a row for
 * it; the browser half ships through exports["./client"], discovered through
 * this package's `dsh.client` declaration.
 */

/** Host plugin body — no host-side behavior for this surface plugin. */
export function apply(): void {}
