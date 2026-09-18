import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  /**
   * Static hardening headers (Block 6 / T15 review).
   *
   * Deliberately NO script-src CSP: Next.js App Router hydration relies on
   * inline bootstrap scripts, so a static script CSP either breaks the app
   * or needs 'unsafe-inline' (no value). XSS defense instead rests on
   * React auto-escaping (zero dangerouslySetInnerHTML in app code) plus
   * sanitized Markdown (react-markdown + rehype-sanitize, no rehype-raw)
   * — both covered by component tests and Playwright XSS probes.
   * Deployments wanting script CSP should add nonce-based middleware.
   */
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};

export default nextConfig;
