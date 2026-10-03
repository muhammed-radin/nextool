/**
 * NexTool v1.0.8 — sandbox network layer (spec §1.2/§1.3/§1.4/§3/§3.1, v1.0.8 §4/§15).
 *
 * ONE controlled networking layer used by `fetch`, `XMLHttpRequest`, the
 * virtual `http`/`https` modules, URL imports and npm registry access in BOTH
 * function environments. Every request passes through `policyFetch`, which
 * enforces (all values resolved LIVE from config/configuration-limits.json —
 * no hard-coded limits remain in this file):
 *
 *  - protocol policy (http/https only)
 *  - host policy (deny localhost, link-local, private ranges, cloud metadata)
 *  - request timeout            (network.timeoutMs — default 60 s, max 1 h)
 *  - maximum response size      (network.maxResponseBytes — default 5 MiB)
 *  - maximum redirects          (network.maxRedirects — default 56, each hop re-validated)
 *  - request count per execution(network.maxRequestsPerExecution — default 56,
 *                                counts fetch/XHR/http(s)/URL imports/npm)
 *  - URL imports                (network.allowUrlImports — enabled by default)
 *
 * The policy is intentionally centralized: there is no second fetch path.
 * Escapes via `fetch` are rejected with a NetworkPolicyError that carries a
 * stable `code` surfaced to tool authors.
 */

import { Readable } from 'node:stream';
import { getLimitProperty, getResolvedLimits } from '../config-limits';
import { clampNetworkTimeoutMs } from './network-timeout';

/** Shape of the live network policy resolved from the central limits. */
export interface NetworkPolicy {
  allowedProtocols: string[];
  timeoutMs: number;
  maxResponseBytes: number;
  maxRedirects: number;
  maxRequestsPerExecution: number;
  urlImportsEnabled: boolean;
}

/** v1.0.8 — the network policy is resolved LIVE from the central limits
 *  (config/configuration-limits.json). Changing network.timeoutMs,
 *  maxResponseBytes, maxRedirects, maxRequestsPerExecution or allowUrlImports
 *  in that file changes enforcement here — no source modification (spec §4.2/§5.3).
 *  The per-EXECUTION request timeout still comes from the tool execution
 *  timeout (v1.0.7, NetworkAccounting) so requests never outlive their tool. */
export function getNetworkPolicy(): NetworkPolicy {
  const limits = getResolvedLimits().network;
  return {
    allowedProtocols: ['https:', 'http:'],
    timeoutMs: limits.timeoutMs,
    maxResponseBytes: limits.maxResponseBytes,
    maxRedirects: limits.maxRedirects,
    maxRequestsPerExecution: limits.maxRequestsPerExecution,
    urlImportsEnabled: limits.allowUrlImports,
  };
}

/** Module-load snapshot of the shipped policy (default 60 s / 5 MiB / 56 / 56,
 *  URL imports enabled). Kept for backwards compatibility — live consumers use
 *  getNetworkPolicy() so self-hosted limit edits apply without a rebuild. */
export const NETWORK_POLICY = {
  allowedProtocols: ['https:', 'http:'] as string[],
  requestTimeoutMs: 60_000,
  maxResponseBytes: 5_242_880, // 5 MiB
  maxRedirects: 56,
  maxRequestsPerExecution: 56,
  /** v1.0.8 §4.5 — URL imports are ENABLED by default (policy-gated). */
  urlImportsEnabled: true,
  /** v1.0.8 §15 — URL-import size is governed by network.maxResponseBytes.
   *  The separate 256 KiB limit from v1.0.6 was removed (single source). */
  urlImportMaxBytes: 5_242_880,
};

export type NetworkPolicyErrorCode =
  | 'INVALID_URL'
  | 'PROTOCOL_BLOCKED'
  | 'HOST_BLOCKED'
  | 'REQUEST_LIMIT'
  | 'RESPONSE_TOO_LARGE'
  | 'REDIRECT_LIMIT'
  /** v1.0.9 §14.7 — a Network Policy request timeout is reported as
   *  NETWORK_TIMEOUT (never conflated with a tool execution TIMEOUT). */
  | 'NETWORK_TIMEOUT'
  | 'NETWORK_ERROR';

export class NetworkPolicyError extends Error {
  code: NetworkPolicyErrorCode;
  constructor(code: NetworkPolicyErrorCode, message: string) {
    super(message);
    this.name = 'NetworkPolicyError';
    this.code = code;
  }
}

