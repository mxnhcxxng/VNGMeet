// Helpers for reflecting a view's transient state — the browse date/search and
// the booking-history filters/pagination — into the URL query string so links
// are shareable and survive a refresh.
//
// We touch the URL directly through the History API, mirroring how
// app/[[...slug]]/page.tsx already syncs the *path*. Going through the History
// API (instead of the Next router) means updating a query param never remounts
// the page nor fights the path-level sync, which only ever compares pathname.

/** Current query params, or an empty set during SSR. */
export function readUrlParams(): URLSearchParams {
  if (typeof window === "undefined") return new URLSearchParams();
  return new URLSearchParams(window.location.search);
}

// Merge `updates` into the current query string and rewrite the URL in place. A
// null / undefined / "" value removes the key so the URL stays clean at default
// values. The pathname and hash are preserved, and we use replaceState so
// filter/paging tweaks don't spam the back-button history.
export function patchUrlParams(
  updates: Record<string, string | null | undefined>,
): void {
  if (typeof window === "undefined") return;
  const params = new URLSearchParams(window.location.search);
  for (const [key, value] of Object.entries(updates)) {
    if (value === null || value === undefined || value === "") {
      params.delete(key);
    } else {
      params.set(key, value);
    }
  }
  const qs = params.toString();
  const url = `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`;
  window.history.replaceState(window.history.state, "", url);
}
