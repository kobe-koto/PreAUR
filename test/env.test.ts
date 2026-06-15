import { describe, expect, test } from 'bun:test';

import { shellEnvCommand } from '../src/env';

describe('shellEnvCommand', () => {
    test('renders explicit env prefix with shell-quoted assignments', () => {
        expect(shellEnvCommand('makepkg --printsrcinfo', [
            ['PKGDEST', '/work/demo/pkgdest'],
            ['PACKAGER', 'PreAUR <preaur@example.test>'],
        ])).toBe("env 'PKGDEST=/work/demo/pkgdest' 'PACKAGER=PreAUR <preaur@example.test>' makepkg --printsrcinfo");
    });

    test('omits env prefix when there are no assignments', () => {
        expect(shellEnvCommand('updpkgsums', [])).toBe('updpkgsums');
    });
});
