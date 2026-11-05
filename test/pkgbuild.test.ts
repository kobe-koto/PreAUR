import { test, expect, describe, afterEach } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { createHash } from 'node:crypto';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

import {
    isStaticVersionPkgbuild,
    mergeChecksumArrays,
    parseLiteralPkgbase,
    parsePkgBuild,
    parseSrcInfoPkgbase,
    parseTargetArchChecksumOutput,
    updatePkgBuild,
    updateTargetArchChecksums,
} from '../src/pkgbuild.ts';

const tmpDirs: string[] = [];

async function writePkgBuild(content: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'preaur-pkgbuild-'));
    tmpDirs.push(dir);
    const p = path.join(dir, 'PKGBUILD');
    await fs.writeFile(p, content, 'utf8');
    return p;
}

afterEach(async () => {
    while (tmpDirs.length) {
        const dir = tmpDirs.pop()!;
        await fs.rm(dir, { recursive: true, force: true });
    }
});

describe('parsePkgBuild', () => {
    test('parses plain literal fields (regex fast path)', async () => {
        const p = await writePkgBuild(
            `pkgname=foo\npkgver=1.2.3\npkgrel=2\n`
        );
        expect(await parsePkgBuild(p)).toEqual({ epoch: 0, pkgver: '1.2.3', pkgrel: 2, pkgbase: 'foo' });
    });

    test('strips surrounding quotes from pkgver', async () => {
        const p = await writePkgBuild(
            `pkgname=foo\npkgver="1.2.3"\npkgrel=1\n`
        );
        expect((await parsePkgBuild(p)).pkgver).toBe('1.2.3');
    });

    test('parses a literal epoch', async () => {
        const p = await writePkgBuild(
            `pkgname=foo\nepoch=2\npkgver=1.0\npkgrel=1\n`
        );
        expect(await parsePkgBuild(p)).toEqual({ epoch: 2, pkgver: '1.0', pkgrel: 1, pkgbase: 'foo' });
    });

    // Regression: a version built through multiple levels of bash variable
    // indirection plus parameter expansion, with no pkgver() function for
    // makepkg to rewrite the literal line back to.
    test('resolves bash variable references and parameter expansion in pkgver', async () => {
        const p = await writePkgBuild(
            [
                'pkgname=demo-pkg',
                '_base_pkgver=1.4.2-rc-7',                 // hyphens are illegal in a real pkgver
                '_referenced_pkgver=${_base_pkgver}',      // indirection through a second var
                'pkgver="${_referenced_pkgver//-/_}"',    // expansion rewrites - to _
                'pkgrel=1',
                '',
            ].join('\n')
        );
        expect(await parsePkgBuild(p)).toEqual({ epoch: 0, pkgver: '1.4.2_rc_7', pkgrel: 1, pkgbase: 'demo-pkg' });
    });

    test('actually applies parameter expansion (hyphen -> underscore)', async () => {
        const p = await writePkgBuild(
            `pkgname=foo\n_v=1-2-3\npkgver="\${_v//-/_}"\npkgrel=1\n`
        );
        expect((await parsePkgBuild(p)).pkgver).toBe('1_2_3');
    });

    test('resolves pkgrel and epoch defined via variables', async () => {
        const p = await writePkgBuild(
            [
                'pkgname=foo',
                '_rel=4',
                '_ep=1',
                'pkgver=1.0',
                'pkgrel=${_rel}',
                'epoch=${_ep}',
                '',
            ].join('\n')
        );
        expect(await parsePkgBuild(p)).toEqual({ epoch: 1, pkgver: '1.0', pkgrel: 4, pkgbase: 'foo' });
    });

    test('throws when pkgver is missing', async () => {
        const p = await writePkgBuild(`pkgname=foo\npkgrel=1\n`);
        await expect(parsePkgBuild(p)).rejects.toThrow(/Could not parse pkgver/);
    });

    test('throws when pkgrel resolves to a non-number', async () => {
        const p = await writePkgBuild(`pkgname=foo\npkgver=1.0\npkgrel=notanumber\n`);
        await expect(parsePkgBuild(p)).rejects.toThrow(/Could not parse pkgrel/);
    });
});

