import * as z from 'zod';

import { findInvalidPlaceholder, RANDOM_PLACEHOLDER_MAX } from './http.ts';

const stringList = (description: string) => z.array(z.string()).describe(description);

const PreaurWebhookEventTagSchema = z.enum([
    'SESSION_START',
    'SESSION_END',
    'SESSION_FAILED',
    'APPROVAL_NEW_PACKAGE',
    'APPROVAL_NEW_MAINTAINER',
    'APPROVAL_UNAPPROVED',
    'APPROVAL_PASSED',
    'PACKAGE_UPDATED',
    'PACKAGE_NO_UPDATE',
    'PACKAGE_CHECK_FAILED',
    'BUILD_START',
    'BUILD_SUCCESSFUL',
    'BUILD_FAILED',
    'PUSH_START',
    'PUSH_SUCCESSFUL',
    'PUSH_FAILED',
]).describe('Webhook event tag.');

const PreaurWebhookSchema = z.object({
    id: z.string().describe('Webhook identifier for logging.'),
    url: z.string().describe('Webhook endpoint URL. Supports {{variable}} templates.'),
    method: z.enum(['GET', 'POST']).optional().describe('HTTP method. Default: POST.'),
    headers: z.record(z.string(), z.string()).optional().describe('Custom HTTP headers.'),
    payload: z.union([z.string(), z.record(z.string(), z.any())]).optional().describe('Request payload. Default: {message: <rendered template>}. Supports {{variable}} templates.'),
    tags: z.array(PreaurWebhookEventTagSchema).describe('Event tags this webhook subscribes to.'),
    templates: z.partialRecord(PreaurWebhookEventTagSchema, z.string()).optional().describe('Custom message templates for each tag. Uses default templates if omitted.'),
}).strict().describe('A webhook notification endpoint.');
const versionPart = z.union([z.string(), z.number()]);

const PreaurMaintainerSchema = z.object({
    id: z.string().describe('Stable maintainer id used by packages.'),
    name: z.string().describe('Maintainer display name.'),
    email: z.string().describe('Maintainer email address.'),
}).strict().describe('A packager identity.');

const PreaurResourcesSchema = z.object({
    cpu: z.string().optional().describe('CPU allocation passed to builders.'),
    parallel: z.coerce.number().int().min(1).default(2).describe('Concurrent package builds.'),
    updateCheckCocurrent: z.coerce.number().int().min(1).default(1).describe('Concurrent version checks.'),
}).strict().prefault({}).describe('Build and check concurrency settings.');

const PreaurRepoSchema = z.object({
    name: z.string().describe('Local pacman repository name.'),
    removeOld: z.boolean().default(false).describe('Pass -R to repo-add so the previous package file and its signature are deleted when a different version of the same package name replaces it. After each repo-add, also repo-remove packages with the same pkgbase that the build no longer produced (dropped split packages, or -debug packages after debug was turned off) and delete their files. Files already missing from the database are not removed.'),
    removeOrphans: z.boolean().default(false).describe('When a package recorded in data/versions.json is no longer in packages, run repo-remove for every database entry built from its pkgbase (split and -debug packages included; <pkgname> and <pkgname>-debug when no entry matches) and delete their package files and signatures before dropping the versions.json entry. Entries already dropped while this was off are not cleaned up. Packages never recorded in versions.json, such as ones added to the repository by hand, are never removed.'),
}).strict().describe('Local pacman repository settings.');

const PreaurProjectGitSyncSchema = z.object({
    allow_remote_overwrite_local: z.boolean().default(false).describe('Reset local state to remote during sync.'),
    allowRemoteOverwriteLocal: z.boolean().optional().describe('CamelCase alias for allow_remote_overwrite_local.'),
}).strict().prefault({}).describe('Project git startup sync policy.');

const PreaurProjectGitPushSchema = z.object({
    force: z.boolean().default(false).describe('Use git push --force after builds.'),
}).strict().prefault({}).describe('Project git push policy.');

const PreaurProjectGitSchema = z.object({
    enabled: z.boolean().default(true).describe('Enable project git automation.'),
    remote: z.string().default('origin').describe('Remote used for sync and push.'),
    branch: z.string().optional().describe('Branch used for sync and push. Default: current branch.'),
    sync: PreaurProjectGitSyncSchema,
    push: PreaurProjectGitPushSchema,
}).strict().prefault({}).describe('Project repository automation.');

