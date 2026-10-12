/* Roll the SVG URL on each frontend build so Cloudflare serves the new logo. */
export const LOGO_URL = `/logo.svg?t=${__WTOX_BUILD_TAG__}`;
