import simpleGit, { type SimpleGit } from 'simple-git';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { PreaurProjectGitConfig, PreaurProjectGitPushConfig, PreaurProjectGitSyncConfig } from './config';
import { constructMessager } from './logger';
import { formatPacmanVersion, hasPacmanVersion } from './pacman_version';
import type { VersionInfo } from './version_store';
import type { VersionStore } from './version_store';

const ProjectGitMessager = constructMessager('Project Git');

const DATA_DIR = 'data';
const VERSIONS_FILE = 'data/versions.json';
const KNOWN_PACKAGES_FILE = 'data/known_packages';
const KNOWN_MAINTAINERS_FILE = 'data/known_maintainers';
const UNAPPROVED_PREFIX = '!!!';

export interface KnownEntry {
    approved: boolean;
    comment?: string;
}

export interface ProjectDataSnapshot {
    versions: Record<string, VersionInfo>;
    versionsExists: boolean;
    knownPackages: Map<string, KnownEntry>;
    knownPackagesExists: boolean;
    knownMaintainers: Map<string, KnownEntry>;
    knownMaintainersExists: boolean;
}

type SnapshotFile = typeof VERSIONS_FILE | typeof KNOWN_PACKAGES_FILE | typeof KNOWN_MAINTAINERS_FILE;

interface DataCommitStep {
    file: SnapshotFile;
    key: string;
    message: string;
    apply(current: ProjectDataSnapshot, target: ProjectDataSnapshot): void;
}

interface ResolvedProjectGitConfig {
    enabled: boolean;
    remote: string;
    branch?: string;
    sync: PreaurProjectGitSyncConfig;
    push: PreaurProjectGitPushConfig;
}

export class ProjectGitManager {
    private commitCount = 0;
    private queue: Promise<void> = Promise.resolve();

    constructor(
        private readonly baseDir: string,
        private readonly git: SimpleGit,
        private readonly config: ResolvedProjectGitConfig,
        private readonly branch: string
    ) {}

    static async create(baseDir: string, config: PreaurProjectGitConfig | undefined): Promise<ProjectGitManager | undefined> {
        const resolvedConfig = resolveProjectGitConfig(config);
        if (!resolvedConfig.enabled) return undefined;

        try {
            await simpleGit().raw(['--version']);
        } catch (e: any) {
            console.warn(ProjectGitMessager(`git is not available; project git automation disabled (${e.message}).`));
            return undefined;
        }

        const git = simpleGit(baseDir);
        const insideWorkTree = await git.raw(['rev-parse', '--is-inside-work-tree'])
            .then(output => output.trim() === 'true')
            .catch(() => false);
        if (!insideWorkTree) {
            console.warn(ProjectGitMessager('Current working directory is not a git repository; project git automation disabled.'));
            return undefined;
        }

        const remotes = await git.getRemotes(true);
        if (!remotes.some(remote => remote.name === resolvedConfig.remote)) {
            console.warn(ProjectGitMessager(`Remote ${resolvedConfig.remote} is not configured; project git automation disabled.`));
            return undefined;
        }

        const status = await git.status();
        const branch = resolvedConfig.branch ?? status.current;
        if (!branch) {
            throw new Error('Project git sync requires a current branch or git.branch in config.');
        }
        if (resolvedConfig.branch && status.current && status.current !== resolvedConfig.branch) {
            throw new Error(`Project git current branch is ${status.current}, but git.branch is ${resolvedConfig.branch}.`);
        }

        const manager = new ProjectGitManager(baseDir, git, resolvedConfig, branch);
        await manager.syncBeforeRun();
        return manager;
    }

    async snapshotData(): Promise<ProjectDataSnapshot> {
        return readProjectDataSnapshot(this.baseDir);
    }

    async commitDataChanges(before: ProjectDataSnapshot): Promise<void> {
        await this.runExclusive(async () => {
            const target = await readProjectDataSnapshot(this.baseDir);
            const steps = collectDataCommitSteps(before, target);
            if (steps.length === 0) return;

            const current = cloneSnapshot(before);
            await writeProjectDataSnapshot(this.baseDir, current);

            for (const step of steps) {
                step.apply(current, target);
                await writeProjectDataSnapshot(this.baseDir, current);
                await this.commitFiles([step.file], step.message);
            }
        });
    }

