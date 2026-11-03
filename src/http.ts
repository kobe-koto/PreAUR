/** Thrown for non-2xx responses; the message matches the one axios used. */
export class HttpError extends Error {
    constructor(readonly status: number, readonly url: string) {
        super(`Request failed with status code ${status}`);
        this.name = 'HttpError';
    }
}

export type QueryParams = Record<string, unknown>;

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
