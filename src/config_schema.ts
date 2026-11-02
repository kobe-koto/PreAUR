import { z } from 'zod';

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
    headers: z.record(z.string()).optional().describe('Custom HTTP headers.'),
    payload: z.union([z.string(), z.record(z.any())]).optional().describe('Request payload. Default: {message: <rendered template>}. Supports {{variable}} templates.'),
    tags: z.array(PreaurWebhookEventTagSchema).describe('Event tags this webhook subscribes to.'),
    templates: z.record(PreaurWebhookEventTagSchema, z.string()).optional().describe('Custom message templates for each tag. Uses default templates if omitted.'),
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
    removeOld: z.boolean().default(false).describe('Pass -R to repo-add so the previous package file and its signature are deleted when a different version of the same package name replaces it. Files already missing from the database, packages no longer produced, and leftover -debug packages are not removed.'),
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

const PreaurRuntimeConfigSchema = z.object({
    pkgbuildParser: z.enum(['native', 'makepkg']).optional().describe('PKGBUILD parser implementation.'),
    trustedAurGitPrefixes: stringList('Git URL prefixes treated as AUR package sources.').optional(),
    pkgbuildSandbox: PreaurPkgbuildSandboxSchema.optional(),
    chrootPacman: PreaurChrootPacmanSchema.optional(),
    toolchain: PreaurToolchainSchema.optional().describe('Global toolchain options for all packages. Packages can override individual fields with their own toolchain block.'),
}).strict().describe('Runtime behavior settings.');

const PreaurCheckerBaseShape = {
    strip_version: z.boolean().optional().describe('Strip common version prefixes before comparison.'),
    normalize: z.boolean().optional().describe('Normalize upstream version text.'),
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

const PreaurCheckerSchema = z.discriminatedUnion('type', [
    PreaurGitHubCheckerSchema,
    PreaurDebCheckerSchema,
    PreaurRpmCheckerSchema,
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
export type PreaurChecker = z.output<typeof PreaurCheckerSchema>;
export type PreaurGitHubChecker = z.output<typeof PreaurGitHubCheckerSchema>;
export type PreaurDebChecker = z.output<typeof PreaurDebCheckerSchema>;
export type PreaurRpmChecker = z.output<typeof PreaurRpmCheckerSchema>;
export type PreaurDummyPackage = z.output<typeof PreaurDummyPackageSchema>;
export type PreaurPackage = z.output<typeof PreaurPackageSchema>;
export type PreaurWebhookConfig = z.output<typeof PreaurWebhookSchema>;
export type PreaurWebhookEventTag = z.output<typeof PreaurWebhookEventTagSchema>;