const PreaurChrootPacmanRepositorySchema = z.object({
    name: z.string().describe('Pacman repository name.'),
    siglevel: z.union([z.string(), z.array(z.string())]).optional().describe('Repository SigLevel line.'),
    include: stringList('Host files included into this repository block.').optional(),
    lines: stringList('Raw pacman.conf lines appended to this repository block.').optional(),
}).strict().describe('A custom pacman repository for chroot builds.');

const PreaurChrootPacmanSchema = z.object({
    include: stringList('Host files included into generated pacman.conf.').optional(),
    lines: stringList('Raw pacman.conf lines appended globally.').optional(),
    repositories: z.array(PreaurChrootPacmanRepositorySchema).optional().describe('Custom chroot pacman repositories.'),
}).strict().describe('Pacman configuration added to devtools chroots.');

const PreaurPkgbuildSandboxSchema = z.object({
    enabled: z.boolean().default(true).describe('Run PKGBUILD metadata commands inside a chroot sandbox.'),
    root: z.string().optional().describe('Dedicated metadata chroot root managed by PreAUR. Defaults to /var/lib/preaur/metadata/<repo>-<arch> derived from the package builder. Must not be a devtools build chroot.'),
    command: z.string().default('systemd-nspawn').describe('Sandbox command used to enter the chroot.'),
    sudo: z.boolean().default(true).describe('Run the sandbox command through sudo when PreAUR is not root.'),
    user: z.string().default('preaur').describe('User used inside the chroot for makepkg commands. It is created with the host UID when missing.'),
    network: z.boolean().default(true).describe('Allow network access inside the PKGBUILD sandbox.'),
    ephemeral: z.boolean().default(true).describe('Run metadata commands on a read-only view of the root with a tmpfs overlay (systemd-nspawn --volatile=overlay); changes are discarded after the command exits.'),
    initRoot: z.boolean().default(true).describe('Create a missing metadata chroot root with devtools mkarchroot.'),
    packages: stringList('Extra packages installed once into the persistent metadata chroot root, in addition to base-devel, git, and pacman-contrib.').default([]),
}).strict().prefault({}).describe('Chroot sandbox used for PKGBUILD metadata commands before building.');

const PreaurToolchainSchema = z.object({
    llvm: z.boolean().optional().describe('Build with Clang/LLVM: CC=clang, CXX=clang++, llvm-ar/llvm-ranlib/llvm-nm, and llvm-strip. Links with LLD in driver mode unless lld is false or mold is enabled. Installs clang and llvm in the chroot.'),
    mold: z.union([z.boolean(), z.enum(['driver', 'replace'])]).optional().describe('Link with mold. driver (or true): -fuse-ld=mold in LDFLAGS and RUSTFLAGS. replace: point /usr/bin/ld at ld.mold in the build chroot so every link uses mold. Installs mold in the chroot.'),
    lld: z.union([z.boolean(), z.enum(['driver', 'replace'])]).optional().describe('Link with LLD. driver (or true): -fuse-ld=lld in LDFLAGS and RUSTFLAGS. replace: point /usr/bin/ld at ld.lld in the build chroot. false disables the implicit LLD of llvm. With GCC it requires lto: off. Installs lld in the chroot.'),
    lto: z.enum(['default', 'off', 'thin', 'full']).optional().describe('C/C++ link-time optimization: default keeps the makepkg policy, off disables LTO, thin uses LLVM ThinLTO (requires llvm), full uses -flto=full (LLVM) or -flto=auto with gcc-ar/gcc-ranlib/gcc-nm (GCC).'),
    debug: z.boolean().optional().describe('Force makepkg debug packages on (true) or off (false). Unset keeps the chroot makepkg.conf policy.'),
    stripOnLink: z.boolean().optional().describe('Strip at link time (-s in LDFLAGS) and disable makepkg post-build stripping (!strip). No debug package is produced.'),
}).strict().describe('Compiler, linker, and makepkg build option overrides applied to devtools chroot builds through a makepkg.conf drop-in.');

const PreaurChecksumArchSchema = z.enum(['all', 'target']).describe('Which sources PKGBUILD checksum updates download and hash. all runs updpkgsums, which downloads the sources of every architecture in arch=(). target downloads and hashes only the generic sources and those of the builder architecture (for example x86_64 for extra-x86_64-build), leaving the other architectures\' checksum arrays unchanged and therefore outdated after a version change. target falls back to all when arch=() does not list the builder architecture, and it is refused for packages with push: true, since the outdated checksums would be published.');