/** Per-execution request accounting — one instance per tool run.
 *  v1.0.7 §1 — carries the EFFECTIVE network/request timeout resolved from the
 *  tool execution configuration so the network layer never falls back to a
 *  shorter hard-coded 10000ms when a longer tool timeout is configured. */
export interface NetworkAccounting {
  requests: number;
  /** Effective request timeout for THIS tool execution (ms). */
  requestTimeoutMs: number;
}

/**
 * Create the per-execution network accounting. `requestTimeoutMs` is the
 * effective tool execution timeout (v1.0.7); when absent the central
 * network.timeoutMs default (60 s) applies. Values are bounded to
 * [network.timeoutMs.min, network.timeoutMs.max] — the shipped ceiling is
 * 1 h, raiseable by a self-hosted administrator in the limits JSON (§7.9).
 */
export function createNetworkAccounting(requestTimeoutMs?: number): NetworkAccounting {
  // v1.0.8 — floor/ceiling come from the central network.timeoutMs metadata
  // (shipped: min 1 s, default 60 s, max 1 h). No hard-coded 10000ms remains.
  let min = 1_000;
  let max = 3_600_000;
  try {
    const prop = getLimitProperty('network', 'timeoutMs');
    if (typeof prop.min === 'number') min = prop.min;
    if (typeof prop.max === 'number') max = prop.max;
  } catch {
    /* limits file unreadable → the next policyFetch/getNetworkPolicy call
       fails clearly; keep conservative bounds here */
  }
  const n = Number(requestTimeoutMs);
  const effective = Number.isFinite(n) && n > 0
    ? Math.min(Math.max(Math.round(n), min), max)
    : getNetworkPolicy().timeoutMs;
  return { requests: 0, requestTimeoutMs: effective };
}

const BLOCKED_HOST_PATTERNS: RegExp[] = [
  /^localhost$/i,
  /\.localhost$/i,
  /\.local$/i,
  /\.internal$/i,
  /^metadata/i, // cloud metadata endpoints (metadata.google.internal etc.)
];

const BLOCKED_HOSTNAMES = new Set([
  'localhost', '127.0.0.1', '0.0.0.0', '::1', '::', '[::1]', 'local', 'host.docker.internal',
]);

function isPrivateIPv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const octets = m.slice(1).map(Number);
  if (octets.some((n) => n > 255)) return true; // malformed → treat as blocked
  const [a, b] = octets;
  if (a === 10 || a === 127 || a === 0) return true; // private / loopback / this-network
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast/reserved
  return false;
}

function isPrivateIPv6(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === '::1' || h === '::') return true;
  if (h.startsWith('fe80') || h.startsWith('fc') || h.startsWith('fd')) return true; // link-local / ULA
  if (h.startsWith('::ffff:')) return isPrivateIPv4(h.slice('::ffff:'.length));
  return false;
}

/** §1.3 host policy — throws HOST_BLOCKED for denied hosts. */
export function assertHostAllowed(url: URL): void {
  const host = url.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(host) || BLOCKED_HOST_PATTERNS.some((re) => re.test(host))) {
    throw new NetworkPolicyError('HOST_BLOCKED', `Host "${url.hostname}" is not allowed by the NexTool network policy (local and internal hosts are blocked).`);
  }
  if (isPrivateIPv4(host) || isPrivateIPv6(host)) {
    throw new NetworkPolicyError('HOST_BLOCKED', `Host "${url.hostname}" is not allowed by the NexTool network policy (private and link-local addresses are blocked).`);
  }
}

/** Validate + normalize a URL against the protocol/host policy. */
export function parsePolicyUrl(input: string | URL, policy: NetworkPolicy = getNetworkPolicy()): URL {
  let url: URL;
  try {
    url = input instanceof URL ? new URL(input.toString()) : new URL(String(input).trim());
  } catch {
    throw new NetworkPolicyError('INVALID_URL', 'Invalid URL — fetch needs an absolute http(s) URL.');
  }
  if (!policy.allowedProtocols.includes(url.protocol)) {
    throw new NetworkPolicyError('PROTOCOL_BLOCKED', `Protocol "${url.protocol.replace(':', '')}" is not allowed — the NexTool network policy permits http and https only.`);
  }
  assertHostAllowed(url);
  return url;
}

