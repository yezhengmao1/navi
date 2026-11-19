import { CONFAB_CHUNK_BYTES, encodedLineBytes } from "./confab-limits.js";
import { ConfabHttpError } from "./confab-errors.js";

export type Credential = { backend: string; token: string; allowHttp?: boolean };

const failure = () => new Error("Confab request failed.");
const unsafe = /[\s\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
const text = (value: unknown, max = 4096): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max && !unsafe.test(value);
const object = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Accept an origin only; do not silently discard paths or URL credentials. */
export function normalizeBackend(value: string, allowHttp = false): string {
  try {
    if (!text(value) || !/^https?:\/\/[^/?#\\@]+\/?$/i.test(value)) throw failure();
    const url = new URL(value);
    const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
    if (url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:" && (loopback || allowHttp)))) throw failure();
    return url.origin;
  } catch { throw failure(); }
}

// Race even injected fetchers/readers against cancellation; never expose their errors.
async function bounded<T>(signal: AbortSignal, milliseconds: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  let rejectAbort: () => void = () => {};
  try {
    const cancelled = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(failure());
      controller.signal.addEventListener("abort", rejectAbort, { once: true });
      if (controller.signal.aborted) rejectAbort();
    });
    timer = setTimeout(abort, milliseconds);
    return await Promise.race([cancelled, Promise.resolve().then(() => {
      if (controller.signal.aborted) throw failure();
      return work(controller.signal);
    })]);
  } catch (error) { throw error instanceof ConfabHttpError ? error : failure(); }
  finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", rejectAbort);
    controller.abort();
  }
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(failure()); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

export class ConfabApi {
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  private async request(backend: string, path: string, signal: AbortSignal, body?: unknown, token?: string, method?: "PATCH") {
    return bounded(signal, 15_000, async inner => {
      const response = await this.fetcher(backend + path, {
        method: method ?? (body === undefined ? "GET" : "POST"), redirect: "error", credentials: "omit",
        signal: inner, headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (response.redirected || response.status >= 300 && response.status < 400) throw failure();
      if (response.status >= 400 && !(path === "/auth/device/token" && response.status === 400)) {
        void response.body?.cancel().catch(() => {});
        throw new ConfabHttpError(response.status);
      }
      const reader = response.body?.getReader();
      if (!reader) throw failure();
      const cancel = () => { void reader.cancel().catch(() => {}); };
      inner.addEventListener("abort", cancel, { once: true });
      try {
        let bytes = 0;
        let raw = "";
        const decoder = new TextDecoder("utf-8", { fatal: true });
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 256 * 1024) throw failure();
          raw += decoder.decode(value, { stream: true });
        }
        raw += decoder.decode();
        const data: unknown = JSON.parse(raw);
        if (!object(data)) throw failure();
        return { status: response.status, data };
      } finally { inner.removeEventListener("abort", cancel); cancel(); }
    });
  }

  async deviceLogin(backend: string, signal: AbortSignal, onVerification: (url: string, code: string) => void, allowHttp = false): Promise<Credential> {
    backend = normalizeBackend(backend, allowHttp);
    return bounded(signal, 15 * 60_000, async inner => {
      const { status, data } = await this.request(backend, "/auth/device/code", inner, { key_name: "Pi compatibility export" });
      if (status !== 200 || !text(data.device_code) || !text(data.user_code, 64) || !text(data.verification_uri) ||
          !Number.isSafeInteger(data.expires_in) || data.expires_in <= 0 || !Number.isSafeInteger(data.interval) || data.interval <= 0) throw failure();
      const link = new URL(data.verification_uri);
      if (link.origin !== backend || link.username || link.password || link.hash || /\\/.test(data.verification_uri) || unsafe.test(decodeURIComponent(data.verification_uri))) throw failure();
      return bounded(inner, Math.min(data.expires_in * 1000, 15 * 60_000), async polling => {
        onVerification(link.href, data.user_code);
        let interval = Math.min(data.interval, 900) * 1000;
        for (;;) {
          await delay(interval, polling);
          const result = await this.request(backend, "/auth/device/token", polling, { device_code: data.device_code });
          if (result.status === 200 && text(result.data.access_token) && result.data.token_type === "Bearer") {
            return { backend, token: result.data.access_token, ...(allowHttp ? { allowHttp: true } : {}) };
          }
          if (result.status === 400 && result.data.error === "authorization_pending") continue;
          if (result.status === 400 && result.data.error === "slow_down") { interval += 5000; continue; }
          throw failure();
        }
      });
    });
  }

  async validate(credential: Credential, signal: AbortSignal): Promise<void> {
    const backend = normalizeBackend(credential.backend, credential.allowHttp === true);
    if (!text(credential.token)) throw failure();
    const result = await this.request(backend, "/api/v1/auth/validate", signal, undefined, credential.token);
    if (result.status !== 200 || result.data.valid !== true) throw failure();
  }

  async sync(credential: Credential, snapshot: { externalId: string; lines: string[]; title?: string; updateTitle?: boolean }, signal: AbortSignal): Promise<void> {
    const backend = normalizeBackend(credential.backend, credential.allowHttp === true);
    if (!text(credential.token) || !text(snapshot.externalId, 256) || !Array.isArray(snapshot.lines) ||
        snapshot.lines.some(line => typeof line !== "string" || /[\r\n]/.test(line))) throw failure();
    // Copy before awaiting: a caller cannot mutate the snapshot during upload.
    const lines = [...snapshot.lines];
    const title = snapshot.title?.trim() || "Pi 会话";
    const updateTitle = snapshot.updateTitle === true;
    const fileName = "pi-transcript.jsonl";
    await bounded(signal, 5 * 60_000, async inner => {
      const init = await this.request(backend, "/api/v1/sync/init", inner, {
        provider: "claude-code", external_id: snapshot.externalId, transcript_path: fileName,
      }, credential.token);
      if (init.status !== 200 || !text(init.data.session_id) || !object(init.data.files)) throw failure();
      const state = init.data.files[fileName];
      let offset = Object.hasOwn(init.data.files, fileName) ? state?.last_synced_line : 0;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > lines.length) throw failure();
      while (offset < lines.length) {
        const chunk: string[] = [];
        let bytes = 0;
        while (offset + chunk.length < lines.length && chunk.length < 500) {
          const line = lines[offset + chunk.length];
          const size = encodedLineBytes(line);
          if (size > CONFAB_CHUNK_BYTES) throw failure();
          if (bytes + size > CONFAB_CHUNK_BYTES) break;
          bytes += size;
          chunk.push(line);
        }
        const end = offset + chunk.length;
        const ack = await this.request(backend, "/api/v1/sync/chunk", inner, {
          session_id: init.data.session_id, file_name: fileName, file_type: "transcript", first_line: offset + 1, lines: chunk,
          metadata: { summary: title },
        }, credential.token);
        if (ack.status !== 200 || ack.data.last_synced_line !== end) throw failure();
        offset = end;
      }
      if (updateTitle) {
        const result = await this.request(backend, `/api/v1/sessions/${encodeURIComponent(snapshot.externalId)}/summary`, inner,
          { summary: title }, credential.token, "PATCH");
        if (result.status !== 200) throw failure();
      }
    });
  }
}
