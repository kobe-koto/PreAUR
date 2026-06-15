import { describe, expect, test } from 'bun:test';

import { packagePreBuildConfig, renderPreBuildInstall, renderPreBuildPkgbuild } from '../src/prebuild';

describe('packagePreBuildConfig', () => {
    test('collects kebab-case and snake_case package-level pre-build settings', () => {
        const config = packagePreBuildConfig({
            pkgname: 'demo',
            'pre-build-packages': ['custom-tool'],
            pre_build_packages: ['another-tool'],
            'pre-build-scripts': ['echo first'],
            pre_build_scripts: ['echo second'],
        });

        expect(config).toEqual({
            packages: ['custom-tool', 'another-tool'],
            scripts: ['echo first', 'echo second'],
        });
    });
});

describe('renderPreBuildPkgbuild', () => {
    test('renders dependencies and install hook for the helper package', () => {
        const pkgbuild = renderPreBuildPkgbuild('Foo/Bar', {
            packages: ['custom-tool>=1.0', 'another-tool'],
            scripts: ['echo prebuild'],
        });

        expect(pkgbuild).toContain('pkgname=preaur-prebuild-foo-bar');
        expect(pkgbuild).toContain("depends=('custom-tool>=1.0' 'another-tool')");
        expect(pkgbuild).toContain('install=preaur-prebuild.install');
    });
});

describe('renderPreBuildInstall', () => {
    test('runs configured scripts from install and upgrade hooks', () => {
        const install = renderPreBuildInstall({
            packages: [],
            scripts: ['echo one', 'echo two'],
        });

        expect(install).toContain('post_install()');
        expect(install).toContain('set -e');
        expect(install).toContain('echo one\n\necho two');
        expect(install).toContain('post_upgrade()');
    });
});
