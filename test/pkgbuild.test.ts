import { test, expect, describe, afterEach } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { parseLiteralPkgbase, parsePkgBuild, parseSrcInfoPkgbase } from '../src/pkgbuild';

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
