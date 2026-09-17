import { sanitizeUrl, sanitizeLocatorText } from "./sanitize.js";
import { nowIso, type Breadcrumb } from "./config.js";
import type { SdkState } from "./config.js";
import { createBreadcrumb } from "./breadcrumbs.js";

/**
 * Network capture configuration
 */
export interface NetworkCaptureConfig {
  captureFailedRequests: boolean;
  denyUrls: string[];
  onNetworkEvent: (breadcrumb: Breadcrumb) => void;
}

/**
 * Setup fetch/XHR wrapping for network capture
 */
export function setupNetworkCapture(
  state: SdkState,
  config: NetworkCaptureConfig,
): () => void {
  if (typeof window === "undefined" || typeof fetch === "undefined") {
    return () => {};
  }

  const originalFetch = window.fetch.bind(window);
  state.originalFetch = originalFetch;

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const method = (init?.method || "GET").toUpperCase();
    const startedAt = nowIso();
    const requestStart = performance.now();

    // Check denyUrls
    if (config.denyUrls.some((deny) => url.includes(deny))) {
      return originalFetch(input, init);
    }

    // Don't capture our own ingest requests
    if (url.includes("/api/ingest/v1/")) {
      return originalFetch(input, init);
    }

    try {
      const response = await originalFetch(input, init);
      const durationMs = Math.round(performance.now() - requestStart);
      const statusCode = response.status;

      // Determine if this is a failure
      const isError =
        statusCode >= 500 || statusCode === 0 || response.type === "error";
      const isClientError = statusCode >= 400 && statusCode < 500;

      if (config.captureFailedRequests === true && (isError || isClientError)) {
        const breadcrumb = createBreadcrumb("network", {
          message: `${method} ${sanitizeUrl(url)} ${statusCode}`,
          level: isError ? "error" : "warning",
          data: {
            url: sanitizeUrl(url),
            method,
            status_code: statusCode,
            duration_ms: durationMs,
            request_started_at: startedAt,
            failure_type: isError ? "http_error" : undefined,
          },
          event_type: "network",
        });
        config.onNetworkEvent(breadcrumb);
      }

      return response;
    } catch (error) {
      const durationMs = Math.round(performance.now() - requestStart);

      if (config.captureFailedRequests) {
        const breadcrumb = createBreadcrumb("network", {
          message: `${method} ${sanitizeUrl(url)} failed`,
          level: "error",
          data: {
            url: sanitizeUrl(url),
            method,
            status_code: null,
            duration_ms: durationMs,
            request_started_at: startedAt,
            failure_type: "network_error",
          },
          event_type: "network",
        });
        config.onNetworkEvent(breadcrumb);
      }

      throw error;
    }
  };

  // XHR wrapping
  const originalXhrOpen = XMLHttpRequest.prototype.open;
  const originalXhrSend = XMLHttpRequest.prototype.send;
  state.originalXhrOpen = originalXhrOpen.bind(XMLHttpRequest.prototype);
  state.originalXhrSend = originalXhrSend.bind(XMLHttpRequest.prototype);

  XMLHttpRequest.prototype.open = function (
    method: string,
    url: string | URL,
    async: boolean = true,
    username?: string | null,
    password?: string | null,
  ) {
    (
      this as XMLHttpRequest & {
        _replaybug_url?: string;
        _replaybug_method?: string;
        _replaybug_started?: string;
      }
    )._replaybug_url = typeof url === "string" ? url : url.toString();
    (
      this as XMLHttpRequest & { _replaybug_method?: string }
    )._replaybug_method = method.toUpperCase();
    (
      this as XMLHttpRequest & { _replaybug_started?: string }
    )._replaybug_started = nowIso();
    return originalXhrOpen.call(this, method, url, async, username, password);
  };

  XMLHttpRequest.prototype.send = function (body?: Document | BodyInit | null) {
    const xhr = this as XMLHttpRequest & {
      _replaybug_url?: string;
      _replaybug_method?: string;
      _replaybug_started?: string;
    };

    const url = xhr._replaybug_url || "";
    const method = xhr._replaybug_method || "GET";
    const startedAt = xhr._replaybug_started || nowIso();
    const requestStart = performance.now();

    const onLoadEnd = () => {
      const durationMs = Math.round(performance.now() - requestStart);
      const statusCode = xhr.status;

      // Check denyUrls
      if (config.denyUrls.some((deny) => url.includes(deny))) {
        return;
      }

      // Don't capture our own ingest requests
      if (url.includes("/api/ingest/v1/")) {
        return;
      }

      const isError = statusCode >= 500 || statusCode === 0;
      const isClientError = statusCode >= 400 && statusCode < 500;

      if (config.captureFailedRequests === true && (isError || isClientError)) {
        const breadcrumb = createBreadcrumb("network", {
          message: `${method} ${sanitizeUrl(url)} ${statusCode}`,
          level: isError ? "error" : "warning",
          data: {
            url: sanitizeUrl(url),
            method,
            status_code: statusCode,
            duration_ms: durationMs,
            request_started_at: startedAt,
            failure_type: isError ? "http_error" : undefined,
          },
          event_type: "network",
        });
        config.onNetworkEvent(breadcrumb);
      }
    };

    if ("onloadend" in xhr) {
      const originalOnLoadEnd = xhr.onloadend;
      xhr.onloadend = (event) => {
        onLoadEnd();
        if (originalOnLoadEnd) originalOnLoadEnd.call(xhr, event);
      };
    } else {
      (xhr as EventTarget).addEventListener("loadend", onLoadEnd);
    }

    return originalXhrSend.call(
      this,
      body as Document | XMLHttpRequestBodyInit | null,
    );
  };

  // Return cleanup function
  return () => {
    window.fetch = originalFetch;
    XMLHttpRequest.prototype.open = originalXhrOpen;
    XMLHttpRequest.prototype.send = originalXhrSend;
  };
}