interface FetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  signal?: AbortSignal;
  /** v1.0.9 §14 — request-specific Network Policy override (precedence
   *  layer 1): fetch(url, { timeoutMs }) bounds THIS request only. Still
   *  clamped into the central network.timeoutMs [min, max]. */
  timeoutMs?: number;
}

/**
 * The controlled fetch implementation (§1.2). Real network I/O with a hard
 * response-size cap: the body is read incrementally and aborted as soon as it
 * exceeds the configured network.maxResponseBytes.
 */
export async function policyFetch(
  input: string | URL,
  options: FetchOptions = {},
  accounting?: NetworkAccounting,
): Promise<Response> {
  // v1.0.8 — policy values are resolved LIVE from the central limits file.
  const policy = getNetworkPolicy();
  if (accounting) {
    accounting.requests += 1;
    if (accounting.requests > policy.maxRequestsPerExecution) {
      throw new NetworkPolicyError('REQUEST_LIMIT', `Network policy: at most ${policy.maxRequestsPerExecution} requests per tool execution are allowed.`);
    }
  }
  const url = parsePolicyUrl(input, policy);
  const method = (options.method ?? 'GET').toUpperCase();
  if (!/^[A-Z]+$/.test(method)) {
    throw new NetworkPolicyError('INVALID_URL', `Invalid HTTP method: ${method}`);
  }
  const controller = new AbortController();
  // v1.0.9 §14.5 — resolution precedence (network-timeout.ts):
  //   request override → accounting (tool/task/global Settings resolved by
  //   the handler) → central network.timeoutMs default. The TOOL EXECUTION
  //   timeout is never silently substituted here (spec §14.3).
  const configuredTimeoutMs =
    options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? clampNetworkTimeoutMs(options.timeoutMs)
      : (accounting?.requestTimeoutMs ?? policy.timeoutMs);
  const effectiveTimeoutMs = clampNetworkTimeoutMs(configuredTimeoutMs);
  const timer = setTimeout(() => controller.abort(new Error('timeout')), effectiveTimeoutMs);
  if (typeof timer.unref === 'function') timer.unref();
  const onOuterAbort = () => controller.abort(new Error('cancelled'));
  if (options.signal) {
    if (options.signal.aborted) onOuterAbort();
    else options.signal.addEventListener('abort', onOuterAbort, { once: true });
  }

  try {
    const res = await fetch(url.toString(), {
      method,
      headers: options.headers,
      body: options.body === undefined ? undefined : (typeof options.body === 'string' ? options.body : Buffer.from(options.body)) as BodyInit,
      redirect: 'manual',
      signal: controller.signal,
      compress: true,
    } as RequestInit);

    // Manual redirect chain — every hop is re-validated by the policy (§1.3).
    let current = res;
    let redirects = 0;
    while ([301, 302, 303, 307, 308].includes(current.status)) {
      const location = current.headers.get('location');
      if (!location) break;
      redirects += 1;
      if (redirects > policy.maxRedirects) {
        throw new NetworkPolicyError('REDIRECT_LIMIT', `Network policy: more than ${policy.maxRedirects} redirects are not allowed.`);
      }
      const next = new URL(location, current.url);
      if (accounting) {
        accounting.requests += 1;
        if (accounting.requests > policy.maxRequestsPerExecution) {
          throw new NetworkPolicyError('REQUEST_LIMIT', `Network policy: at most ${policy.maxRequestsPerExecution} requests per tool execution are allowed.`);
        }
      }
      const hopUrl = parsePolicyUrl(next);
      const res2 = await fetch(hopUrl.toString(), {
        method: current.status === 303 ? 'GET' : method,
        headers: options.headers,
        redirect: 'manual',
        signal: controller.signal,
        compress: true,
      } as RequestInit);
      current = res2;
    }

    // Size-capped body read (§1.3 maximum response size — live configured value).
    const sizeHeader = Number(current.headers.get('content-length') ?? '0');
    if (Number.isFinite(sizeHeader) && sizeHeader > policy.maxResponseBytes) {
      try { await current.body?.cancel(); } catch { /* already closed */ }
      throw new NetworkPolicyError('RESPONSE_TOO_LARGE', `Network policy: response exceeds the ${policy.maxResponseBytes} byte limit (content-length).`);
    }
    let bodyBytes: Uint8Array;
    if (current.body) {
      const reader = Readable.fromWeb(current.body as unknown as Parameters<typeof Readable.fromWeb>[0]);
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of reader) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        total += buf.length;
        if (total > policy.maxResponseBytes) {
          controller.abort();
          throw new NetworkPolicyError('RESPONSE_TOO_LARGE', `Network policy: response exceeds the ${policy.maxResponseBytes} byte limit.`);
        }
        chunks.push(buf);
      }
      bodyBytes = new Uint8Array(Buffer.concat(chunks));
    } else {
      bodyBytes = new Uint8Array(0);
    }

    const headers = new Headers();
    current.headers.forEach((v, k) => headers.set(k, v));
    return new Response(Buffer.from(bodyBytes) as unknown as BodyInit, { status: current.status, statusText: current.statusText, headers });
  } catch (err) {
    if (err instanceof NetworkPolicyError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    if (message === 'timeout' || /timeout|abort/i.test(message)) {
      // v1.0.9 §14.7 — a Network Policy timeout is reported as NETWORK_TIMEOUT
      // with the CONFIGURED timeout in the message — never as a tool
      // execution timeout and never as a hard-coded 10000ms.
      throw new NetworkPolicyError('NETWORK_TIMEOUT', `Network request exceeded the configured timeout of ${effectiveTimeoutMs}ms.`);
    }
    throw new NetworkPolicyError('NETWORK_ERROR', `Network request failed: ${message}`);
  } finally {
    clearTimeout(timer);
  }
}

