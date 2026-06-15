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

Clone the repository and install dependencies:

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
   OnCalendar=*-*-* 2:00:00 # daily, 2 a.m.
   OnCalendar=*-*-* 13:00:00 # daily, 1 p.m.
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