/**
 * Click capture configuration
 */
export interface ClickCaptureConfig {
  captureClicks: boolean;
  onClickEvent: (breadcrumb: Breadcrumb) => void;
}

/**
 * Generate locator candidates for an element
 */
function generateLocatorCandidates(element: Element): Array<{
  type: "test_id" | "role_name" | "id" | "name" | "css_fallback";
  value: string;
  confidence: number;
}> {
  const candidates: Array<{
    type: "test_id" | "role_name" | "id" | "name" | "css_fallback";
    value: string;
    confidence: number;
  }> = [];

  // 1. data-testid (or configured test-id attribute)
  const testId =
    element.getAttribute("data-testid") || element.getAttribute("data-test-id");
  if (testId) {
    candidates.push({ type: "test_id", value: testId, confidence: 1.0 });
  }

  // 2. ARIA role + accessible name
  const role = element.getAttribute("role") || getImplicitRole(element);
  const accessibleName = getAccessibleName(element);
  if (role && accessibleName && accessibleName.length <= 50) {
    candidates.push({
      type: "role_name",
      value: `${role}[name="${accessibleName}"]`,
      confidence: 0.9,
    });
  }

  // 3. Stable ID
  const id = element.id;
  if (id && !isLikelyGenerated(id)) {
    candidates.push({ type: "id", value: `#${id}`, confidence: 0.8 });
  }

  // 4. Name attribute for form controls
  const name = element.getAttribute("name");
  if (name && isFormControl(element)) {
    candidates.push({
      type: "name",
      value: `${element.tagName.toLowerCase()}[name="${name}"]`,
      confidence: 0.7,
    });
  }

  // 5. CSS fallback (structural, not nth-child)
  const cssFallback = generateCssFallback(element);
  if (cssFallback) {
    candidates.push({
      type: "css_fallback",
      value: cssFallback,
      confidence: 0.5,
    });
  }

  return candidates.slice(0, 5);
}

