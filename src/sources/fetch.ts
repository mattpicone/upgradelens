// Shared upstream fetch helper: timeout, JSON parsing, error normalization.
// Upstream content is treated strictly as DATA — it is never interpreted as
// instructions and is only surfaced as normalized facts with provenance.

export interface SourceResult<T> {
  ok: boolean;
  data: T | null;
  status: number;
  url: string;
  fetched_at: string;
  error?: string;
}

const UA = "UpgradeLens/0.2 (+https://github.com/mattpicone/upgradelens)";
const DEFAULT_MAX_RESPONSE_BYTES = 1536 * 1024;

async function readBoundedJson<T>(res: Response, maxBytes: number): Promise<T> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`upstream response exceeds ${maxBytes} bytes`);
  }
  if (!res.body) throw new Error("upstream response has no body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel("upstream response too large");
      throw new Error(`upstream response exceeds ${maxBytes} bytes`);
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return JSON.parse(text) as T;
}

export async function fetchJson<T>(
  url: string,
  init?: RequestInit & { timeoutMs?: number; maxResponseBytes?: number },
): Promise<SourceResult<T>> {
  const fetched_at = new Date().toISOString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init?.timeoutMs ?? 6000);
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        accept: "application/json",
        "user-agent": UA,
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      return {
        ok: false,
        data: null,
        status: res.status,
        url,
        fetched_at,
        error: `HTTP ${res.status}`,
      };
    }
    const data = await readBoundedJson<T>(res, init?.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES);
    return { ok: true, data, status: res.status, url, fetched_at };
  } catch (e) {
    return {
      ok: false,
      data: null,
      status: 0,
      url,
      fetched_at,
      error: e instanceof Error ? e.message : String(e),
    };
  } finally {
    clearTimeout(timer);
  }
}