    async commitVersionStoreUpdate(
        versionStore: VersionStore,
        pkgname: string,
        info: VersionInfo
    ): Promise<void> {
        await this.runExclusive(async () => {
            const before = await readProjectDataSnapshot(this.baseDir);
            versionStore.set(pkgname, info);
            await versionStore.save();
            const after = await readProjectDataSnapshot(this.baseDir);

            if (sameVersionInfo(before.versions[pkgname], after.versions[pkgname])) return;

            const version = after.versions[pkgname];
            const suffix = hasPacmanVersion(version)
                ? ` to ${formatPacmanVersion(version)}`
                : '';

            await this.commitFiles([VERSIONS_FILE], `versions: update ${pkgname}${suffix}`);
        });
    }

    async pushIfNeeded(): Promise<void> {
        if (this.commitCount === 0) {
            console.log(ProjectGitMessager('No project commits to push.'));
            return;
        }

        const args = this.config.push.force
            ? ['push', '--force', this.config.remote, `HEAD:${this.branch}`]
            : ['push', this.config.remote, `HEAD:${this.branch}`];

        console.log(ProjectGitMessager(`Pushing ${this.commitCount} project commit(s) to ${this.config.remote}/${this.branch}...`));
        await this.git.raw(args);
    }

    private async syncBeforeRun(): Promise<void> {
        const allowOverwrite = this.config.sync.allowRemoteOverwriteLocal
            ?? this.config.sync.allow_remote_overwrite_local
            ?? false;
        const remoteRef = `${this.config.remote}/${this.branch}`;

        console.log(ProjectGitMessager(`Fetching ${this.config.remote}...`));
        await this.git.fetch(this.config.remote);

        const remoteExists = await this.git.raw(['rev-parse', '--verify', remoteRef])
            .then(() => true)
            .catch(() => false);
        if (!remoteExists) {
            throw new Error(`Project git remote branch ${remoteRef} does not exist.`);
        }

        if (allowOverwrite) {
            console.log(ProjectGitMessager(`Resetting working tree to ${remoteRef}.`));
            await this.git.reset(['--hard', remoteRef]);
            return;
        }

        try {
            console.log(ProjectGitMessager(`Fast-forwarding from ${remoteRef}...`));
            await this.git.raw(['pull', '--ff-only', this.config.remote, this.branch]);
        } catch (e: any) {
            throw new Error(`Project git sync failed; resolve remote/local conflicts manually or set git.sync.allow_remote_overwrite_local=true: ${e.message}`);
        }
    }

    private async runExclusive<T>(work: () => Promise<T>): Promise<T> {
        const run = this.queue.then(work, work);
        this.queue = run.then(() => undefined, () => undefined);
        return run;
    }

    private async commitFiles(files: SnapshotFile[], message: string): Promise<void> {
        await this.git.add(files);
        const staged = await this.git.diff(['--cached', '--name-only', '--', ...files]);
        if (!staged.trim()) return;

        await this.git.commit(message);
        this.commitCount += 1;
        console.log(ProjectGitMessager(`Committed: ${message}`));
    }
}

export async function saveVersionStoreUpdate(
    versionStore: VersionStore,
    pkgname: string,
    info: VersionInfo,
    projectGit?: ProjectGitManager
): Promise<void> {
    if (projectGit) {
        await projectGit.commitVersionStoreUpdate(versionStore, pkgname, info);
        return;
    }

    versionStore.set(pkgname, info);
    await versionStore.save();
}

function resolveProjectGitConfig(config: PreaurProjectGitConfig | undefined): ResolvedProjectGitConfig {
    return {
        enabled: config?.enabled ?? true,
        remote: config?.remote ?? 'origin',
        branch: config?.branch,
        sync: config?.sync ?? {},
        push: config?.push ?? {},
    };
}

export async function readProjectDataSnapshot(baseDir: string): Promise<ProjectDataSnapshot> {
    const versionsPath = path.resolve(baseDir, VERSIONS_FILE);
    const knownPackagesPath = path.resolve(baseDir, KNOWN_PACKAGES_FILE);
    const knownMaintainersPath = path.resolve(baseDir, KNOWN_MAINTAINERS_FILE);

    const versionsRead = await readJsonFile<Record<string, VersionInfo>>(versionsPath, {});
    const knownPackagesRead = await readKnownListFile(knownPackagesPath);
    const knownMaintainersRead = await readKnownListFile(knownMaintainersPath);

    return {
        versions: versionsRead.value,
        versionsExists: versionsRead.exists,
        knownPackages: knownPackagesRead.value,
        knownPackagesExists: knownPackagesRead.exists,
        knownMaintainers: knownMaintainersRead.value,
        knownMaintainersExists: knownMaintainersRead.exists,
    };
}

