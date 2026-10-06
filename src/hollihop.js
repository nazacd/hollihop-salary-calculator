// Thin HolliHop API (v2) client with an in-memory response cache.

const CACHE_TTL_MS = 5 * 60 * 1000;
const PAGE_SIZE = 1000;

export class HolliHop {
  constructor({ baseUrl, authKey }) {
    if (!baseUrl || !authKey) {
      throw new Error('BASE_URL and AUTHKEY must be set (see .env.example)');
    }
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.authKey = authKey;
    this.cache = new Map();
  }

  clearCache() {
    this.cache.clear();
  }

  async call(method, params = {}, { fresh = false } = {}) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    }
    const key = `${method}?${qs}`;
    const hit = this.cache.get(key);
    if (!fresh && hit && hit.expires > Date.now()) return hit.promise;

    qs.set('authkey', this.authKey);
    const promise = (async () => {
      const res = await this.fetchWithRetry(`${this.baseUrl}/${method}?${qs}`);
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`HolliHop ${method} failed: HTTP ${res.status} ${text.slice(0, 200)}`);
      }
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`HolliHop ${method} returned non-JSON: ${text.slice(0, 200)}`);
      }
    })();
    this.cache.set(key, { promise, expires: Date.now() + CACHE_TTL_MS });
    promise.catch(() => this.cache.delete(key));
    return promise;
  }

  // One retry for transient network failures; persistent ones become a readable error.
  async fetchWithRetry(url) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fetch(url, { signal: AbortSignal.timeout(60_000) });
      } catch (err) {
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 1500));
          continue;
        }
        throw networkError(err, new URL(url).host);
      }
    }
  }

  // Fetches every page of a list endpoint and returns the concatenated array.
  async list(method, field, params = {}, opts = {}) {
    const out = [];
    for (let skip = 0; ; skip += PAGE_SIZE) {
      const data = await this.call(method, { ...params, take: PAGE_SIZE, skip }, opts);
      const items = data?.[field] ?? [];
      out.push(...items);
      if (items.length < PAGE_SIZE) return { items: out, raw: data };
    }
  }

  async teachers(opts) {
    const { items } = await this.list('GetTeachers', 'Teachers', {}, opts);
    return items;
  }

  // Ed units (groups / individual lessons) with their lesson days in the range.
  // With teacherId, HolliHop only returns the days that teacher taught.
  async edUnits(params, opts) {
    const { items, raw } = await this.list('GetEdUnits', 'EdUnits', { queryDays: true, ...params }, opts);
    return { units: items, now: raw?.Now };
  }

  async edUnitStudents(params, opts) {
    const { items } = await this.list('GetEdUnitStudents', 'EdUnitStudents', { queryDays: true, ...params }, opts);
    return items;
  }
}

const NETWORK_HINTS = {
  EHOSTUNREACH: 'there is no network route to it. Check your internet connection, VPN or firewall',
  ENETUNREACH: 'there is no network route to it. Check your internet connection, VPN or firewall',
  ECONNREFUSED: 'the connection was refused. Check BASE_URL in .env',
  ECONNRESET: 'the connection was reset. Check your internet connection, VPN or firewall',
  ENOTFOUND: 'the host name could not be resolved. Check BASE_URL in .env and your DNS',
  EAI_AGAIN: 'DNS lookup failed. Check your internet connection',
  ETIMEDOUT: 'the connection timed out. Check your internet connection, VPN or firewall',
  UND_ERR_CONNECT_TIMEOUT: 'the connection timed out. Check your internet connection, VPN or firewall',
  CERT_HAS_EXPIRED: 'its TLS certificate is invalid',
};

function networkError(err, host) {
  if (err.name === 'TimeoutError') {
    return new Error(`HolliHop (${host}) did not answer within 60 seconds. Try again or check your connection.`);
  }
  const cause = err.cause ?? err;
  const code = cause.code;
  const where = cause.address ? `${host} (${cause.address})` : host;
  const hint = NETWORK_HINTS[code] ?? cause.message ?? err.message;
  return Object.assign(new Error(`Can't reach HolliHop at ${where}: ${hint}.${code ? ` [${code}]` : ''}`), { status: 503, cause: err });
}
