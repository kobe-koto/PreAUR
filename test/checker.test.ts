import { test, expect, describe } from 'bun:test';

import { applyVersionTemplate } from '../src/checker';

describe('applyVersionTemplate', () => {
    // The spotify-style template from preaur.config.yaml.example: the same
    // `{~pkgver}` placeholder repeated spans a contiguous range of the version.
    test('merges repeated ~pkgver placeholders into one contiguous field', () => {
        const result = applyVersionTemplate(
            '{~pkgver}.{~pkgver}.{~pkgver}.{~pkgver}.{_commit}',
            '1.2.3.4.abcdef'
        );
        expect(result).toEqual({ pkgver: '1.2.3.4', _commit: 'abcdef' });
    });

    test('captures a custom variable alongside pkgver', () => {
        const result = applyVersionTemplate('{~pkgver}-{_build}', '1.0-r5');
        expect(result).toEqual({ pkgver: '1.0', _build: 'r5' });
    });

    test('returns null when the version does not match the template', () => {
        expect(applyVersionTemplate('{~pkgver}.{_commit}', 'no-dot-here')).toBeNull();
    });
});

import { afterEach, spyOn } from 'bun:test';
import { http } from '../src/http';
import { gzipSync } from 'node:zlib';
import { DebProvider, GitHubProvider, selectLatestCandidate, transformGitHubTag } from '../src/checker';
import type { PreaurGitHubChecker, PreaurDebChecker } from '../src/config';

const gh = (extra: Partial<PreaurGitHubChecker> = {}): PreaurGitHubChecker => ({
    type: 'github',
    repo: 'owner/name',
    ...extra,
} as PreaurGitHubChecker);

describe('transformGitHubTag', () => {
    test('strips a default leading v when no prefix is configured', () => {
        expect(transformGitHubTag(gh(), 'v1.2.3')).toBe('1.2.3');
    });

    test('filters out tags without the configured prefix', () => {
        expect(transformGitHubTag(gh({ prefix: 'app-release-' }), 'app-release-1.2.3')).toBe('1.2.3');
        expect(transformGitHubTag(gh({ prefix: 'app-release-' }), 'cli-release-9.9.9')).toBeNull();
    });

    test('filters out tags without the configured suffix', () => {
        expect(transformGitHubTag(gh({ suffix: '_beta' }), 'v2.0_beta')).toBe('2.0');
        expect(transformGitHubTag(gh({ suffix: '_beta' }), 'v2.0')).toBeNull();
    });

    test('filters out tags that do not match the template', () => {
        const config = gh({ template: '{~pkgver}.{_build}' });
        expect(transformGitHubTag(config, 'v1.2')).toBe('1.2');
        expect(transformGitHubTag(config, 'v1')).toBeNull();
    });
});

describe('selectLatestCandidate', () => {
    const deb = (extra: Partial<PreaurDebChecker> = {}): PreaurDebChecker => ({
        type: 'deb', url: 'https://x', pkg: 'p', dist: 'stable', component: 'main', ...extra,
    } as PreaurDebChecker);

    test('picks the newest version without filters', () => {
        expect(selectLatestCandidate(deb(), [
            { version: '1.2.0' }, { version: '1.10.0' }, { version: '1.9.9' },
        ])).toEqual({ version: '1.10.0', epoch: undefined });
    });

    test('ignores newer versions that do not match the template', () => {
        expect(selectLatestCandidate(deb({ template: '{~pkgver}.{_commit}' }), [
            { version: '2' }, { version: '1.abc' },
        ])).toEqual({ version: '1.abc', epoch: undefined });
    });

    test('matches the template against the strip_version result', () => {
        expect(selectLatestCandidate(deb({ strip_version: true, template: '{~pkgver}.{~pkgver}' }), [
            { version: '1.5_100' }, { version: '2_200' },
        ])).toEqual({ version: '1.5', epoch: undefined });
    });

    test('returns null when nothing matches', () => {
        expect(selectLatestCandidate(deb({ template: 'x{~pkgver}' }), [{ version: '1.0' }])).toBeNull();
    });
});