describe('pkgbase', () => {
    const version = 'pkgver=1.0\npkgrel=1\n';

    test('uses an explicit pkgbase', async () => {
        const p = await writePkgBuild(`pkgbase=foo-base\npkgname=(foo foo-docs)\n${version}`);
        expect((await parsePkgBuild(p)).pkgbase).toBe('foo-base');
    });

    test('falls back to a string pkgname', async () => {
        const p = await writePkgBuild(`pkgname='foo'  # comment\n${version}`);
        expect((await parsePkgBuild(p)).pkgbase).toBe('foo');
    });

    test('falls back to the first entry of a pkgname array', async () => {
        const p = await writePkgBuild(`pkgname=(\n  "foo-bin"  # main\n  'foo-docs'\n)\n${version}`);
        expect((await parsePkgBuild(p)).pkgbase).toBe('foo-bin');
    });

    test('resolves pkgname arrays that use variables by sourcing', async () => {
        const p = await writePkgBuild(`_name=foo\npkgname=("\${_name}-git" "\${_name}-docs")\n${version}`);
        expect(await parsePkgBuild(p)).toEqual({ epoch: 0, pkgver: '1.0', pkgrel: 1, pkgbase: 'foo-git' });
    });

    test('resolves a pkgbase defined through a variable', async () => {
        const p = await writePkgBuild(`_base=foo\npkgbase=$_base\npkgname=(a b)\n${version}`);
        expect((await parsePkgBuild(p)).pkgbase).toBe('foo');
    });

    test('omits pkgbase when neither pkgbase nor pkgname is set', async () => {
        const p = await writePkgBuild(version);
        const data = await parsePkgBuild(p);
        expect(data).toEqual({ epoch: 0, pkgver: '1.0', pkgrel: 1 });
        expect('pkgbase' in data).toBe(false);
    });

    test('omits an invalid pkgbase instead of failing the version parse', async () => {
        const p = await writePkgBuild(`pkgname=Foo\n${version}`);
        expect(await parsePkgBuild(p)).toEqual({ epoch: 0, pkgver: '1.0', pkgrel: 1 });
    });

    test('does not let pkgbase sourcing change literal version fields', async () => {
        // The regex reads the first pkgver; sourcing would yield the last one.
        const p = await writePkgBuild(`pkgname=("\${_n:-foo}")\npkgver=1.0\npkgrel=1\npkgver=9.9\n`);
        expect(await parsePkgBuild(p)).toEqual({ epoch: 0, pkgver: '1.0', pkgrel: 1, pkgbase: 'foo' });
    });

    test('parseLiteralPkgbase reports values that need shell expansion', () => {
        expect(parseLiteralPkgbase('pkgname=foo')).toBe('foo');
        expect(parseLiteralPkgbase('pkgname=$_name')).toBe('dynamic');
        expect(parseLiteralPkgbase('pkgname=("${_name}" b)')).toBe('dynamic');
        expect(parseLiteralPkgbase('pkgver=1')).toBeUndefined();
    });

    test('parseSrcInfoPkgbase reads the pkgbase section', () => {
        expect(parseSrcInfoPkgbase('pkgbase = foo-base\n\tpkgver = 1.0\n\npkgname = foo\n')).toBe('foo-base');
        expect(parseSrcInfoPkgbase('\tpkgver = 1.0\n')).toBeUndefined();
    });
});

describe('isStaticVersionPkgbuild', () => {
    const base = [
        'pkgname=demo',
        '_ver=1.2.3',
        'pkgver=${_ver//-/_}',
        'pkgrel=$((1))',
        'source=("https://example.org/demo-$pkgver.tar.gz")',
        'build() {',
        '  cd "demo-$(echo $pkgver)"',
        '  make',
        '}',
        'package() { make DESTDIR="$pkgdir" install; }',
    ].join('\n');

    test('accepts literal versions and command substitution inside function bodies', () => {
        expect(isStaticVersionPkgbuild(base)).toBe(true);
    });

    test('rejects any pkgver() definition', () => {
        expect(isStaticVersionPkgbuild(`${base}\npkgver() {\n  git describe\n}`)).toBe(false);
        expect(isStaticVersionPkgbuild(`${base}\npkgver ()\n{\n  git describe\n}`)).toBe(false);
        expect(isStaticVersionPkgbuild(`${base}\nfunction pkgver {\n  git describe\n}`)).toBe(false);
    });

    test('rejects top-level command substitution, eval, and sourced files', () => {
        expect(isStaticVersionPkgbuild(`_ver=$(date +%Y%m%d)\npkgver=$_ver\npkgrel=1`)).toBe(false);
        expect(isStaticVersionPkgbuild('pkgver=`date +%s`\npkgrel=1')).toBe(false);
        expect(isStaticVersionPkgbuild('source ../common.sh\npkgver=1\npkgrel=1')).toBe(false);
        expect(isStaticVersionPkgbuild('. ./vars\npkgver=1\npkgrel=1')).toBe(false);
        expect(isStaticVersionPkgbuild('eval "$x"\npkgver=1\npkgrel=1')).toBe(false);
    });

    test('rejects a function body whose closing brace is not at column 0', () => {
        expect(isStaticVersionPkgbuild('pkgver=1\npkgrel=1\nbuild() {\n  make\n  }\n')).toBe(false);
    });
});

