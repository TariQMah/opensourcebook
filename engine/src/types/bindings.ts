/**
 * Structural views of the Cloudflare bindings (D1, R2, Browser Rendering,
 * Queue). The real bindings satisfy these; tests supply small fakes.
 */
/**
 * Minimal structural view of the Cloudflare D1 binding. The real `D1Database`
 * from `@cloudflare/workers-types` satisfies this interface; tests can supply
 * a lightweight fake without importing Workers types.
 */
export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T = unknown>(column?: string): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
  /** Optional D1 session constraint (e.g. "primary") for read-after-write consistency. */
  withConstraint?(constraint: string): D1DatabaseLike;
  /** Runs the statements as one transaction (D1 `batch`). */
  batch?(statements: D1PreparedStatementLike[]): Promise<unknown[]>;
}

/**
 * Minimal structural view of the Cloudflare R2 binding. The real `R2Bucket`
 * from `@cloudflare/workers-types` satisfies this interface; tests can supply
 * a lightweight fake without importing Workers types.
 */
export interface R2ObjectBodyLike {
  key: string;
  size?: number;
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
  /** The object's bytes (only the asked range, for a ranged get), read as they are sent. */
  body?: ReadableStream<Uint8Array>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** Part of an object to read (R2's `R2Range`): from an offset for a length. */
export interface R2RangeLike {
  offset: number;
  length: number;
}

export interface R2ObjectHeadLike {
  key: string;
  size?: number;
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
}

export interface R2BucketLike {
  /** With `range`, only those bytes are read from storage. */
  get(key: string, options?: { range?: R2RangeLike }): Promise<R2ObjectBodyLike | null>;
  put(
    key: string,
    /** A stream must be of a known length (a ranged get's body, a request's body sent with its length). */
    value: ArrayBuffer | ArrayBufferView | string | ReadableStream<Uint8Array>,
    options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> },
  ): Promise<unknown>;
  head(key: string): Promise<R2ObjectHeadLike | null>;
  /** Removes an object; absent on bindings that cannot (the object then stays). */
  delete?(key: string): Promise<void>;
}

/**
 * Minimal structural view of the raw Cloudflare Browser Rendering binding —
 * at runtime the wrangler `[browser]` binding is a Fetcher. index.ts wraps it
 * with @cloudflare/puppeteer's launch() into a BrowserBindingLike before it
 * reaches the extractor; the real binding satisfies this interface.
 */
export interface BrowserRenderingBindingLike {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

/** Minimal structural view of a headless-browser page (subset of puppeteer's Page). */
export interface BrowserPageLike {
  setUserAgent(userAgent: string): Promise<void>;
  setViewport(viewport: { width: number; height: number }): Promise<void>;
  goto(
    url: string,
    options?: { waitUntil?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2"; timeout?: number },
  ): Promise<unknown>;
  content(): Promise<string>;
  close(): Promise<void>;
}

/** Minimal structural view of a headless-browser session (subset of puppeteer's Browser). */
export interface BrowserSessionLike {
  newPage(): Promise<BrowserPageLike>;
  close(): Promise<void>;
}

/**
 * Structural browser launcher — what the extraction ladder consumes. The
 * production adapter launches through the Browser Rendering binding; tests
 * supply a lightweight fake without importing puppeteer.
 */
export interface BrowserBindingLike {
  launch(): Promise<BrowserSessionLike>;
}

export interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}
