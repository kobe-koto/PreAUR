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
import axios from 'axios';
import { GitHubProvider, selectLatestCandidate, transformGitHubTag } from '../src/checker';
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
        getSpy = spyOn(axios, 'get').mockResolvedValue({ data: { tag_name: 'v3.1.0' } } as any);
        expect(await new GitHubProvider().check(gh())).toEqual({ version: '3.1.0' });
        expect(String(getSpy.mock.calls[0]?.[0])).toEndWith('/releases/latest');
    });

    test('walks releases and returns the newest matching stable release', async () => {
        getSpy = spyOn(axios, 'get').mockResolvedValue({
            data: [
                { tag_name: 'cli-v9.0.0', prerelease: false },
                { tag_name: 'app-v2.0.0', prerelease: true },
                { tag_name: 'app-v1.5.0', prerelease: false, draft: true },
                { tag_name: 'app-v1.4.0', prerelease: false },
            ],
        } as any);

        expect(await new GitHubProvider().check(gh({ prefix: 'app-v' }))).toEqual({ version: '1.4.0' });
        expect(String(getSpy.mock.calls[0]?.[0])).toEndWith('/releases');
    });

    test('includes prereleases when use is prerelease', async () => {
        getSpy = spyOn(axios, 'get').mockResolvedValue({
            data: [
                { tag_name: 'cli-v9.0.0', prerelease: true },
                { tag_name: 'app-v2.0.0', prerelease: true },
            ],
        } as any);

        expect(await new GitHubProvider().check(gh({ prefix: 'app-v', use: 'prerelease' }))).toEqual({ version: '2.0.0' });
    });

    test('fails clearly when no release matches', async () => {
        getSpy = spyOn(axios, 'get').mockResolvedValue({ data: [{ tag_name: 'cli-v1.0.0' }] } as any);
        await expect(new GitHubProvider().check(gh({ prefix: 'app-v' }))).rejects.toThrow(/No non-prerelease GitHub release matched prefix "app-v"/);
    });
});
