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