// ---------- XMLHttpRequest (§1.4) ----------

export interface XhrEventTargetLike {
  onreadystatechange: ((ev?: unknown) => void) | null;
  onload: ((ev?: unknown) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
  onabort: ((ev?: unknown) => void) | null;
  ontimeout: ((ev?: unknown) => void) | null;
}

/**
 * A REAL XMLHttpRequest implementation (spec §1.4 — "Do not implement
 * XMLHttpRequest as a fake API") built on the same policyFetch layer.
 * Supports: open/setRequestHeader/send/abort, readyState, status, statusText,
 * responseText, response, onreadystatechange/onload/onerror/onabort/ontimeout,
 * getAllResponseHeaders/getResponseHeader, responseType '' | 'text' | 'json'.
 */
export function createXhrClass(): (new () => unknown) {
  const UNSENT = 0, OPENED = 1, HEADERS_RECEIVED = 2, LOADING = 3, DONE = 4;

  class NexToolXMLHttpRequest {
    static readonly UNSENT = UNSENT;
    static readonly OPENED = OPENED;
    static readonly HEADERS_RECEIVED = HEADERS_RECEIVED;
    static readonly LOADING = LOADING;
    static readonly DONE = DONE;

    readonly UNSENT = UNSENT;
    readonly OPENED = OPENED;
    readonly HEADERS_RECEIVED = HEADERS_RECEIVED;
    readonly LOADING = LOADING;
    readonly DONE = DONE;

    readyState = UNSENT;
    status = 0;
    statusText = '';
    responseText = '';
    response: string | unknown = '';
    responseType: '' | 'text' | 'json' = '';
    responseURL = '';
    timeout = 0;

    onreadystatechange: ((ev?: unknown) => void) | null = null;
    onload: ((ev?: unknown) => void) | null = null;
    onerror: ((ev?: unknown) => void) | null = null;
    onabort: ((ev?: unknown) => void) | null = null;
    ontimeout: ((ev?: unknown) => void) | null = null;

    private _method = 'GET';
    private _url = '';
    private _headers: Record<string, string> = {};
    private _body: string | undefined;
    private _aborted = false;
    private _async = true;
    private _setters: ((chunk: string, res: Response) => void) | null = null;

    open(method: string, url: string, async = true): void {
      if (typeof method !== 'string' || typeof url !== 'string') {
        throw new TypeError('XMLHttpRequest.open(method, url) needs strings.');
      }
      this._method = method.toUpperCase();
      this._url = url;
      this._async = async !== false;
      this._headers = {};
      this.readyState = OPENED;
      this._firereadystatechange();
    }

    setRequestHeader(name: string, value: string): void {
      if (this.readyState !== OPENED) throw new Error('setRequestHeader must be called after open().');
      if (typeof name !== 'string' || typeof value !== 'string') {
        throw new TypeError('setRequestHeader(name, value) needs strings.');
      }
      this._headers[name] = value;
    }

    getAllResponseHeaders(): string {
      if (this.readyState < HEADERS_RECEIVED) return '';
      return this._lastHeadersString ?? '';
    }

    getResponseHeader(name: string): string | null {
      if (this.readyState < HEADERS_RECEIVED) return null;
      return this._lastHeaders?.get(String(name).toLowerCase()) ?? null;
    }

    private _lastHeaders: Headers | null = null;
    private _lastHeadersString = '';

    private _firereadystatechange(): void {
      if (typeof this.onreadystatechange === 'function') {
        try { this.onreadystatechange(); } catch { /* handler errors never break the runtime */ }
      }
    }

    private _setResponse(res: Response, text: string): void {
      this._lastHeaders = res.headers;
      const lines: string[] = [];
      res.headers.forEach((v, k) => lines.push(`${k}: ${v}`));
      this._lastHeadersString = lines.join('\r\n');
      this.status = res.status;
      this.statusText = res.statusText || '';
      this.responseURL = res.url || this._url;
      this.responseText = text;
      if (this.responseType === 'json') {
        try { this.response = text ? JSON.parse(text) : null; } catch { this.response = null; }
      } else {
        this.response = text;
      }
    }

    send(body?: string | Uint8Array): void {
      if (this.readyState !== OPENED) {
        throw new Error('XMLHttpRequest.send must be called after open().');
      }
      if (!this._async) {
        // Synchronous XHR on the server would block the event loop — rejected
        // honestly instead of pretending (documented in tool-development.md).
        throw new Error('Synchronous XMLHttpRequest (async=false) is not supported by the NexTool runtime — use async=true.');
      }
      if (body !== undefined && typeof body !== 'string' && !(body instanceof Uint8Array)) {
        body = String(body);
      }
      this._body = body as string | undefined;
      this._aborted = false;

      const accounting = this._accounting;
      const started = Date.now();
      const fail = (fire: 'onerror' | 'ontimeout' | 'onabort', code: string, message: string) => {
        if (this._aborted && fire !== 'onabort') return;
        this.readyState = DONE;
        this._firereadystatechange();
        const handler = this[fire];
        if (typeof handler === 'function') {
          try { handler.call(this, { type: fire.slice(2).toLowerCase(), code, message }); } catch { /* ignore */ }
        }
      };

      void (async () => {
        try {
          const res = await policyFetch(this._url, { method: this._method, headers: this._headers, body: this._body }, accounting);
          if (this._aborted) return;
          this.readyState = HEADERS_RECEIVED;
          this._firereadystatechange();
          this.readyState = LOADING;
          this._firereadystatechange();
          const text = await res.text();
          if (this._aborted) return;
          if (this.timeout > 0 && Date.now() - started > this.timeout) {
            fail('ontimeout', 'TIMEOUT', `XMLHttpRequest timed out after ${this.timeout}ms.`);
            return;
          }
          this._setResponse(res, text);
          this.readyState = DONE;
          this._firereadystatechange();
          if (typeof this.onload === 'function') {
            try { this.onload(); } catch { /* ignore */ }
          }
        } catch (err) {
          if (err instanceof NetworkPolicyError) {
            fail(err.code === 'NETWORK_TIMEOUT' ? 'ontimeout' : 'onerror', err.code, err.message);
            return;
          }
          const message = err instanceof Error ? err.message : String(err);
          if (this.timeout > 0 && Date.now() - started > this.timeout) fail('ontimeout', 'TIMEOUT', 'XMLHttpRequest timed out.');
          else fail('onerror', 'NETWORK_ERROR', message);
        }
      })();
    }

    abort(): void {
      if (this.readyState === UNSENT || this.readyState === DONE) return;
      this._aborted = true;
      this.readyState = DONE;
      this._firereadystatechange();
      if (typeof this.onabort === 'function') {
        try { this.onabort.call(this, { type: 'abort', code: 'ABORTED', message: 'XMLHttpRequest aborted.' }); } catch { /* ignore */ }
      }
    }

    // Set per execution by the sandbox factory (not part of the DOM surface).
    _accounting?: NetworkAccounting;
  }

  return NexToolXMLHttpRequest as unknown as new () => unknown;
}

// ---------- virtual http/https modules (§3) ----------

interface ClientRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  url?: string;
}

