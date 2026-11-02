# 📦 PreAUR 📦

English | [简体中文](./README.zh-CN.md)

**PreAUR** is an automated Arch Linux AUR (not only) package builder and maintainer (kinda) written in TypeScript. 

It streamlines the process of fetching, updating, building, and publishing packages, while automatically maintaining a local pacman repository.

## Features

- **Automated Updates**: Checks for new versions via upstream providers (like GitHub releases) or dynamic `pkgver()` functions, and updates your `PKGBUILD` seamlessly.
- **Git Syncing**: Clones AUR repositories (into `./pkgbuilds/`) and optionally commits/pushes updates back to the AUR via SSH.
- **Clean Chroot Building**: Defers to `devtools` (e.g., `extra-x86_64-build` or `pkgctl build`) to build packages safely, intelligently allocating `$MAKEFLAGS` based on your CPU configuration.
- **Local Repository**: Automatically collects built `.pkg.tar.zst` artifacts and maintains a local pacman database (`repo-add`) in `./repo/`.
- **Smart Caching**: Recognizes if a package with the same version/pkgrel has already been built to avoid redundant compilation.

## Getting Started

### Installation

from AUR:

```bash
paru -S preaur-git # Recommended because i like it
paru -S preaur-bin
```

### Configuration

Preaur relies on a configuration file to run. 

Please see the [`preaur.config.yaml.example`](./preaur.config.yaml.example) file for a complete example configuration. You can also use the config schema by prepend this line:

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/kobe-koto/PreAUR/main/preaur.schema.json
```

Ensure you copy this file to `preaur.config.yaml` before running the CLI:

```bash
cp preaur.config.yaml.example preaur.config.yaml
```

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
          - "Server = file:///home/preaur/repo/$arch"
```

When `chrootPacman` is configured, PreAUR also asks `makechrootpkg` to update the working chroot copy so custom repository databases are synced before dependency installation.

#### PKGBUILD Metadata Sandbox

PreAUR runs PKGBUILD metadata commands in a chroot sandbox by default before the package build starts. This covers `makepkg --printsrcinfo`, dynamic `pkgver()` updates, and `updpkgsums`.

Metadata commands run in a dedicated chroot root managed by PreAUR, separate from the devtools build chroot. By default the root is derived from the package builder: `extra-x86_64-build` maps to `/var/lib/preaur/metadata/extra-x86_64`.

- If the root does not exist, PreAUR creates it with devtools `mkarchroot`, using the same pacman and makepkg configuration as the build chroot.
- Once per PreAUR run, before the first metadata command, PreAUR updates the root with `pacman -Syu` and makes sure `base-devel`, `git`, `pacman-contrib`, and `pkgbuildSandbox.packages` are installed. It uses the host package cache and mirrorlist. If the update fails (for example, no network), PreAUR logs a warning and continues with the existing root.
- VCS clients needed by dynamic `pkgver()` (such as `subversion` or `mercurial`) are installed into the root the first time they are needed and are kept for later runs.

Metadata commands themselves never install packages. With `ephemeral: true` (the default), each command runs with `systemd-nspawn --volatile=overlay`: the root is mounted read-only with a tmpfs overlay on top, so nothing is copied and any changes are discarded when the command exits. This works on any filesystem. Commands take a shared `flock` on the root's lock file, and root updates take it exclusively, so the root never changes under a running command, including across concurrent PreAUR processes. With `ephemeral: false`, commands run directly on the root and are serialized.

Because PreAUR installs tools into this root, it must not be a devtools build chroot; roots under `/var/lib/archbuild` are rejected. You can override it explicitly:

```yaml
config:
  pkgbuildSandbox:
    enabled: true
    root: /var/lib/preaur/metadata/extra-x86_64
    command: systemd-nspawn
    sudo: true
    user: preaur
    network: true
    ephemeral: true
    initRoot: true
    packages:
      - nodejs
```

If you use passwordless sudo for scheduled runs, allow the sandbox command and `mkarchroot` as well as the build wrappers.

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

| Field | Values | Effect |
|---|---|---|
| `llvm` | boolean | `CC=clang`, `CXX=clang++`, `AR=llvm-ar`, `RANLIB=llvm-ranlib`, `NM=llvm-nm`, and makepkg strips with `llvm-strip`. Links with LLD in `driver` mode unless `lld: false` or `mold` is set. Installs `clang` and `llvm`. |
| `mold` | `true`, `driver`, `replace`, `false` | Link with mold (see linker modes below). Installs `mold`. |
| `lld` | `true`, `driver`, `replace`, `false` | Link with LLD (see linker modes below). `false` turns off the implicit LLD of `llvm` and links with GNU ld. Installs `lld`. |
| `lto` | `default`, `off`, `thin`, `full` | `default` keeps the makepkg policy. `off` sets `!lto` and removes inherited `-flto*` flags. `thin` uses `-flto=thin` and requires `llvm: true`. `full` uses `-flto=full` with LLVM, or `-flto=auto` plus `gcc-ar`/`gcc-ranlib`/`gcc-nm` with GCC. |
| `debug` | boolean | `false` replaces `debug` with `!debug` in `OPTIONS`; `true` forces `debug`. Unset keeps the chroot policy. |
| `stripOnLink` | boolean | Adds `-s` to `LDFLAGS` and sets `!strip`. No debug package is produced, because makepkg splits debug info during its strip step. |

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

