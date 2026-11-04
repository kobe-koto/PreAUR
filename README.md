# 📦 PreAUR 📦

English | [简体中文](./README.zh-CN.md)

**PreAUR** is an automated Arch Linux AUR (not only) package builder and maintainer (kinda) written in TypeScript.

It streamlines the process of fetching, updating, building, and publishing packages, while automatically maintaining a local pacman repository.

## Features

- **Automated Updates**: Checks for new versions via upstream checkers (GitHub releases, Debian/APT and RPM repositories, or any JSON HTTP API) or dynamic `pkgver()` functions, and updates your `PKGBUILD` seamlessly.
- **Git Syncing**: Clones AUR repositories (into `./pkgbuilds/`) and optionally commits/pushes updates back to the AUR via SSH.
- **Clean Chroot Building**: Defers to `devtools` (e.g., `extra-x86_64-build` or `pkgctl build`) to build packages safely, setting `$MAKEFLAGS` from `resources.cpu`.
- **Local Repository**: Automatically collects built `.pkg.tar.zst` artifacts and maintains a local pacman database (`repo-add`) in `./repo/<repo.name>/`.
- **Smart Caching**: Skips packages whose version/pkgrel is already built, and skips re-parsing static PKGBUILDs whose git commit has not changed.
- **Ownership Approval**: Builds only packages and AUR maintainers you have approved, and asks again when ownership changes.

## Getting Started

### Installation

from AUR:

```bash
paru -S preaur-git # Recommended because i like it
paru -S preaur-bin
```

Both provide `/usr/bin/preaur`, the man pages `preaur(1)` and `preaur-config(5)`, and the config schema.