export function collectDataCommitSteps(before: ProjectDataSnapshot, target: ProjectDataSnapshot): DataCommitStep[] {
    return [
        ...collectVersionSteps(before, target),
        ...collectKnownListSteps(
            before.knownPackages,
            target.knownPackages,
            KNOWN_PACKAGES_FILE,
            'package',
            (current, key, entry) => setKnownEntry(current.knownPackages, key, entry)
        ),
        ...collectKnownListSteps(
            before.knownMaintainers,
            target.knownMaintainers,
            KNOWN_MAINTAINERS_FILE,
            'maintainer',
            (current, key, entry) => setKnownEntry(current.knownMaintainers, key, entry)
        ),
    ];
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<{ exists: boolean; value: T }> {
    try {
        const content = await fs.readFile(filePath, 'utf8');
        return { exists: true, value: JSON.parse(content) as T };
    } catch (e: any) {
        if (e.code === 'ENOENT') return { exists: false, value: fallback };
        throw e;
    }
}

async function readKnownListFile(filePath: string): Promise<{ exists: boolean; value: Map<string, KnownEntry> }> {
    const entries = new Map<string, KnownEntry>();

    try {
        const content = await fs.readFile(filePath, 'utf8');
        for (const rawLine of content.split(/\r?\n/)) {
            const parsed = parseKnownListLine(rawLine);
            if (parsed) entries.set(parsed.value, parsed.entry);
        }
        return { exists: true, value: entries };
    } catch (e: any) {
        if (e.code === 'ENOENT') return { exists: false, value: entries };
        throw e;
    }
}

function parseKnownListLine(rawLine: string): { value: string; entry: KnownEntry } | null {
    const commentIndex = rawLine.indexOf('#');
    const rawValue = commentIndex === -1 ? rawLine : rawLine.slice(0, commentIndex);
    const comment = commentIndex === -1 ? undefined : rawLine.slice(commentIndex + 1).trim();
    const trimmed = rawValue.trim();

    if (!trimmed) return null;

    if (trimmed.startsWith(UNAPPROVED_PREFIX)) {
        const value = trimmed.slice(UNAPPROVED_PREFIX.length).trim();
        return value ? { value, entry: { approved: false, comment } } : null;
    }

    return { value: trimmed, entry: { approved: true, comment } };
}

async function writeProjectDataSnapshot(baseDir: string, snapshot: ProjectDataSnapshot): Promise<void> {
    await fs.mkdir(path.resolve(baseDir, DATA_DIR), { recursive: true });
    await writeSnapshotFile(
        path.resolve(baseDir, VERSIONS_FILE),
        snapshot.versionsExists,
        JSON.stringify(snapshot.versions, null, 2)
    );
    await writeSnapshotFile(
        path.resolve(baseDir, KNOWN_PACKAGES_FILE),
        snapshot.knownPackagesExists,
        renderKnownList(snapshot.knownPackages)
    );
    await writeSnapshotFile(
        path.resolve(baseDir, KNOWN_MAINTAINERS_FILE),
        snapshot.knownMaintainersExists,
        renderKnownList(snapshot.knownMaintainers)
    );
}

async function writeSnapshotFile(filePath: string, exists: boolean, content: string): Promise<void> {
    if (!exists) {
        await fs.unlink(filePath).catch((e: any) => {
            if (e.code !== 'ENOENT') throw e;
        });
        return;
    }

    await fs.writeFile(filePath, content, 'utf8');
}

function renderKnownList(entries: Map<string, KnownEntry>): string {
    const lines = [...entries.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([value, entry]) => {
            const prefix = entry.approved ? value : `${UNAPPROVED_PREFIX} ${value}`;
            return entry.comment ? `${prefix} # ${entry.comment}` : prefix;
        });

    return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

function collectVersionSteps(before: ProjectDataSnapshot, target: ProjectDataSnapshot): DataCommitStep[] {
    const keys = sortedUnion(Object.keys(before.versions), Object.keys(target.versions));

    return keys
        .filter(key => !sameVersionInfo(before.versions[key], target.versions[key]))
        .map(key => ({
            file: VERSIONS_FILE,
            key,
            message: versionCommitMessage(key, before.versions[key], target.versions[key]),
            apply(current, targetSnapshot) {
                const next = targetSnapshot.versions[key];
                if (next === undefined) {
                    delete current.versions[key];
                } else {
                    current.versions[key] = cloneVersionInfo(next);
                    current.versionsExists = true;
                }
            },
        }));
}

function collectKnownListSteps(
    before: Map<string, KnownEntry>,
    target: Map<string, KnownEntry>,
    file: SnapshotFile,
    noun: 'package' | 'maintainer',
    applyEntry: (current: ProjectDataSnapshot, key: string, entry: KnownEntry | undefined) => void
): DataCommitStep[] {
    const keys = sortedUnion([...before.keys()], [...target.keys()]);

    return keys
        .filter(key => !sameKnownEntry(before.get(key), target.get(key)))
        .map(key => ({
            file,
            key,
            message: knownEntryCommitMessage(noun, key, before.get(key), target.get(key)),
            apply(current, targetSnapshot) {
                const entry = file === KNOWN_PACKAGES_FILE
                    ? targetSnapshot.knownPackages.get(key)
                    : targetSnapshot.knownMaintainers.get(key);
                applyEntry(current, key, entry);
                if (file === KNOWN_PACKAGES_FILE) current.knownPackagesExists = true;
                if (file === KNOWN_MAINTAINERS_FILE) current.knownMaintainersExists = true;
            },
        }));
}

function setKnownEntry(entries: Map<string, KnownEntry>, key: string, entry: KnownEntry | undefined): void {
    if (entry === undefined) {
        entries.delete(key);
    } else {
        entries.set(key, { ...entry });
    }
}

function versionCommitMessage(pkgname: string, before: VersionInfo | undefined, target: VersionInfo | undefined): string {
    if (target === undefined) return `versions: remove ${pkgname}`;
    if (hasPacmanVersion(target) && !samePacmanVersion(before, target)) {
        return `versions: update ${pkgname} to ${formatPacmanVersion(target)}`;
    }
    if (before === undefined) return `approval: track ${pkgname} ownership`;
    if (before?.source !== (target as VersionInfo).source) return `approval: update ${pkgname} source`;

    return `approval: update ${pkgname} maintainers`;
}

function knownEntryCommitMessage(
    noun: 'package' | 'maintainer',
    key: string,
    before: KnownEntry | undefined,
    target: KnownEntry | undefined
): string {
    if (!before && target) return `approval: add known ${noun} ${key}`;
    if (before && !target) return `approval: remove known ${noun} ${key}`;
    if (before && target && before.approved !== target.approved) {
        return target.approved
            ? `approval: approve ${noun} ${key}`
            : `approval: unapprove ${noun} ${key}`;
    }

    return `approval: update ${noun} ${key}`;
}

function sameVersionInfo(a: VersionInfo | undefined, b: VersionInfo | undefined): boolean {
    return stableStringify(a ?? null) === stableStringify(b ?? null);
}

function sameKnownEntry(a: KnownEntry | undefined, b: KnownEntry | undefined): boolean {
    if (!a || !b) return a === b;
    return a.approved === b.approved && (a.comment ?? '') === (b.comment ?? '');
}

function samePacmanVersion(a: VersionInfo | undefined, b: VersionInfo): boolean {
    return a?.epoch === b.epoch
        && a?.pkgver === b.pkgver
        && a?.pkgrel === b.pkgrel;
}

function sortedUnion(a: string[], b: string[]): string[] {
    return [...new Set([...a, ...b])].sort((left, right) => left.localeCompare(right));
}

function cloneSnapshot(snapshot: ProjectDataSnapshot): ProjectDataSnapshot {
    return {
        versions: Object.fromEntries(
            Object.entries(snapshot.versions).map(([key, value]) => [key, cloneVersionInfo(value)])
        ),
        versionsExists: snapshot.versionsExists,
        knownPackages: new Map([...snapshot.knownPackages.entries()].map(([key, value]) => [key, { ...value }])),
        knownPackagesExists: snapshot.knownPackagesExists,
        knownMaintainers: new Map([...snapshot.knownMaintainers.entries()].map(([key, value]) => [key, { ...value }])),
        knownMaintainersExists: snapshot.knownMaintainersExists,
    };
}

function cloneVersionInfo(value: VersionInfo): VersionInfo {
    return JSON.parse(JSON.stringify(value)) as VersionInfo;
}

function stableStringify(value: unknown): string {
    return JSON.stringify(sortObject(value));
}

function sortObject(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortObject);
    if (!value || typeof value !== 'object') return value;

    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => [key, sortObject(item)])
    );
}