With `resources.parallel` set to N, PreAUR gives each concurrent devtools build its own chroot copy (`<user>-preaur-worker-1` … `-N` next to `/var/lib/archbuild/<repo>-<arch>/root`). devtools `archbuild` always passes `-c` to `makechrootpkg`, so **every build resets its worker copy from the clean root**. How much I/O that costs depends on the filesystem under `/var/lib/archbuild`:

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

#### GitHub Provider Authentication
If you heavily use the `github` checker type, fetching data can be throttled. 

Please see the [`.env.example`](./.env.example) file. Copy it to `.env` and provide your `GITHUB_TOKEN` to prevent API rate limiting:

```bash
cp .env.example .env
```

## Usage

Run the preaur CLI orchestrator:

```bash
# Process all packages defined in the configuration
bun run src/index.ts

# Process only a specific package
bun run src/index.ts -p some-pkg-bin

# Specify a custom config file
bun run src/index.ts -c custom.config.yaml
```

*Built packages and databases will be deposited in the `./repo/<repo.name>/` directory.*

## Deploying & Scheduled Runs

PreAUR is designed with headless in mind.

### Create group preaur-build

```bash
groupadd preaur-build
```

### Configure Passwordless Sudo for group `preaur-build`

Run `sudo visudo` and append your privileges:

```sudoers
Defaults:%preaur-build env_keep += "SOURCE_DATE_EPOCH SRCDEST SRCPKGDEST PKGDEST LOGDEST NPROC MAKEFLAGS PACKAGER GNUPGHOME BUILDTOOL"
%preaur-build ALL=(ALL) NOPASSWD: /usr/bin/extra-x86_64-build, /usr/bin/multilib-build, /usr/bin/pkgctl
%preaur-build ALL=(ALL) NOPASSWD: /usr/bin/systemd-nspawn, /usr/bin/mkarchroot
```

### Create user for PreAUR

```bash
useradd -m -G preaur-build preaur
```

### Set Up the Scheduler

**Using Systemd Timers**

1. Create a service file:
   `~/.config/systemd/user/preaur.service`

   ```ini
   [Unit]
   Description=PreAUR Automated Package Builder
   
   [Service]
   Type=simple
   WorkingDirectory=%h/preaur
   # if you installed aur/preaur-{git,bin}, it should be here
   ExecStart=/usr/bin/preaur
   ```

2. Create a timer file:
   `~/.config/systemd/user/preaur.timer`

   ```ini
   [Unit]
   Description=Run PreAUR Daily
   
   [Timer]
   # daily, 2 a.m.
   OnCalendar=*-*-* 2:00:00
   # daily, 1 p.m.
   OnCalendar=*-*-* 13:00:00
   Persistent=true
   
   [Install]
   WantedBy=timers.target
   ```

3. Enable the timer:

   ```bash
   systemctl --user daemon-reload
   systemctl --user enable --now preaur.timer
   ```

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

When a package is no longer listed in `packages`, PreAUR always drops its entry from `data/versions.json` and commits that as `versions: remove <pkgname>`. `data/known_packages` and `data/known_maintainers` are kept, so adding the package back keeps its approval and does not rebuild it if its package file still exists.

With `repo.removeOrphans`, PreAUR also cleans the repository before dropping the entry. Every database entry whose `%BASE%` is the package's pkgbase is removed with `repo-remove`, which covers split packages and the `-debug` package, and their package files and `.sig` files are deleted. If `repo-remove` fails, the entry is kept and the cleanup is retried on the next run. Things to know:

- PreAUR records the pkgbase (`pkgbase`, or the first `pkgname`) in `data/versions.json` when it parses a PKGBUILD. For entries without one, it tries the AUR package name and then the configured `pkgname` as the base; if no database entry matches, it falls back to removing `<pkgname>` and `<pkgname>-debug`.
- Only packages recorded in `data/versions.json` are removed, and nothing whose name or pkgbase belongs to a package still in the config. Packages you put into the repository by hand are never touched.
- Old split package files that are no longer in the database are only deleted if they share a name with a removed entry or a fallback name.
- Entries dropped while `removeOrphans` was off are gone, so enabling it later does not clean those packages; remove them once by hand with `repo-remove` and `rm`.
- Cleanup runs only when there is something to process; a run with no packages, or with `-p` naming a package not in the config, exits before it.

For anything these options do not cover, `paccache -rk1 -c repo/<name>` works on the repository directory, or check out my [archavenger](https://github.com/kobe-koto/archavenger).