function getImplicitRole(element: Element): string | null {
  const tag = element.tagName.toLowerCase();
  const type = element.getAttribute("type")?.toLowerCase();

  const roles: Record<string, string> = {
    a: "link",
    button: "button",
    input:
      type === "checkbox" ? "checkbox" : type === "radio" ? "radio" : "textbox",
    select: "combobox",
    textarea: "textbox",
    form: "form",
    img: "img",
    nav: "navigation",
    main: "main",
    header: "banner",
    footer: "contentinfo",
  };

  return roles[tag] || null;
}

function getAccessibleName(element: Element): string | null {
  // aria-label
  const ariaLabel = element.getAttribute("aria-label");
  if (ariaLabel) return ariaLabel;

  // aria-labelledby
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    const labelEl = document.getElementById(labelledBy);
    if (labelEl) return labelEl.textContent?.trim() || null;
  }

  // <label for=...>
  const id = element.id;
  if (id) {
    const label = document.querySelector(`label[for="${id}"]`);
    if (label) return label.textContent?.trim() || null;
  }

  // Parent label
  const parentLabel = element.closest("label");
  if (parentLabel) return parentLabel.textContent?.trim() || null;

  // Text content for buttons/links
  const tag = element.tagName.toLowerCase();
  if (["button", "a", "span", "div"].includes(tag)) {
    const text = element.textContent?.trim();
    if (text && text.length <= 50) return text;
  }

  // Input value (for buttons)
  const inputType = element.getAttribute("type") || "";
  if (tag === "input" && ["button", "submit", "reset"].includes(inputType)) {
    const value = element.getAttribute("value");
    if (value && value.length <= 50) return value;
  }

  return null;
}

function isFormControl(element: Element): boolean {
  const tag = element.tagName.toLowerCase();
  return ["input", "select", "textarea", "button"].includes(tag);
}

function isLikelyGenerated(id: string): boolean {
  // UUID-like
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  )
    return true;
  // Long numeric
  if (/^\d{10,}$/.test(id)) return true;
  // Random-looking alphanumeric
  if (/^[a-z0-9]{20,}$/i.test(id)) return true;
  return false;
}

function generateCssFallback(element: Element): string | null {
  const parts: string[] = [];
  let current: Element | null = element;

  for (let depth = 0; depth < 3 && current; depth++) {
    const tag = current.tagName.toLowerCase();
    let selector = tag;

    // Add ID if stable
    const id = current.id;
    if (id && !isLikelyGenerated(id)) {
      selector = `#${id}`;
      parts.unshift(selector);
      break;
    }

    // Add class if stable (not utility classes)
    const classes = Array.from(current.classList).filter(
      (c) =>
        !c.startsWith("css-") &&
        !c.startsWith("sc-") &&
        !c.startsWith("_") &&
        !/^\d+$/.test(c) &&
        c.length > 2,
    );
    if (classes.length > 0) {
      selector = `${tag}.${classes[0]}`;
    }

    // Add nth-of-type only if needed
    const parent = current.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter(
        (el: Element): el is Element => el.tagName === current!.tagName,
      );
      if (siblings.length > 1) {
        const index = siblings.indexOf(current as Element) + 1;
        selector += `:nth-of-type(${index})`;
      }
    }

    parts.unshift(selector);
    current = parent as Element | null;
  }

  return parts.join(" > ") || null;
}

/**
 * Setup click capture with delegated event listener
 */
