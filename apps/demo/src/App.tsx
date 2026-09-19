import { useEffect, useRef, useState } from "react";
import {
  init,
  captureException,
  addBreadcrumb,
  setUser,
  close,
} from "@replaybug/sdk";
import {
  MINIFIED_RELEASE_BUTTON_LABEL,
  MINIFIED_RELEASE_SCENARIO_ID,
  MINIFIED_RELEASE_TEST_ID,
  MINIFIED_RELEASE_VERSION,
  triggerMinifiedReleaseError,
} from "./scenarios/minified-release-error.js";

/**
 * ReplayBug Demo App - Telemetry verification scenarios
 * Initializes SDK with environment configuration and provides
 * buttons to trigger intentional error scenarios for E2E testing.
 */
export function App(): React.JSX.Element {
  const [sdkInitialized, setSdkInitialized] = useState(false);
  const [telemetryEnabled, setTelemetryEnabled] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const safeInputRef = useRef<HTMLInputElement>(null);
  const passwordInputRef = useRef<HTMLInputElement>(null);
  const cardInputRef = useRef<HTMLInputElement>(null);
  const tokenInputRef = useRef<HTMLInputElement>(null);
  const maskedInputRef = useRef<HTMLInputElement>(null);
  const ignoredInputRef = useRef<HTMLInputElement>(null);

  // Initialize SDK on mount
  // The release defaults to the deterministic RS-11 constant so a production
  // build served without an explicit env release still reports the exact
  // release string the RS-12 E2E creates via the CLI. The E2E overrides it
  // with VITE_REPLAYBUG_RELEASE set to the same constant.
  const release =
    import.meta.env.VITE_REPLAYBUG_RELEASE ?? MINIFIED_RELEASE_VERSION;
  useEffect(() => {
    const dsn = import.meta.env.VITE_REPLAYBUG_DSN;
    const environment =
      import.meta.env.VITE_REPLAYBUG_ENVIRONMENT ?? "development";

    if (!dsn) {
      console.log("[Demo] No DSN provided, telemetry disabled");
      setTelemetryEnabled(false);
      return;
    }

    try {
      init({
        dsn,
        environment,
        release,
        debug: true,
        captureConsoleErrors: true,
        captureFailedRequests: true,
        captureClicks: true,
        captureNavigation: true,
        captureSafeInputs: true,
        safeInputSelectors: ['input[data-replaybug-safe="true"]'],
      });
      setSdkInitialized(true);
      setTelemetryEnabled(true);
      console.log("[Demo] ReplayBug SDK initialized");
    } catch (error) {
      console.error("[Demo] Failed to initialize SDK:", error);
      setLastError(error instanceof Error ? error.message : String(error));
    }

    return () => {
      close().catch(console.error);
    };
  }, []);

  const triggerJsException = () => {
    try {
      // Simulates an API response that violates its contract and returns null
      const product = JSON.parse("null") as { price: number };
      const price = product.price; // Intentional TypeError at runtime
      console.log(price);
    } catch (error) {
      captureException(error as Error, { scenario: "checkout-null-product" });
      setLastError(`Exception captured: ${(error as Error).message}`);
    }
  };

  const triggerUnhandledRejection = () => {
    // Intentionally not catching this promise rejection
    Promise.reject(new Error("DEMO: Intentional unhandled rejection"));
    setLastError("Unhandled rejection triggered");
  };

  const triggerConsoleError = () => {
    console.error("DEMO: Intentional console.error", {
      timestamp: Date.now(),
      context: "demo-test",
    });
    setLastError("Console error logged");
  };

  const triggerFailedFetch = async () => {
    try {
      await fetch("/api/demo/500-endpoint", { method: "POST" });
    } catch (error) {
      // Network error will be captured by SDK automatically
      setLastError(`Failed fetch attempted: ${(error as Error).message}`);
    }
  };

  const setDemoUser = () => {
    setUser({ id: "synthetic-user-123" });
    addBreadcrumb({
      type: "custom",
      category: "demo",
      message: "Demo user set via setUser()",
      level: "info",
    });
    setLastError("User set: synthetic-user-123");
  };

  const clearDemoUser = () => {
    setUser(null);
    setLastError("User cleared");
  };

  const triggerMinifiedReleaseErrorScenario = () => {
    try {
      triggerMinifiedReleaseError();
    } catch (error) {
      captureException(error as Error, {
        scenario: MINIFIED_RELEASE_SCENARIO_ID,
      });
      setLastError(`Exception captured: ${(error as Error).message}`);
    }
  };

  const triggerNavigationClickError = () => {
    // Navigate (simulated via hash change)
    window.location.hash = "step1";
    addBreadcrumb({
      type: "navigation",
      category: "demo",
      message: "Navigated to step1",
      level: "info",
    });

    // Click simulation
    setTimeout(() => {
      addBreadcrumb({
        type: "click",
        category: "demo",
        message: "Clicked step1 button",
        level: "info",
        data: { element: "button.step1" },
      });

      // Click that causes error
      setTimeout(() => {
        try {
          throw new Error("DEMO: Error after navigation and click");
        } catch (error) {
          captureException(error as Error, {
            scenario: "navigation-click-error",
          });
          setLastError("Navigation → Click → Error captured");
        }
      }, 100);
    }, 100);
  };

  return (
    <main
      style={{
        fontFamily: "system-ui, sans-serif",
        maxWidth: 800,
        margin: "2rem auto",
        padding: "0 1.5rem",
      }}
    >
      <header style={{ textAlign: "center", marginBottom: "2rem" }}>
        <h1>ReplayBug Demo App</h1>
        <p style={{ color: "#666" }}>
          Telemetry verification scenarios for E2E testing
        </p>
      </header>

      <section
        style={{
          border: "1px solid #ddd",
          borderRadius: "8px",
          padding: "1rem",
          marginBottom: "1.5rem",
          background: telemetryEnabled ? "#e8f5e9" : "#fff3e0",
        }}
      >
        <h2>SDK Status</h2>
        <p>
          <strong>Initialized:</strong> {sdkInitialized ? "✅ Yes" : "❌ No"}
        </p>
        <p>
          <strong>Telemetry:</strong>{" "}
          {telemetryEnabled ? "✅ Enabled" : "❌ Disabled (no DSN)"}
        </p>
        <p>
          <strong>Environment:</strong>{" "}
          {import.meta.env.VITE_REPLAYBUG_ENVIRONMENT ?? "development"}
        </p>
        <p>
          <strong>Release:</strong> {release}
        </p>
        {lastError && (
          <p style={{ color: "#c62828" }}>
            <strong>Last Action:</strong> {lastError}
          </p>
        )}
      </section>

      <section style={{ marginBottom: "1.5rem" }}>
        <h2>Intentional Error Scenarios</h2>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
          <button
            onClick={triggerJsException}
            style={{ padding: "0.75rem 1rem" }}
          >
            1. JavaScript Exception
          </button>
          <button
            onClick={triggerUnhandledRejection}
            style={{ padding: "0.75rem 1rem" }}
          >
            2. Unhandled Promise Rejection
          </button>
          <button
            onClick={triggerConsoleError}
            style={{ padding: "0.75rem 1rem" }}
          >
            3. Console Error
          </button>
          <button
            onClick={triggerFailedFetch}
            style={{ padding: "0.75rem 1rem" }}
          >
            4. Failed Fetch (500)
          </button>
          <button
            onClick={triggerNavigationClickError}
            style={{ padding: "0.75rem 1rem" }}
          >
            5. Navigation → Click → Error
          </button>
          <button
            onClick={triggerMinifiedReleaseErrorScenario}
            style={{ padding: "0.75rem 1rem" }}
            data-testid={MINIFIED_RELEASE_TEST_ID}
          >
            {MINIFIED_RELEASE_BUTTON_LABEL}
          </button>
        </div>
      </section>

      <section style={{ marginBottom: "1.5rem" }}>
        <h2>User Identity</h2>
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          <button onClick={setDemoUser} style={{ padding: "0.5rem 1rem" }}>
            <code>{'setUser({ id: "synthetic-user-123" })'}</code>
          </button>
          <button onClick={clearDemoUser} style={{ padding: "0.5rem 1rem" }}>
            clearUser()
          </button>
        </div>
        <p style={{ fontSize: "0.875rem", color: "#666" }}>
          Server derives anonymous_user_hash via HMAC. Raw user ID never
          persists.
        </p>
      </section>

      <section style={{ marginBottom: "1.5rem" }}>
        <h2>Privacy Test Form</h2>
        <form
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "1rem",
            maxWidth: "400px",
          }}
        >
          <div>
            <label
              style={{
                display: "block",
                marginBottom: "0.25rem",
                fontWeight: 500,
              }}
            >
              Safe Field (opt-in, value captured):
            </label>
            <input
              ref={safeInputRef}
              type="text"
              placeholder="SAFE_REPLAYBUG_VALUE"
              data-replaybug-safe="true"
              style={{
                width: "100%",
                padding: "0.5rem",
                fontFamily: "monospace",
              }}
            />
          </div>

          <div>
            <label
              style={{
                display: "block",
                marginBottom: "0.25rem",
                fontWeight: 500,
              }}
            >
              Password (auto-redacted):
            </label>
            <input
              ref={passwordInputRef}
              type="password"
              placeholder="ReplayBugPassword123!"
              style={{
                width: "100%",
                padding: "0.5rem",
                fontFamily: "monospace",
              }}
            />
          </div>

          <div>
            <label
              style={{
                display: "block",
                marginBottom: "0.25rem",
                fontWeight: 500,
              }}
            >
              Credit Card (auto-redacted):
            </label>
            <input
              ref={cardInputRef}
              type="text"
              placeholder="4111111111111111"
              style={{
                width: "100%",
                padding: "0.5rem",
                fontFamily: "monospace",
              }}
            />
          </div>

          <div>
            <label
              style={{
                display: "block",
                marginBottom: "0.25rem",
                fontWeight: 500,
              }}
            >
              Token (auto-redacted):
            </label>
            <input
              ref={tokenInputRef}
              type="text"
              placeholder="rb_demo_token_secret_value"
              style={{
                width: "100%",
                padding: "0.5rem",
                fontFamily: "monospace",
              }}
            />
          </div>

          <div>
            <label
              style={{
                display: "block",
                marginBottom: "0.25rem",
                fontWeight: 500,
              }}
            >
              Masked Field (data-replaybug-mask):
            </label>
            <input
              ref={maskedInputRef}
              type="text"
              placeholder="MASKED_REPLAYBUG_VALUE"
              data-replaybug-mask="true"
              style={{
                width: "100%",
                padding: "0.5rem",
                fontFamily: "monospace",
              }}
            />
          </div>

          <div>
            <label
              style={{
                display: "block",
                marginBottom: "0.25rem",
                fontWeight: 500,
              }}
            >
              Ignored Element (data-replaybug-ignore):
            </label>
            <input
              ref={ignoredInputRef}
              type="text"
              placeholder="IGNORED_REPLAYBUG_VALUE"
              data-replaybug-ignore="true"
              style={{
                width: "100%",
                padding: "0.5rem",
                fontFamily: "monospace",
              }}
            />
          </div>

          <div>
            <label
              style={{
                display: "block",
                marginBottom: "0.25rem",
                fontWeight: 500,
              }}
            >
              JWT (auto-redacted in context/payload):
            </label>
            <input
              type="text"
              placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
              style={{
                width: "100%",
                padding: "0.5rem",
                fontFamily: "monospace",
                fontSize: "0.75rem",
              }}
            />
          </div>

          <button
            type="button"
            onClick={() => {
              captureException(new Error("DEMO: Privacy form submitted"), {
                form: "privacy-test",
              });
              setLastError("Privacy form submitted - exception captured");
            }}
            style={{
              padding: "0.75rem 1.5rem",
              background: "#1976d2",
              color: "white",
              border: "none",
              borderRadius: "4px",
              cursor: "pointer",
            }}
          >
            Submit & Trigger Exception (forces flush)
          </button>
        </form>
      </section>

      <footer
        style={{
          marginTop: "2rem",
          paddingTop: "1rem",
          borderTop: "1px solid #eee",
          color: "#666",
          fontSize: "0.875rem",
        }}
      >
        <p>
          <code>@replaybug/sdk</code> loaded. Open browser console to see SDK
          debug logs. Network tab shows <code>POST /api/ingest/v1/batch</code>{" "}
          requests.
        </p>
      </footer>
    </main>
  );
}