const PreaurRuntimeConfigSchema = z.object({
    pkgbuildParser: z.enum(['native', 'makepkg']).optional().describe('PKGBUILD parser implementation.'),
    checksumArch: PreaurChecksumArchSchema.optional().describe('Default checksum scope for all packages: all or target. Default: all. See the package checksumArch option.'),
    trustedAurGitPrefixes: stringList('Git URL prefixes treated as AUR package sources.').optional(),
    pkgbuildSandbox: PreaurPkgbuildSandboxSchema.optional(),
    chrootPacman: PreaurChrootPacmanSchema.optional(),
    toolchain: PreaurToolchainSchema.optional().describe('Global toolchain options for all packages. Packages can override individual fields with their own toolchain block.'),
}).strict().describe('Runtime behavior settings.');

const PreaurCheckerBaseShape = {
    strip_version: z.boolean().optional().describe('Keep only the part of the version before the first - or _ (for example, drop a Debian or RPM release).'),
    normalize: z.boolean().optional().describe('Replace colons, slashes, hyphens and whitespace in the version with underscores. Only applies to the github checker.'),
    template: z.string().optional().describe('Template mapping upstream version text to PKGBUILD variables. Versions that do not match the template are ignored when picking the latest.'),
};

const PreaurGitHubCheckerSchema = z.object({
    ...PreaurCheckerBaseShape,
    type: z.literal('github').describe('Use GitHub release data.'),
    repo: z.string().describe('GitHub repository as owner/name.'),
    use: z.string().optional().describe('Release selector such as release or prerelease.'),
    prefix: z.string().optional().describe('Required tag prefix. Releases whose tag lacks it are skipped; it is stripped from the matching tag.'),
    suffix: z.string().optional().describe('Required tag suffix. Releases whose tag lacks it are skipped; it is stripped from the matching tag.'),
}).strict().describe('GitHub version checker.');

const PreaurDebCheckerSchema = z.object({
    ...PreaurCheckerBaseShape,
    type: z.literal('deb').describe('Use a Debian Packages index.'),
    url: z.string().describe('Repository base URL.'),
    pkg: z.string().describe('Debian package name.'),
    dist: z.string().describe('Debian distribution name.'),
    component: z.string().describe('Debian repository component.'),
    arch: z.string().optional().describe('Debian architecture.'),
}).strict().describe('Debian repository version checker.');

const PreaurRpmCheckerSchema = z.object({
    ...PreaurCheckerBaseShape,
    type: z.literal('rpm').describe('Use an RPM repository.'),
    url: z.string().describe('Repository base URL.'),
    pkg: z.string().describe('RPM package name.'),
}).strict().describe('RPM repository version checker.');

const jsonParamValue = z.union([z.string(), z.number(), z.boolean()]).refine(
    value => typeof value !== 'string' || findInvalidPlaceholder(value) === null,
    { message: `Unsupported placeholder. Use {{timestamp}} or {{random=N}} with N from 1 to ${RANDOM_PLACEHOLDER_MAX}.` },
);

const PreaurJsonCheckerSchema = z.object({
    ...PreaurCheckerBaseShape,
    type: z.literal('json').describe('Use a JSON HTTP response.'),
    url: z.string().describe('URL returning JSON.'),
    params: z.record(z.string(), jsonParamValue).optional().describe('Query parameters appended to url. String values support {{timestamp}} (milliseconds) and {{random=N}} (N random [A-Za-z0-9] characters, 1-256), generated on every request.'),
    path: z.string().describe('JSONPath expression selecting version strings or numbers, e.g. $[0].releases[?(@.type=="release")].version. Filter expressions use the safe evaluator.'),
    sort_by: z.enum(['version', 'none']).optional().describe('How to pick among matches: version takes the newest by version comparison; none takes the first match. Default: version.'),
}).strict().describe('JSON HTTP response version checker.');

const PreaurCheckerSchema = z.discriminatedUnion('type', [
    PreaurGitHubCheckerSchema,
    PreaurDebCheckerSchema,
    PreaurRpmCheckerSchema,
    PreaurJsonCheckerSchema,
]).describe('Upstream version checker.');

const PreaurDummyPackageSchema = z.object({
    dummy: z.string().describe('Dummy package name.'),
    epoch: versionPart.optional().describe('Dummy package epoch.'),
    pkgver: versionPart.optional().describe('Dummy package version.'),
    pkgrel: versionPart.optional().describe('Dummy package release.'),
    files: stringList('Files provided by the dummy package.').optional(),
}).strict().describe('A generated dummy dependency package.');