From source (requires [Bun](https://bun.sh)):

```bash
git clone https://github.com/kobe-koto/PreAUR.git && cd PreAUR
bun install
bun run start   # same as `preaur`
```

### Configuration

PreAUR works in the current directory: it reads `preaur.config.yaml` and `.env` from there, and keeps its state (`data/`), AUR checkouts (`pkgbuilds/`), build files (`work/`), logs (`logs/`) and the local repository (`repo/`) there too. Create a dedicated project directory and always run `preaur` from it:

```bash
mkdir ~/preaur && cd ~/preaur
curl -o preaur.config.yaml https://raw.githubusercontent.com/kobe-koto/PreAUR/main/preaur.config.yaml.example
```

[`preaur.config.yaml.example`](./preaur.config.yaml.example) is an annotated example. Every option is listed in [docs/config-reference.md](./docs/config-reference.md) (also `man 5 preaur-config`). The first line of the example enables editor completion and validation through the config schema:

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/kobe-koto/PreAUR/main/preaur.schema.json
```

#### First Run: Approving Packages and Maintainers

PreAUR only builds packages you have approved, from AUR maintainers you have approved. On every run it records each configured package in `data/known_packages` and each of its AUR maintainers and co-maintainers in `data/known_maintainers`. New entries are written with a `!!!` prefix, which means unapproved:

```text
# data/known_packages
!!! visual-studio-code-bin # Maintainer: some-aur-user

# data/known_maintainers
!!! some-aur-user # Maintaining: visual-studio-code-bin
```

While any entry is unapproved, the run stops before building with `Unapproved AUR ownership entries found`. That is expected on the first run. Review the entries, remove the `!!! ` prefix from the ones you trust, and run again.

A package is marked unapproved again when its AUR maintainers change, or when its source changes to a custom `git` URL.

#### Project Git Automation

If the project directory is a git repository with the configured remote (`origin` by default), PreAUR keeps `data/` in sync with it. This is on by default (`git.enabled: true`):

- Before each run it fetches and runs `git pull --ff-only`. With `git.sync.allow_remote_overwrite_local: true` it runs `git reset --hard <remote>/<branch>` instead, discarding local changes.
- During the run it commits changes in `data/` (versions, approval lists), and at the end it pushes them (`git.push.force` adds `--force`).

If the directory is not a git repository or the remote does not exist, this is skipped with a warning. Set `git.enabled: false` to turn it off.

#### Chroot Pacman Repositories

`config.chrootPacman` can add pacman configuration snippets to devtools chroot builds. PreAUR generates a pacman.conf from the selected devtools base config and binds it into the chroot as `/etc/pacman.conf`.

Host include files are read by PreAUR and expanded into the generated chroot config:

```yaml
config:
  chrootPacman:
    include:
      - ./pacman-extra-repos.conf
    repositories:
      - name: "myrepo"
        siglevel: "Optional TrustAll"
        include:
          - ./pacman-myrepo.conf
        lines:
          - "Server = https://repo.example.org/$repo/os/$arch"
```

Only the generated pacman.conf is bind-mounted into the chroot, so a `Server` must be reachable from inside it (for example an http(s) URL); a `file://` path on the host is not visible. To install packages that PreAUR built itself, use a package's `repo_packages` instead.

When `chrootPacman` is configured, PreAUR also asks `makechrootpkg` to update the working chroot copy so custom repository databases are synced before dependency installation.

#### PKGBUILD Metadata Sandbox

PreAUR runs PKGBUILD metadata commands in a chroot sandbox by default before the package build starts. This covers `makepkg --printsrcinfo`, dynamic `pkgver()` updates, and `updpkgsums`.

Metadata commands run in a dedicated chroot root managed by PreAUR, separate from the devtools build chroot. By default the root is derived from the package builder: `extra-x86_64-build` maps to `/var/lib/preaur/metadata/extra-x86_64`.

- If the root does not exist, PreAUR creates it with devtools `mkarchroot`, using the same pacman and makepkg configuration as the build chroot.
- Once per PreAUR run, before the first metadata command, PreAUR updates the root with `pacman -Syu` and makes sure `base-devel`, `git`, `pacman-contrib`, and `pkgbuildSandbox.packages` are installed. It uses the host package cache and mirrorlist. If the update fails (for example, no network), PreAUR logs a warning and continues with the existing root.
- VCS clients needed by dynamic `pkgver()` (such as `subversion` or `mercurial`) are installed into the root the first time they are needed and are kept for later runs.

Metadata commands themselves never install packages. With `ephemeral: true` (the default), each command runs with `systemd-nspawn --volatile=overlay`: the root is mounted read-only with a tmpfs overlay on top, so nothing is copied and any changes are discarded when the command exits. This works on any filesystem. Commands take a shared `flock` on the root's lock file, and root updates take it exclusively, so the root never changes under a running command, including across concurrent PreAUR processes. With `ephemeral: false`, commands run directly on the root and are serialized.

Because PreAUR installs tools into this root, it must not be a devtools build chroot; roots under `/var/lib/archbuild` are rejected. To use another root or install extra tools:

```yaml
config:
  pkgbuildSandbox:
    root: /srv/preaur/metadata/extra-x86_64
    packages:
      - nodejs
```

The other `pkgbuildSandbox` options are listed in the [config reference](./docs/config-reference.md). For scheduled runs, see [passwordless sudo](#configure-passwordless-sudo-for-group-preaur-build).

Packages can also request package-level pre-build setup inside the chroot. `pre-build-packages` are installed before the package build starts, and `pre-build-scripts` run as root in the chroot before the package build starts:

```yaml
packages:
  - pkgname: "demo"
    pre-build-packages:
      - "custom-tool"
    pre-build-scripts:
      - |
        install -Dm644 /dev/null /etc/demo-prebuild-marker
```

#### Toolchain Options (Clang/LLVM, mold, LTO)

`config.toolchain` sets compiler, linker, and makepkg build options for all packages. A package can override individual fields with its own `toolchain` block. Package fields replace global fields one by one; fields left unset fall back to the global value and then to the chroot's makepkg defaults.

```yaml
config:
  toolchain:
    llvm: true
    lto: thin
    debug: false

packages:
  - pkgname: "fast-thing"
    toolchain:
      mold: replace       # mold for every link, instead of the global llvm's LLD
  - pkgname: "picky-thing"
    toolchain:
      llvm: false         # back to GCC for this package
      lto: default        # and the makepkg LTO policy
```

The fields are `llvm`, `mold`, `lld`, `lto`, `debug` and `stripOnLink`; see the [config reference](./docs/config-reference.md#configtoolchain) for what each one sets. Note that `stripOnLink` produces no debug package, because makepkg splits debug info during its strip step.

Linker modes (`mold` and `lld`; `true` means `driver`):

| Mode | How | Covers |
|---|---|---|
| `driver` | `-fuse-ld=<linker>` in `LDFLAGS` and `-C link-arg=-fuse-ld=<linker>` in `RUSTFLAGS`, plus `LD=ld.<linker>` | Links done through the compiler driver (gcc, clang, rustc via cc) that honor `LDFLAGS`/`RUSTFLAGS` |
| `replace` | `/usr/bin/ld` in the build chroot becomes a symlink to `ld.<linker>`; `LD=ld.<linker>` | Every link, including build systems that run `ld` directly or ignore `LDFLAGS`, like `mold -run` |

`replace` changes only the worker's chroot copy, which devtools resets from the clean root before every build, so it never leaks into other packages. `ld.bfd` stays the real GNU ld, so a PKGBUILD can still opt out with `-fuse-ld=bfd`. Because it also affects packages that call `ld` directly, prefer `driver` globally and use `replace` per package where it is needed.

mold and LLD both accept the GNU ld command line, but neither is a complete replacement: mold supports only a small subset of linker scripts, and both lack some bfd-specific options. Packages with custom linker scripts (kernel modules, bootloaders, firmware, EFI binaries) may need `mold: false` / `lld: false`.

Linker rules checked when the config is loaded (per package, after merging):

- `mold` and `lld` cannot both be enabled. If the global config enables one, a package switching to the other must set the first to `false`.
- `lld` with GCC (no `llvm`) requires `lto: off`, because LLD cannot link GCC's LTO objects and makepkg enables LTO by default.
- `lto: thin` requires `llvm: true`.

How it is applied:

- For each build, PreAUR writes a makepkg.conf drop-in to the package work directory and bind-mounts it read-only into the devtools chroot as `/etc/makepkg.conf.d/zz-preaur-toolchain.conf` (`makechrootpkg -D`). makepkg sources it after `/etc/makepkg.conf` and the devtools drop-ins, so the chroot configuration is never edited.
- Required tools (`clang`, `llvm`, `lld`, `mold`) are installed into the chroot through the same helper package used by `pre-build-packages`. In `replace` mode the helper's install script also creates the `/usr/bin/ld` symlink, before the package's own `pre-build-scripts` run.
- Toolchain options require a devtools `*-build` builder; other builders fail with an error.

Limitations:

- In `driver` mode, build systems that invoke `ld` directly keep GNU ld; use `replace` for those.
- PKGBUILD `options` still take precedence (`!lto`, `!buildflags`, `!strip`, `!debug`), and hardcoded compilers or flags in a PKGBUILD can override these settings.
- `lto` targets C/C++ (`CFLAGS`, `CXXFLAGS`, `LDFLAGS`); it does not configure Rust LTO.
- Changing toolchain options does not by itself trigger a rebuild of package versions that are already built.

#### Build Chroot Storage and Parallel Builds

With `resources.parallel` set to N, PreAUR gives each concurrent devtools build its own chroot copy (`<user>-preaur-worker-1` … `-N` next to `/var/lib/archbuild/<repo>-<arch>/root`; `<user>-preaur-<instance>-worker-N` when `PREAUR_INSTANCE` is set, as `preaur@.service` does, so instances never share a copy). devtools `archbuild` always passes `-c` to `makechrootpkg`, so **every build resets its worker copy from the clean root**. How much I/O that costs depends on the filesystem under `/var/lib/archbuild`:

| Filesystem | How `makechrootpkg` resets the copy | Cost per build |
|---|---|---|
| btrfs, with `root` a subvolume | `btrfs subvolume snapshot` | Near zero (CoW, metadata only) |
| anything else (ext4, xfs, …) | `rsync -a --delete` of the whole root | A full copy of the build root (hundreds of MB, tens of thousands of files) for every build in every worker |

On hosts that build many packages or run several workers, put `/var/lib/archbuild` on btrfs. It does not have to be the root filesystem; a dedicated btrfs partition or a loop-mounted btrfs image works:

```bash
truncate -s 64G /var/lib/archbuild.img
mkfs.btrfs /var/lib/archbuild.img
mkdir -p /var/lib/archbuild
mount -o loop,compress=zstd /var/lib/archbuild.img /var/lib/archbuild
# add a matching /etc/fstab entry to mount it at boot
```

`mkarchroot` creates `root` as a subvolume only when the directory is already on btrfs at creation time. If you move an existing `/var/lib/archbuild` to btrfs, delete its `<repo>-<arch>` directories (for example `sudo rm -rf --one-file-system /var/lib/archbuild/extra-x86_64`) so the next build recreates the root and the worker copies as subvolumes. To check, `stat -c %i /var/lib/archbuild/extra-x86_64/root` should print `256`, and `stat -f -c %T /var/lib/archbuild` should print `btrfs`.

Putting `/var/lib/archbuild` on tmpfs also avoids disk I/O, but every worker copy then takes RAM (roughly N × the root size plus build trees), and the copy itself still happens.

The PKGBUILD metadata sandbox is not affected: it uses `--volatile=overlay` and never copies its root, whatever the filesystem.

#### GitHub Checker Authentication

If you heavily use the `github` checker type, fetching data can be throttled. Put a `GITHUB_TOKEN` into `.env` in the project directory (see [`.env.example`](./.env.example)) to avoid API rate limiting:

```bash
echo 'GITHUB_TOKEN=<your token>' > .env
chmod 600 .env
```

## Usage

Run from the project directory:

```bash
# Process all packages defined in the configuration
preaur

# Process only a specific package
preaur -p some-pkg-bin

# Specify a custom config file
preaur -c custom.config.yaml
```

From a source checkout, use `bun run start` (for example `bun run start -p some-pkg-bin`).

*Built packages and databases will be deposited in the `./repo/<repo.name>/` directory.*

## Deploying & Scheduled Runs

PreAUR is designed with headless in mind. It runs as a dedicated `preaur` system user whose home is `/var/lib/preaur`, with the project directory at `/var/lib/preaur/preaur`, started by a systemd timer.

The AUR packages (`preaur-git`, `preaur-bin`) create the user and ship the systemd units. Without them, the same files are in [`packaging/`](./packaging) of a source checkout.

### Create the preaur User

The AUR packages do this on install with `sysusers.d` and `tmpfiles.d`: they create the group `preaur-build`, the user `preaur` (member of `preaur-build`, home `/var/lib/preaur`, shell bash, no password), its home directory and `/var/lib/preaur/metadata` for the PKGBUILD sandbox chroots. An existing `preaur` user is left unchanged; see [Migrating From /home/preaur](#migrating-from-homepreaur).

Without the package, from a source checkout:

```bash
sudo systemd-sysusers packaging/preaur.sysusers
sudo systemd-tmpfiles --create packaging/preaur.tmpfiles
```

### Configure Passwordless Sudo for group `preaur-build`

The rules are not installed automatically, because they give every member of `preaur-build` root-equivalent access. Run `sudo visudo -f /etc/sudoers.d/preaur` and add them (the AUR packages also ship this as `preaur.sudoers.example` under `/usr/share/doc/`):

```sudoers
Defaults:%preaur-build env_keep += "SOURCE_DATE_EPOCH SRCDEST SRCPKGDEST PKGDEST LOGDEST NPROC MAKEFLAGS PACKAGER GNUPGHOME BUILDTOOL"
%preaur-build ALL=(ALL) NOPASSWD: /usr/bin/extra-x86_64-build, /usr/bin/multilib-build, /usr/bin/pkgctl
%preaur-build ALL=(ALL) NOPASSWD: /usr/bin/systemd-nspawn, /usr/bin/mkarchroot
```

### Set Up the Project Directory

The remaining steps up to the scheduler run as the `preaur` user (`sudo -iu preaur`). Put the project at `~/preaur`, either by cloning your project repository or by creating the directory and writing `preaur.config.yaml` in it:

```bash
git clone <your-project-repo> ~/preaur
```

### Set Up AUR Push (optional)

Packages with `push: true` are pushed to the AUR over SSH. Create a key for the `preaur` user, add the public key to your [AUR account](https://aur.archlinux.org/account), and accept the host key once:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/aur -N ''
printf 'Host aur.archlinux.org\n  User aur\n  IdentityFile ~/.ssh/aur\n' >> ~/.ssh/config
ssh aur@aur.archlinux.org help
```

### Set Up the Scheduler

The units are templates with one instance per project directory below `/var/lib/preaur`: `preaur@extra.timer` starts `preaur@extra.service`, which runs PreAUR in `~preaur/extra`. The default instance is `preaur`, matching `~preaur/preaur`.

The AUR packages install `preaur@.service` and `preaur@.timer` to `/usr/lib/systemd/system/` without enabling them. Without the package, copy them from a source checkout:

```bash
sudo install -Dm644 packaging/preaur@.service packaging/preaur@.timer -t /etc/systemd/system/
```

The service runs PreAUR once as `preaur` in the instance's project directory:

```ini
[Service]
Type=oneshot
User=preaur
Group=preaur
# Keeps chroot worker copies of different instances apart.
Environment=PREAUR_INSTANCE=%i
# "~" is the home directory of User=. systemd only accepts a bare "~" here,
# so env -C moves into the project directory below it.
WorkingDirectory=~
ExecStart=/usr/bin/env -C %i /usr/bin/preaur
```

Do not add `NoNewPrivileges=yes`: PreAUR needs sudo for devtools and systemd-nspawn. Sandboxing options such as `PrivateTmp=` or `ProtectSystem=` can also break chroot builds.

Enable the timer (`preaur@.timer` enables the default instance, `preaur@preaur.timer`), and check runs with `systemctl status 'preaur@*'` and `journalctl -u 'preaur@*'`:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now preaur@.timer
# another project in ~preaur/extra:
sudo systemctl enable --now preaur@extra.timer
```

Each timer runs at 2:00 and 13:00. To change that for one instance, run `sudo systemctl edit preaur@preaur.timer` (or `sudo systemctl edit preaur@.timer` for all of them) and clear the defaults before adding your own:

```ini
[Timer]
OnCalendar=
OnCalendar=*-*-* 4:00:00
```

Instances can run at the same time. Each has its own `repo/`, `data/` and `work/`, and its own devtools chroot copies (`<user>-preaur-<instance>-worker-N`). They share the metadata chroot under `/var/lib/preaur/metadata`, which is locked. If two projects use the same `repo.name`, make sure they do not publish to the same place.

A system unit is used because the timer of a user unit only fires while that user's service manager runs, which for an account nobody logs into requires `loginctl enable-linger preaur`.

### Migrating From /home/preaur

Earlier versions of this guide created `preaur` with `useradd -m`, so its home is `/home/preaur`, and scheduled it with a user unit. That setup keeps working after installing the package: `sysusers.d` does not modify an existing user, and `WorkingDirectory=~` follows the home in `/etc/passwd`. To move to `/var/lib/preaur`:

1. Stop the old schedule and wait until nothing runs as `preaur`:

   ```bash
   sudo systemctl --user -M preaur@ disable --now preaur.timer
   sudo loginctl disable-linger preaur
   pgrep -u preaur   # should print nothing
   ```

   Remove `~preaur/.config/systemd/user/preaur.*`. If you wrote `/etc/systemd/system/preaur.{service,timer}` yourself, disable and remove those as well, or they keep running next to `preaur@preaur.timer`.

2. Optionally delete `~preaur/preaur/work/`; it is recreated on the next run. Back up its build logs first if `logdest` is not configured elsewhere.

3. Copy the home directory and point the user at it. Do not use `usermod -m`: with the PKGBUILD sandbox enabled, `/var/lib/preaur/metadata` already exists and `usermod -m` refuses an existing target.

   ```bash
   sudo systemd-tmpfiles --create /usr/lib/tmpfiles.d/preaur.conf
   sudo rsync -aHAX /home/preaur/ /var/lib/preaur/
   sudo usermod -d /var/lib/preaur preaur
   getent passwd preaur   # the sixth field should be /var/lib/preaur
   ```

4. Look for remaining references to the old path, such as a `file:///home/preaur/...` server in `pacman.conf`, a web server serving the repository, `safe.directory` in `.gitconfig`, `IdentityFile` in `.ssh/config`, or absolute `include` paths in `preaur.config.yaml`:

   ```bash
   sudo grep -rIl /home/preaur /etc /var/lib/preaur --exclude-dir=work --exclude-dir=metadata
   ```

5. Run once by hand, then enable the timer:

   ```bash
   sudo systemctl start preaur@preaur.service && journalctl -u preaur@preaur -e
   sudo systemctl enable --now preaur@.timer
   ```

6. After a few successful runs, delete `/home/preaur`. Until then, `sudo usermod -d /home/preaur preaur` rolls back. The service names its chroot copies `preaur-preaur-preaur-worker-N`, so the old `preaur-preaur-worker-N` copies under `/var/lib/archbuild/<repo>-<arch>/` are no longer used and can be deleted (with `btrfs subvolume delete` if they are subvolumes).

The user keeps its UID; changing it would require re-owning every file for no functional gain.

## Cleaning Outdated Packages

By default PreAUR never deletes package files from the local repository. Set `repo.removeOld` to let `repo-add` delete the previous version when a new one replaces it:

```yaml
repo:
  name: localrepo
  removeOld: true # repo-add -R, roughly `paccache -rk1 -c repo/localrepo`
  removeOrphans: true # repo-remove packages that were removed from the config
```

With `removeOld`, when a newly built package replaces a different version of the same package name in the database, `repo-add -R` deletes the old package file and its `.sig`. Re-adding the exact same version only prints "already existed" and deletes nothing. Also note:

- Packages that are no longer produced (a dropped split package, or the `-debug` package after disabling debug) have no new package of the same name to replace them. After `repo-add`, PreAUR removes them with `repo-remove` when their database `%BASE%` matches the package just built, and deletes their files. If that cleanup fails, it is only logged; the build still counts as successful.
- Files that were already out of the database before you enabled the option are not cleaned up, and neither are entries from a database written without `%BASE%`.
- If a PKGBUILD changes its pkgbase, packages under the old pkgbase are not removed.
- Rolling back to an older version needs a rebuild, because the older package file has already been deleted.

### Packages Removed From the Config

When a package is no longer listed in `packages`, PreAUR always drops its entry from `data/versions.json` (with [project git automation](#project-git-automation) active, committed as `versions: remove <pkgname>`). `data/known_packages` and `data/known_maintainers` are kept, so adding the package back keeps its approval and does not rebuild it if its package file still exists.

With `repo.removeOrphans`, PreAUR also cleans the repository before dropping the entry. Every database entry whose `%BASE%` is the package's pkgbase is removed with `repo-remove`, which covers split packages and the `-debug` package, and their package files and `.sig` files are deleted. If `repo-remove` fails, the entry is kept and the cleanup is retried on the next run. Things to know:

- PreAUR records the pkgbase (`pkgbase`, or the first `pkgname`) in `data/versions.json` when it parses a PKGBUILD. For entries without one, it tries the AUR package name and then the configured `pkgname` as the base; if no database entry matches, it falls back to removing `<pkgname>` and `<pkgname>-debug`.
- Only packages recorded in `data/versions.json` are removed, and nothing whose name or pkgbase belongs to a package still in the config. Packages you put into the repository by hand are never touched.
- Old split package files that are no longer in the database are only deleted if they share a name with a removed entry or a fallback name.
- Entries dropped while `removeOrphans` was off are gone, so enabling it later does not clean those packages; remove them once by hand with `repo-remove` and `rm`.
- Cleanup runs only when there is something to process; a run with no packages, or with `-p` naming a package not in the config, exits before it.

For anything these options do not cover, `paccache -rk1 -c repo/<name>` works on the repository directory, or check out my [archavenger](https://github.com/kobe-koto/archavenger).

## Development

```bash
bun install
bun test            # tests
bun run typecheck   # type-check src/ (Node types only) and test/ (Bun types)
bun run build       # bundle to dist/index.js with esbuild
bun run gen-schema  # regenerate preaur.schema.json, docs/config-reference.md and the man pages
```

### Bun and Node APIs

PreAUR is developed and tested with Bun, but the source in `src/` is plain Node.js code. Many runtimes implement the Node.js API, while their own APIs are not compatible with each other, so sticking to Node APIs keeps PreAUR portable:

- `src/` uses only Node.js APIs (`node:*` modules and web standards such as `fetch`), never `Bun.*`, `bun:*` or Bun-only `import.meta` fields. `tsconfig.json` loads only Node types for `src/`, so `bun run typecheck` fails on Bun-specific APIs.
- `src/` sticks to TypeScript that Node can run by stripping types (`erasableSyntaxOnly`), and relative imports include the `.ts` extension, so `node src/index.ts` works without a build step.
- The build uses esbuild with a Node target, and `build.ts` runs on Node as well.
- Bun-specific APIs are fine in tooling around the source: the tests use `bun:test` and get Bun types from `test/tsconfig.json`.