describe('GitHubProvider filtering', () => {
    let getSpy: ReturnType<typeof spyOn> | undefined;

    afterEach(() => {
        getSpy?.mockRestore();
        getSpy = undefined;
    });

    test('uses releases/latest when no filters are configured', async () => {
        getSpy = spyOn(http, 'getJson').mockResolvedValue({ tag_name: 'v3.1.0' });
        expect(await new GitHubProvider().check(gh())).toEqual({ version: '3.1.0' });
        expect(String(getSpy.mock.calls[0]?.[0])).toEndWith('/releases/latest');
    });

    test('walks releases and returns the newest matching stable release', async () => {
        getSpy = spyOn(http, 'getJson').mockResolvedValue([
            { tag_name: 'cli-v9.0.0', prerelease: false },
            { tag_name: 'app-v2.0.0', prerelease: true },
            { tag_name: 'app-v1.5.0', prerelease: false, draft: true },
            { tag_name: 'app-v1.4.0', prerelease: false },
        ]);

        expect(await new GitHubProvider().check(gh({ prefix: 'app-v' }))).toEqual({ version: '1.4.0' });
        expect(String(getSpy.mock.calls[0]?.[0])).toEndWith('/releases');
    });

    test('includes prereleases when use is prerelease', async () => {
        getSpy = spyOn(http, 'getJson').mockResolvedValue([
            { tag_name: 'cli-v9.0.0', prerelease: true },
            { tag_name: 'app-v2.0.0', prerelease: true },
        ]);

        expect(await new GitHubProvider().check(gh({ prefix: 'app-v', use: 'prerelease' }))).toEqual({ version: '2.0.0' });
    });

    test('fails clearly when no release matches', async () => {
        getSpy = spyOn(http, 'getJson').mockResolvedValue([{ tag_name: 'cli-v1.0.0' }]);
        await expect(new GitHubProvider().check(gh({ prefix: 'app-v' }))).rejects.toThrow(/No non-prerelease GitHub release matched prefix "app-v"/);
    });
});

describe('DebProvider over HTTP', () => {
    const packagesBody = 'Package: other\nVersion: 9.9\n\nPackage: demo\nVersion: 2:1.2-3\n';

    async function checkWith(serve: (pathname: string) => Response) {
        const server = Bun.serve({ port: 0, fetch: req => serve(new URL(req.url).pathname) });
        try {
            return await new DebProvider().check({
                type: 'deb',
                url: `http://localhost:${server.port}/debian/`,
                pkg: 'demo',
                dist: 'stable',
                component: 'main',
            });
        } finally {
            server.stop(true);
        }
    }

    test('reads the plain Packages list', async () => {
        const result = await checkWith(pathname => pathname.endsWith('/Packages')
            ? new Response(packagesBody)
            : new Response('', { status: 500 }));
        expect(result).toEqual({ version: '1.2_3', epoch: '2' });
    });

    test('falls back to Packages.gz when Packages returns 404', async () => {
        const result = await checkWith(pathname => pathname.endsWith('/Packages.gz')
            ? new Response(gzipSync(packagesBody))
            : new Response('missing', { status: 404 }));
        expect(result).toEqual({ version: '1.2_3', epoch: '2' });
    });

    test('does not fall back on other HTTP errors', async () => {
        await expect(checkWith(() => new Response('', { status: 503 })))
            .rejects.toThrow(/Packages: Request failed with status code 503/);
    });
});

import { JsonProvider, selectJsonVersions } from '../src/checker';
import { renderParamPlaceholders } from '../src/http';
import { PreaurRawConfigSchema } from '../src/config_schema';
import type { PreaurJsonChecker } from '../src/config';