const PreaurPackageSchema = z.object({
    pkgname: z.string().describe('Local package name.'),
    maintainer: z.string().optional().describe('Maintainer id. Defaults to default_maintainer.'),
    allow_orphan_package_build: z.boolean().optional().describe('Allow building an orphan AUR package.'),
    aur_pkgname: z.string().optional().describe('AUR package name when it differs from pkgname.'),
    git: z.string().optional().describe('Package PKGBUILD git URL override.'),
    checker: PreaurCheckerSchema.optional(),
    builder: z.string().optional().describe('Build command such as extra-x86_64-build.'),
    push: z.boolean().optional().describe('Push package PKGBUILD changes to AUR on success.'),
    checksumArch: PreaurChecksumArchSchema.optional().describe('Checksum scope for this package; overrides config.checksumArch. all runs updpkgsums for every architecture. target only downloads and hashes the generic and builder architecture sources and leaves other architectures\' checksums outdated, so it requires a devtools builder such as extra-x86_64-build and is refused when push is true.'),
    dummy_packages: z.array(PreaurDummyPackageSchema).optional().describe('Dummy packages installed before build.'),
    repo_packages: stringList('Local repo packages required before this build.').optional(),
    'pre-build-packages': stringList('Packages installed in chroot before build.').optional(),
    'pre-build-scripts': stringList('Root scripts run in chroot before build.').optional(),
    pre_build_packages: stringList('Alias for pre-build-packages.').optional(),
    pre_build_scripts: stringList('Alias for pre-build-scripts.').optional(),
    toolchain: PreaurToolchainSchema.optional().describe('Per-package toolchain overrides. Set fields replace config.toolchain field by field.'),
}).strict().describe('A package build entry.');

export const PreaurRawConfigSchema = z.object({
    maintainers: z.array(PreaurMaintainerSchema).describe('Known PreAUR maintainers.'),
    default_maintainer: z.string().optional().describe('Maintainer id used when a package omits maintainer.'),
    git: PreaurProjectGitSchema,
    config: PreaurRuntimeConfigSchema.optional(),
    resources: PreaurResourcesSchema,
    repo: PreaurRepoSchema.optional(),
    webhooks: z.array(PreaurWebhookSchema).optional().describe('Webhook notification endpoints.'),
    packages: z.array(PreaurPackageSchema).describe('Packages managed by PreAUR.'),
}).strict().describe('PreAUR configuration file.');

export type PreaurRawConfig = z.output<typeof PreaurRawConfigSchema>;
export type PreaurMaintainer = z.output<typeof PreaurMaintainerSchema>;
export type PreaurResources = z.output<typeof PreaurResourcesSchema>;
export type PreaurRepo = z.output<typeof PreaurRepoSchema>;
export type PreaurRuntimeConfig = z.output<typeof PreaurRuntimeConfigSchema>;
export type PreaurProjectGitConfig = z.output<typeof PreaurProjectGitSchema>;
export type PreaurProjectGitSyncConfig = z.output<typeof PreaurProjectGitSyncSchema>;
export type PreaurProjectGitPushConfig = z.output<typeof PreaurProjectGitPushSchema>;
export type PreaurPkgbuildSandboxConfig = z.output<typeof PreaurPkgbuildSandboxSchema>;
export type PreaurChrootPacmanRepository = z.output<typeof PreaurChrootPacmanRepositorySchema>;
export type PreaurChrootPacmanConfig = z.output<typeof PreaurChrootPacmanSchema>;
export type PreaurToolchainConfig = z.output<typeof PreaurToolchainSchema>;
export type PreaurChecksumArch = z.output<typeof PreaurChecksumArchSchema>;
export type PreaurChecker = z.output<typeof PreaurCheckerSchema>;
export type PreaurGitHubChecker = z.output<typeof PreaurGitHubCheckerSchema>;
export type PreaurDebChecker = z.output<typeof PreaurDebCheckerSchema>;
export type PreaurRpmChecker = z.output<typeof PreaurRpmCheckerSchema>;
export type PreaurJsonChecker = z.output<typeof PreaurJsonCheckerSchema>;
export type PreaurDummyPackage = z.output<typeof PreaurDummyPackageSchema>;
export type PreaurPackage = z.output<typeof PreaurPackageSchema>;
export type PreaurWebhookConfig = z.output<typeof PreaurWebhookSchema>;
export type PreaurWebhookEventTag = z.output<typeof PreaurWebhookEventTagSchema>;
