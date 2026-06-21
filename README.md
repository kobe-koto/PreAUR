# 📦 PreAUR 📦

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

The sandbox uses `systemd-nspawn --ephemeral` by default, so each metadata command runs in a temporary copy of the selected chroot root and that copy is discarded when the command exits.

If the selected chroot root does not exist, PreAUR runs the package builder against a generated safe package so the devtools wrapper can initialize the root before metadata commands run.

PreAUR automatically installs `pacman-contrib` and `git` in the temporary copy before running `updpkgsums`. If metadata commands need extra tools, add them to `pkgbuildSandbox.packages`; they are installed in the temporary copy only.

By default, the sandbox root is derived from the package builder. For example, `extra-x86_64-build` maps to `/var/lib/archbuild/extra-x86_64/root`. You can override it explicitly:

```yaml
config:
  pkgbuildSandbox:
    enabled: true
    root: /var/lib/archbuild/extra-x86_64/root
    command: systemd-nspawn
    sudo: true
    user: preaur
    network: true
    ephemeral: true
    initRoot: true
    packages:
      - git
```

If you use passwordless sudo for scheduled runs, allow the sandbox command as well as the build wrappers.

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
%preaur-build ALL=(ALL) NOPASSWD: /usr/bin/systemd-nspawn
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
   Type=oneshot
   WorkingDirectory=%h/preaur
   ExecStart=/usr/bin/bun run src/index.ts
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

PreAUR hasn't implemented this feature and likely never will, because removing outdated packages is not the builder's job. 

You can check out my [archavenger](https://github.com/kobe-koto/archavenger), however.
