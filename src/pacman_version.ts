export interface PacmanVersion {
    epoch: number;
    pkgver: string;
    pkgrel: number;
}

export interface PartialPacmanVersion {
    epoch?: number;
    pkgver?: string;
    pkgrel?: number;
}

export type StoredPacmanVersion = PartialPacmanVersion & {
    pkgver: string;
    pkgrel: number;
};

export function hasPacmanVersion(value: PartialPacmanVersion | undefined): value is StoredPacmanVersion {
    return !!value?.pkgver && value.pkgrel !== undefined;
}

export function formatPacmanVersion(value: StoredPacmanVersion): string {
    const epoch = value.epoch ?? 0;
    return `${epoch > 0 ? `${epoch}:` : ''}${value.pkgver}-${value.pkgrel}`;
}

export function pacmanVersionChanged(current: PartialPacmanVersion | undefined, next: PacmanVersion): boolean {
    if (!hasPacmanVersion(current)) return true;

    return next.epoch !== (current.epoch ?? 0)
        || next.pkgver !== current.pkgver
        || next.pkgrel !== current.pkgrel;
}

export function packageArtifactPrefix(pkgname: string, version: StoredPacmanVersion): string {
    const epoch = version.epoch ?? 0;
    const epochPrefix = epoch > 0 ? `${epoch}:` : '';
    return `${pkgname}-${epochPrefix}${version.pkgver}-${version.pkgrel}-`;
}