export function setupClickCapture(
  state: SdkState,
  config: ClickCaptureConfig,
): () => void {
  if (typeof document === "undefined") {
    return () => {};
  }

  const handler = (event: MouseEvent) => {
    if (!config.captureClicks) return;

    const target = event.target as HTMLElement;
    if (!target) return;

    // Ignore data-replaybug-ignore
    if (
      target.hasAttribute("data-replaybug-ignore") ||
      target.closest("[data-replaybug-ignore]")
    ) {
      return;
    }

    // Generate locator candidates
    const candidates = generateLocatorCandidates(target);

    // Accessible name (short, sanitized)
    const accessibleName = getAccessibleName(target);
    const sanitizedName = accessibleName
      ? sanitizeLocatorText(accessibleName)
      : undefined;

    // Current route (best effort)
    let route: string | undefined;
    try {
      route = window.location.pathname + window.location.search;
    } catch {
      // ignore
    }

    const breadcrumb = createBreadcrumb("click", {
      message: `Click: ${target.tagName.toLowerCase()}${sanitizedName ? ` ${sanitizedName}` : ""}`,
      data: {
        locator_candidates: candidates,
        element_tag: target.tagName.toLowerCase(),
        element_role: getImplicitRole(target) || undefined,
        accessible_name: sanitizedName,
        route,
      },
      event_type: "click",
    });
    config.onClickEvent(breadcrumb);
  };

  document.addEventListener("click", handler, true); // Use capture phase
  state.clickHandler = handler;

  return () => {
    document.removeEventListener("click", handler, true);
  };
}

/**
 * Navigation capture configuration
 */
export interface NavigationCaptureConfig {
  captureNavigation: boolean;
  onNavigationEvent: (breadcrumb: Breadcrumb) => void;
}

/**
 * Setup navigation capture (pushState, replaceState, popstate, hashchange)
 */
export function setupNavigationCapture(
  state: SdkState,
  config: NavigationCaptureConfig,
): () => void {
  if (typeof window === "undefined" || typeof history === "undefined") {
    return () => {};
  }

  let lastUrl = window.location.href;

  const captureNavigation = (
    fromUrl: string | null,
    toUrl: string,
    navigationType:
      "pushState" | "replaceState" | "popstate" | "hashchange" | "full_reload",
  ) => {
    if (!config.captureNavigation) return;
    if (fromUrl === toUrl) return;

    const breadcrumb = createBreadcrumb("navigation", {
      message: `Navigation: ${sanitizeUrl(fromUrl || "")} → ${sanitizeUrl(toUrl)}`,
      data: {
        from_url: fromUrl ? sanitizeUrl(fromUrl) : null,
        to_url: sanitizeUrl(toUrl),
        navigation_type: navigationType,
      },
      event_type: "navigation",
    });
    config.onNavigationEvent(breadcrumb);
  };

  // Wrap pushState
  const originalPushState = history.pushState;
  state.originalPushState = originalPushState.bind(history);
  history.pushState = function (data, unused, url) {
    const toUrl = url
      ? new URL(url, window.location.origin).href
      : window.location.href;
    captureNavigation(lastUrl, toUrl, "pushState");
    lastUrl = toUrl;
    return originalPushState.call(this, data, unused, url);
  };

  // Wrap replaceState
  const originalReplaceState = history.replaceState;
  state.originalReplaceState = originalReplaceState.bind(history);
  history.replaceState = function (data, unused, url) {
    const toUrl = url
      ? new URL(url, window.location.origin).href
      : window.location.href;
    captureNavigation(lastUrl, toUrl, "replaceState");
    lastUrl = toUrl;
    return originalReplaceState.call(this, data, unused, url);
  };

  // popstate
  const popstateHandler = (_event: PopStateEvent) => {
    const toUrl = window.location.href;
    captureNavigation(lastUrl, toUrl, "popstate");
    lastUrl = toUrl;
  };
  window.addEventListener("popstate", popstateHandler);
  state.popstateHandler = popstateHandler;

  // hashchange
  const hashchangeHandler = () => {
    const toUrl = window.location.href;
    captureNavigation(lastUrl, toUrl, "hashchange");
    lastUrl = toUrl;
  };
  window.addEventListener("hashchange", hashchangeHandler);

  // Return cleanup function
  return () => {
    history.pushState = originalPushState;
    history.replaceState = originalReplaceState;
    window.removeEventListener("popstate", popstateHandler);
    window.removeEventListener("hashchange", hashchangeHandler);
  };
}
