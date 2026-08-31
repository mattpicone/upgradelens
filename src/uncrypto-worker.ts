// Cloudflare Worker adapter for dependencies that import `uncrypto`.
// Wrangler's Node compatibility resolver can otherwise select uncrypto's
// Node entrypoint, whose `webcrypto` facade is incomplete in workerd. Keep the
// dependency on the Worker-native Web Crypto implementation instead.

const workerCrypto = crypto;

export const subtle = workerCrypto.subtle;
export const randomUUID: Crypto["randomUUID"] = () => workerCrypto.randomUUID();
export const getRandomValues: Crypto["getRandomValues"] = (array) =>
  workerCrypto.getRandomValues(array);

export default { subtle, randomUUID, getRandomValues };
