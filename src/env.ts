export type EnvPair = readonly [key: string, value: string];
export type EnvPairs = readonly EnvPair[];

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function assertEnvKey(key: string): void {
    if (!ENV_KEY_RE.test(key)) {
        throw new Error(`Invalid environment variable name: ${key}`);
    }
}

export function mergeEnvPairs(...groups: Array<EnvPairs | undefined>): EnvPair[] {
    const merged = new Map<string, string>();

    for (const group of groups) {
        for (const [key, value] of group ?? []) {
            assertEnvKey(key);
            merged.set(key, value);
        }
    }

    return [...merged.entries()];
}

export function filterEnvPairs(pairs: EnvPairs, ignoredKeys: ReadonlySet<string>): EnvPair[] {
    return pairs.filter(([key]) => !ignoredKeys.has(key));
}

export function envPairsToRecord(pairs: EnvPairs): Record<string, string> {
    return Object.fromEntries(mergeEnvPairs(pairs));
}

export function envValue(pairs: EnvPairs | undefined, key: string): string | undefined {
    if (!pairs) return undefined;

    for (let i = pairs.length - 1; i >= 0; i -= 1) {
        const pair = pairs[i];
        if (pair?.[0] === key) return pair[1];
    }

    return undefined;
}

export function envAssignments(pairs: EnvPairs | undefined): string[] {
    return mergeEnvPairs(pairs).map(([key, value]) => `${key}=${value}`);
}

export function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function shellEnvPrefix(pairs: EnvPairs | undefined): string {
    const assignments = envAssignments(pairs);
    return assignments.length > 0
        ? `env ${assignments.map(shellQuote).join(' ')} `
        : '';
}

export function shellEnvCommand(command: string, pairs: EnvPairs | undefined): string {
    return `${shellEnvPrefix(pairs)}${command}`;
}