describe('mergeChecksumArrays', () => {
    const pkgbuild = [
        'pkgname=demo',
        "source=('a.tar.gz')",
        "source_x86_64=('x.bin')",
        "source_aarch64=('arm.bin')",
        "sha256sums=('old-a')",
        "sha256sums_x86_64=('old-x'",
        "                   'old-x2') # trailing comment",
        "sha256sums_aarch64=('old-arm')",
        '',
        'package() {',
        '    true',
        '}',
        '',
    ].join('\n');

    test('replaces generated arrays and keeps other architectures unchanged', () => {
        const merged = mergeChecksumArrays(pkgbuild, "sha256sums=('new-a')\nsha256sums_x86_64=('new-x')");
        expect(merged).toBe(pkgbuild
            .replace("sha256sums=('old-a')", "sha256sums=('new-a')")
            .replace("sha256sums_x86_64=('old-x'\n                   'old-x2') # trailing comment", "sha256sums_x86_64=('new-x')"));
    });

    test('drops += assignments of replaced arrays and keeps those of other arrays', () => {
        const content = "sha256sums=('old')\nsha256sums+=('extra')\nsha256sums_aarch64+=('arm')\n";
        expect(mergeChecksumArrays(content, "sha256sums=('new'\n            'new2')"))
            .toBe("sha256sums=('new'\n            'new2')\nsha256sums_aarch64+=('arm')\n");
    });

    test('inserts arrays new to the PKGBUILD after the last replaced array', () => {
        const content = "sha256sums=('old')\nsha256sums_aarch64=('arm')\nbuild() { :; }\n";
        expect(mergeChecksumArrays(content, "sha256sums=('new')\nsha256sums_x86_64=('x')"))
            .toBe("sha256sums=('new')\nsha256sums_x86_64=('x')\nsha256sums_aarch64=('arm')\nbuild() { :; }\n");
    });

    test('appends arrays at the end when the PKGBUILD has none', () => {
        expect(mergeChecksumArrays("pkgname=demo\n", "sha256sums=('new')"))
            .toBe("pkgname=demo\nsha256sums=('new')\n");
    });

    test('rejects unterminated arrays', () => {
        expect(() => mergeChecksumArrays("sha256sums=('old'\n", "sha256sums=('new')")).toThrow('Unterminated checksum array sha256sums');
    });
});

describe('parseTargetArchChecksumOutput', () => {
    test('returns undefined when arch=() does not list the target', () => {
        expect(parseTargetArchChecksumOutput('__PREAUR_TARGET_SUMS_UNSUPPORTED__\n')).toBeUndefined();
    });

    test('rejects output without checksums', () => {
        expect(() => parseTargetArchChecksumOutput('__PREAUR_TARGET_SUMS_BEGIN__\n\n__PREAUR_TARGET_SUMS_END__\n'))
            .toThrow('does not contain sources');
    });
});

describe('updateTargetArchChecksums', () => {
    const execAsync = promisify(exec);
    const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

    async function writeMultiArchPkgbuild(arch: string): Promise<string> {
        const pkgbuildPath = await writePkgBuild([
            'pkgname=demo',
            'pkgver=1',
            'pkgrel=1',
            `arch=(${arch})`,
            'source=(common.txt)',
            'source_x86_64=(x86.txt)',
            // Fails when downloaded, so the test proves it is never fetched.
            "source_aarch64=('https://preaur.invalid/arm.bin')",
            "sha256sums=('old-common')",
            "sha256sums_x86_64=('old-x86')",
            "sha256sums_aarch64=('old-arm')",
            '',
        ].join('\n'));
        const dir = path.dirname(pkgbuildPath);
        await fs.writeFile(path.join(dir, 'common.txt'), 'common\n');
        await fs.writeFile(path.join(dir, 'x86.txt'), 'x86\n');
        return pkgbuildPath;
    }

    async function srcdestEnv(): Promise<Array<[string, string]>> {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'preaur-srcdest-'));
        tmpDirs.push(dir);
        return [['SRCDEST', dir]];
    }

    test.skipIf(!Bun.which('makepkg'))('only downloads and updates generic and target architecture sources', async () => {
        const pkgbuildPath = await writeMultiArchPkgbuild('x86_64 aarch64');
        await updatePkgBuild('demo', pkgbuildPath, {}, false, 'native', await srcdestEnv(), 'x86_64');

        const content = await fs.readFile(pkgbuildPath, 'utf8');
        expect(content).toContain(`sha256sums=('${sha256('common\n')}')`);
        expect(content).toContain(`sha256sums_x86_64=('${sha256('x86\n')}')`);
        expect(content).toContain("sha256sums_aarch64=('old-arm')");
        expect(await fs.readdir(path.dirname(pkgbuildPath))).toEqual(expect.not.arrayContaining([expect.stringMatching(/^\.preaur-updpkgsums/)]));
    });

    test.skipIf(!Bun.which('makepkg'))('falls back to all architectures when arch=() does not list the target', async () => {
        const pkgbuildPath = await writeMultiArchPkgbuild('aarch64');
        const env = await srcdestEnv();
        let updatedAll = false;
        await updateTargetArchChecksums(pkgbuildPath, 'x86_64', {
            runCapture: async command => (await execAsync(`env SRCDEST=${env[0]![1]} ${command}`, { cwd: path.dirname(pkgbuildPath) })).stdout,
            updateAll: async () => { updatedAll = true; },
        });

        expect(updatedAll).toBe(true);
        expect(await fs.readFile(pkgbuildPath, 'utf8')).toContain("sha256sums=('old-common')");
    });
});
