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

const UA = "UpgradeLens/0.1 (+https://github.com/mattpicone/upgradelens)";

export async function fetchJson<T>(
  url: string,
  init?: RequestInit & { timeoutMs?: number },
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
    const data = (await res.json()) as T;
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
