"use client";

import * as React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";

/**
 * Sanitized Markdown renderer for issue comments.
 *
 * - `react-markdown` never parses raw HTML into elements without
 *   `rehype-raw` (deliberately absent), so `<script>`/`<img onerror>`
 *   source renders as inert text.
 * - `rehype-sanitize` (default schema) strips dangerous URLs
 *   (`javascript:`), event handlers and unsafe elements from the
 *   generated tree.
 * - No home-grown parser, no `dangerouslySetInnerHTML` anywhere.
 */
export function SafeMarkdown({ source }: { source: string }) {
  return (
    <div className="prose-sm max-w-none break-words text-sm dark:prose-invert">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={{
          a: ({ href, children }) => (
            <a
              href={href}
              rel="noopener noreferrer nofollow"
              target="_blank"
              className="underline"
            >
              {children}
            </a>
          ),
          pre: ({ children }) => (
            <pre className="overflow-x-auto rounded-md bg-zinc-100 p-2 font-mono text-xs dark:bg-zinc-800">
              {children}
            </pre>
          ),
          code: ({ children }) => (
            <code className="rounded bg-zinc-100 px-1 font-mono text-xs dark:bg-zinc-800">
              {children}
            </code>
          ),
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
