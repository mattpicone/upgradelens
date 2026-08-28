import { MAX_BODY_BYTES } from "../validate";

export type JsonBodyResult =
  | { ok: true; data: unknown }
  | { ok: false; status: 400 | 413; code: "invalid_json" | "payload_too_large"; message: string };

// Content-Length is only a fast-path hint; the stream itself is counted so
// chunked requests and deliberately false/missing headers cannot bypass limits.
export async function readJsonBody(
  request: Request,
  maxBytes = MAX_BODY_BYTES,
): Promise<JsonBodyResult> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, status: 413, code: "payload_too_large", message: "Body exceeds 32KB." };
  }
  if (!request.body) {
    return { ok: false, status: 400, code: "invalid_json", message: "Request body must be valid JSON." };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("payload too large");
        return { ok: false, status: 413, code: "payload_too_large", message: "Body exceeds 32KB." };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, status: 400, code: "invalid_json", message: "Request body could not be read." };
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { ok: true, data: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { ok: false, status: 400, code: "invalid_json", message: "Request body must be valid JSON." };
  }
}