describe('renderParamPlaceholders', () => {
    test('fills {{timestamp}} and {{random=N}} and leaves other values alone', () => {
        const before = Date.now();
        const rendered = renderParamPlaceholders({ _: '{{timestamp}}', nonce: 'n-{{random=12}}', code: 'CL', n: 3 })!;
        const ts = Number(rendered._);
        expect(ts).toBeGreaterThanOrEqual(before);
        expect(ts).toBeLessThanOrEqual(Date.now());
        expect(rendered.nonce).toMatch(/^n-[A-Za-z0-9]{12}$/);
        expect(rendered.code).toBe('CL');
        expect(rendered.n).toBe(3);
    });

    test('generates a new random value on every call', () => {
        const a = renderParamPlaceholders({ r: '{{random=32}}' })!.r;
        const b = renderParamPlaceholders({ r: '{{random=32}}' })!.r;
        expect(a).not.toBe(b);
    });

    test('rejects unsupported placeholders', () => {
        expect(() => renderParamPlaceholders({ r: '{{random=0}}' })).toThrow(/Unsupported placeholder \{\{random=0\}\}/);
        expect(() => renderParamPlaceholders({ r: '{{uuid}}' })).toThrow(/Unsupported placeholder/);
    });
});

describe('selectJsonVersions', () => {
    const products = [{ releases: [
        { type: 'release', version: '2026.2.4' },
        { type: 'eap', version: '2026.3' },
        { type: 'release', version: '2026.2.4.1' },
        { type: 'release', version: null },
    ] }];

    test('supports filter expressions', () => {
        expect(selectJsonVersions(products, '$[0].releases[?(@.type=="release")].version')).toEqual(['2026.2.4', '2026.2.4.1']);
    });

    test('returns a single match as a list and accepts numbers', () => {
        expect(selectJsonVersions({ latest: 42 }, '$.latest')).toEqual(['42']);
        expect(selectJsonVersions({}, '$.missing')).toEqual([]);
    });

    test('does not evaluate arbitrary JavaScript in filters', () => {
        expect(() => selectJsonVersions(products, '$[0].releases[?(process.exit(1))].version')).toThrow();
    });
});

describe('JsonProvider', () => {
    let getSpy: ReturnType<typeof spyOn> | undefined;
    afterEach(() => getSpy?.mockRestore());

    const json = (extra: Partial<PreaurJsonChecker> = {}): PreaurJsonChecker => ({
        type: 'json',
        url: 'https://data.example.com/products',
        path: '$[0].releases[*].version',
        ...extra,
    });
    const body = [{ releases: [{ version: '2026.2.3' }, { version: '2026.2.4.1' }, { version: '2026.10' }] }];

    test('picks the newest version and sends rendered params', async () => {
        getSpy = spyOn(http, 'getJson').mockResolvedValue(body);
        const result = await new JsonProvider().check(json({ params: { code: 'CL', 'release.type': 'release', _: '{{timestamp}}' } }));
        expect(result).toEqual({ version: '2026.10' });
        const params = getSpy.mock.calls[0]![1].params;
        expect(params).toMatchObject({ code: 'CL', 'release.type': 'release' });
        expect(params._).toMatch(/^\d+$/);
    });

    test('sort_by none takes the first match that passes the template', async () => {
        getSpy = spyOn(http, 'getJson').mockResolvedValue(body);
        expect(await new JsonProvider().check(json({ sort_by: 'none' }))).toEqual({ version: '2026.2.3' });
        expect(await new JsonProvider().check(json({ sort_by: 'none', template: '{~pkgver}.{~pkgver}.{~pkgver}.{_hotfix}' })))
            .toEqual({ version: '2026.2.4.1' });
    });

    test('reports when the path matches nothing', async () => {
        getSpy = spyOn(http, 'getJson').mockResolvedValue({});
        await expect(new JsonProvider().check(json())).rejects.toThrow(/matched no version string/);
    });
});

describe('json checker config', () => {
    const configWith = (params: Record<string, unknown>) => ({
        maintainers: [{ id: 'm', name: 'M', email: 'm@example.com' }],
        packages: [{ pkgname: 'clion', maintainer: 'm', checker: { type: 'json', url: 'https://x', path: '$..version', params } }],
    });

    test('accepts supported placeholders and rejects others', () => {
        expect(PreaurRawConfigSchema.safeParse(configWith({ _: '{{timestamp}}', r: '{{random=256}}' })).success).toBe(true);
        const bad = PreaurRawConfigSchema.safeParse(configWith({ r: '{{random=257}}' }));
        expect(bad.success).toBe(false);
        expect(bad.error?.message).toMatch(/Unsupported placeholder/);
    });
});
