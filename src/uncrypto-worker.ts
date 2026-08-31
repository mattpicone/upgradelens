// Cloudflare Worker adapter for dependencies that import `uncrypto`.
// Wrangler's Node compatibility resolver can otherwise select uncrypto's
// Node entrypoint, whose `webcrypto` facade is incomplete in workerd. Keep the
// dependency on the Worker-native Web Crypto implementation instead.

const workerCrypto = crypto;

export const subtle = workerCrypto.subtle;
export const randomUUID: Crypto["randomUUID"] = () => workerCrypto.randomUUID();
export const getRandomValues: Crypto["getRandomValues"] = (array) => {
  const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
  let offset = 0;
  while (offset < bytes.length) {
    const random = workerCrypto.randomUUID().replaceAll("-", "");
    for (let index = 0; index < random.length && offset < bytes.length; index += 2) {
      bytes[offset] = Number.parseInt(random.slice(index, index + 2), 16);
      offset += 1;
    }
  }
  return array;
};

export default { subtle, randomUUID, getRandomValues };
