/**
 * ensureUiCookie — install the HttpOnly cookie that gates /api/ui/* routes.
 *
 * The browser cannot attach an `Authorization` header to EventSource or to
 * the `@opencode-ai/sdk` fetch calls, so we gate those routes on an HttpOnly
 * cookie instead. This helper POSTs the master key (from localStorage) to
 * /api/ui/auth/cookie once per page-load; subsequent calls return the cached
 * promise so only one request is ever made.
 *
 * Callers: any client module that opens an /api/ui/* connection — currently
 * sdk-stream.tsx (legacy EventSource stream) and opencode-stream.tsx
 * (opencode SDK event bus).
 */

let _uiCookiePromise: Promise<boolean> | null = null;

/**
 * Ensure the HttpOnly UI auth cookie is installed in the browser.
 * Resolves true on success, false on auth failure or network error.
 * Idempotent — safe to call multiple times per page.
 */
export function ensureUiCookie(): Promise<boolean> {
  if (_uiCookiePromise) return _uiCookiePromise;
  _uiCookiePromise = (async () => {
    if (typeof window === "undefined") return false;
    let key: string | null = null;
    try {
      key = window.localStorage.getItem("ui_master_key");
    } catch {
      return false;
    }
    if (!key) return false;
    try {
      const res = await fetch("/api/ui/auth/cookie", {
        method: "POST",
        headers: { authorization: `Bearer ${key}` },
      });
      return res.ok;
    } catch {
      return false;
    }
  })();
  return _uiCookiePromise;
}
