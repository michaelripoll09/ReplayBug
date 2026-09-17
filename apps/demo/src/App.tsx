import { SDK_VERSION } from "@replaybug/sdk";

/**
 * Foundation smoke screen. Deterministic bug scenarios (exceptions,
 * rejections, failed fetch, redaction forms, minified release error) arrive
 * in a later block per the master specification.
 */
export function App(): React.JSX.Element {
  return (
    <main
      style={{
        fontFamily: "system-ui, sans-serif",
        maxWidth: 640,
        margin: "4rem auto",
        padding: "0 1.5rem",
        textAlign: "center",
      }}
    >
      <h1>ReplayBug Demo App</h1>
      <p>
        Smoke screen for the repository bootstrap. Bug scenarios are not
        implemented yet.
      </p>
      <p>
        <code>@replaybug/sdk v{SDK_VERSION}</code> loads without errors.
      </p>
    </main>
  );
}