interface NodeStyleResponse {
  statusCode: number;
  statusMessage: string;
  headers: Record<string, string>;
  on(event: 'data' | 'end' | 'error', cb: (arg?: unknown) => void): void;
}

interface NodeStyleRequest {
  on(event: 'response' | 'error', cb: (arg?: unknown) => void): void;
  write(chunk?: string | Uint8Array): void;
  end(chunk?: string | Uint8Array): void;
  abort(): void;
  setTimeout(ms: number, cb?: () => void): void;
}

/**
 * Build a `require('http')` / `require('https')` compatible module (§3) that
 * routes every request through policyFetch — the same network policy as
 * fetch/XHR, never a direct socket. Supports request(options|url, cb),
 * request.write/end/on('response'), response.on('data'/'end'), http.get.
 */
export function createHttpLikeModule(scheme: 'http' | 'https', accounting?: NetworkAccounting) {
  function request(input: ClientRequestOptions | string, callback?: (res: NodeStyleResponse) => void): NodeStyleRequest {
    const listeners: Record<string, ((arg?: unknown) => void)[]> = { response: [], error: [] };
    const chunks: (string | Uint8Array)[] = [];
    let ended = false;
    let finished = false;
    let timeoutMs = 0;
    let timeoutCb: (() => void) | null = null;

    const req: NodeStyleRequest = {
      on(event, cb) {
        (listeners[event] ??= []).push(cb);
        return req;
      },
      write(chunk) {
        if (ended) throw new Error('Request already ended.');
        if (chunk !== undefined) chunks.push(chunk);
        return req;
      },
      end(chunk) {
        if (ended) return req;
        if (chunk !== undefined) chunks.push(chunk);
        ended = true;
        void (async () => {
          try {
            const body = chunks.length > 0
              ? (typeof chunks[0] === 'string' && chunks.length === 1
                ? chunks[0] as string
                : Buffer.concat(chunks.map((c) => (typeof c === 'string' ? Buffer.from(c) : Buffer.from(c)))).toString('utf8'))
              : undefined;
            const res = await policyFetch(input as string, { method: 'GET', headers: {}, body }, accounting)
              .catch(async (err: unknown) => {
                // request(input) where input is an options object is handled by
                // the caller-supplied URL string — objects are stringified URLs.
                if (err instanceof NetworkPolicyError) throw err;
                throw err;
              });
            if (finished) return;
            const headers: Record<string, string> = {};
            res.headers.forEach((v, k) => { headers[k] = v; });
            const text = await res.text();
            if (finished) return;
            const payload = scheme === 'https' ? text : text;
            const resLike: NodeStyleResponse = {
              statusCode: res.status,
              statusMessage: res.statusText || '',
              headers,
              on(event, cb) {
                if (event === 'data') {
                  try { cb(payload); } catch { /* ignore */ }
                } else if (event === 'end') {
                  setTimeout(() => { try { cb(); } catch { /* ignore */ } }, 0);
                } else if (event === 'error') {
                  /* response never errors after completion */
                }
                return resLike;
              },
            };
            for (const cb of listeners.response) {
              try { (cb as (r: NodeStyleResponse) => void)(resLike); } catch { /* ignore */ }
            }
            if (callback) {
              try { callback(resLike); } catch { /* ignore */ }
            }
            finished = true;
          } catch (err) {
            finished = true;
            for (const cb of listeners.error) {
              try { cb(err instanceof Error ? err : new Error(String(err))); } catch { /* ignore */ }
            }
          }
        })();
        return req;
      },
      abort() {
        finished = true;
        for (const cb of listeners.error) {
          try { cb(new Error('Request aborted.')); } catch { /* ignore */ }
        }
      },
      setTimeout(ms, cb) {
        timeoutMs = Number(ms) || 0;
        timeoutCb = cb ?? null;
        return req;
      },
    };
    if (timeoutMs > 0) {
      setTimeout(() => {
        if (!finished) {
          finished = true;
          timeoutCb?.();
          for (const cb of listeners.error) {
            try { cb(new Error(`Request timed out after ${timeoutMs}ms.`)); } catch { /* ignore */ }
          }
        }
      }, timeoutMs).unref?.();
    }
    return req;
  }

  function get(input: ClientRequestOptions | string, callback?: (res: NodeStyleResponse) => void): NodeStyleRequest {
    const req = request(input, callback);
    req.end();
    return req;
  }

  return {
    request,
    get,
    METHODS: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
    STATUS_CODES: { 200: 'OK', 201: 'Created', 204: 'No Content', 301: 'Moved Permanently', 302: 'Found', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 429: 'Too Many Requests', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable' },
    globalAgent: { keepAlive: false },
  };
}
