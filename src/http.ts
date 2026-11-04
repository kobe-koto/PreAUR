/** Thrown for non-2xx responses; the message matches the one axios used. */
export class HttpError extends Error {
    constructor(readonly status: number, readonly url: string) {
        super(`Request failed with status code ${status}`);
        this.name = 'HttpError';
    }
}

export type QueryParams = Record<string, unknown>;

const PLACEHOLDER_PATTERN = /\{\{\s*([^{}]*?)\s*\}\}/g;
const RANDOM_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
export const RANDOM_PLACEHOLDER_MAX = 256;

function randomString(length: number): string {
    // 248 = 62 * 4; rejecting larger bytes keeps every character equally likely.
    let out = '';
    while (out.length < length) {
        for (const byte of crypto.getRandomValues(new Uint8Array(length))) {
            if (byte < 248 && out.length < length) out += RANDOM_ALPHABET[byte % RANDOM_ALPHABET.length];
        }
    }
    return out;
}

/** Returns the replacement for one placeholder body, or null when it is not supported. */
function resolvePlaceholder(body: string): (() => string) | null {
    if (body === 'timestamp') return () => String(Date.now());
    const random = /^random=(\d+)$/.exec(body);
    if (random) {
        const length = Number(random[1]);
        if (length >= 1 && length <= RANDOM_PLACEHOLDER_MAX) return () => randomString(length);
    }
    return null;
}

/** Returns the first unsupported placeholder in the text, or null when all are valid. */
export function findInvalidPlaceholder(text: string): string | null {
    for (const match of text.matchAll(PLACEHOLDER_PATTERN)) {
        if (!resolvePlaceholder(match[1] ?? '')) return match[0];
    }
    return null;
}

/**
 * Replaces {{timestamp}} (milliseconds) and {{random=N}} (N characters of
 * [A-Za-z0-9]) in string values; each occurrence is generated anew.
 */
export function renderParamPlaceholders(params: QueryParams | undefined): QueryParams | undefined {
    if (!params) return params;
    const rendered: QueryParams = {};
    for (const [key, value] of Object.entries(params)) {
        rendered[key] = typeof value !== 'string' ? value : value.replace(PLACEHOLDER_PATTERN, (whole, body: string) => {
            const resolve = resolvePlaceholder(body);
            if (!resolve) throw new Error(`Unsupported placeholder ${whole} in param "${key}"`);
            return resolve();
        });
    }
    return rendered;
}

export interface RequestOptions {
    headers?: Record<string, string>;
    params?: QueryParams;
    /** Milliseconds; no timeout when omitted. */
    timeout?: number;
}

/**
 * Append params to the URL. Arrays become repeated `key[]` entries, objects
 * are JSON-encoded, and null/undefined values are dropped.
 */
export function withQuery(url: string, params: QueryParams | undefined): string {
    if (!params) return url;
    const search = new URLSearchParams();
    const append = (key: string, value: unknown) => {
        if (value === undefined || value === null) return;
        search.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    };
    for (const [key, value] of Object.entries(params)) {
        if (Array.isArray(value)) {
            for (const item of value) append(`${key}[]`, item);
        } else {
            append(key, value);
        }
    }
    const query = search.toString();
    if (!query) return url;
    return `${url}${url.includes('?') ? '&' : '?'}${query}`;
}

async function request(method: string, url: string, options: RequestOptions = {}, body?: string): Promise<Response> {
    const target = withQuery(url, options.params);
    const response = await fetch(target, {
        method,
        headers: options.headers,
        body,
        signal: options.timeout ? AbortSignal.timeout(options.timeout) : undefined,
    });
    if (!response.ok) {
        // Release the connection; the body is not used.
        await response.body?.cancel().catch(() => {});
        throw new HttpError(response.status, target);
    }
    return response;
}

/**
 * HTTP helpers on top of fetch. Kept on one object so tests can spy on them.
 */
export const http = {
    async getJson<T = any>(url: string, options?: RequestOptions): Promise<T> {
        return (await request('GET', url, options)).json() as Promise<T>;
    },

    async getText(url: string, options?: RequestOptions): Promise<string> {
        return (await request('GET', url, options)).text();
    },

    async getBuffer(url: string, options?: RequestOptions): Promise<Buffer> {
        return Buffer.from(await (await request('GET', url, options)).arrayBuffer());
    },

    /** GET whose response body is ignored. */
    async get(url: string, options?: RequestOptions): Promise<void> {
        const response = await request('GET', url, options);
        await response.body?.cancel().catch(() => {});
    },

    /** POST a string as-is or any other value as JSON; the response body is ignored. */
    async post(url: string, data: unknown, options?: RequestOptions): Promise<void> {
        const body = typeof data === 'string' ? data : JSON.stringify(data);
        const response = await request('POST', url, options, body);
        await response.body?.cancel().catch(() => {});
    },
};
