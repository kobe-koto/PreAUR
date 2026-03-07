# 📦 preaur 📦

**PreAUR** is an automated Arch Linux AUR (not only) package builder and maintainer written in TypeScript. 

It streamlines the process of fetching, updating, building, and publishing packages, while automatically maintaining a local pacman repository.

## Features

- **Automated Updates**: Checks for new versions via upstream providers (like GitHub releases) or dynamic `pkgver()` functions, and updates your `PKGBUILD` seamlessly.
- **Git Syncing**: Clones AUR repositories (into `./pkgbuilds/`) and optionally commits/pushes updates back to the AUR via SSH.
- **Clean Chroot Building**: Defers to `devtools` (e.g., `extra-x86_64-build` or `pkgctl build`) to build packages safely, intelligently allocating `$MAKEFLAGS` based on your CPU configuration.
- **Local Repository**: Automatically collects built `.pkg.tar.zst` artifacts and maintains a local pacman database (`repo-add`) in `./repo/`.
- **Smart Caching**: Recognizes if a package with the same version/pkgrel has already been built to avoid redundant compilation.

## Getting Started

### Prerequisites

- [Bun](https://bun.sh/) runtime installed.
- Arch Linux build tools (e.g., `base-devel`, `devtools`).

### Installation

Clone the repository and install dependencies:

```bash
git clone https://github.com/kobe-koto/preaur.git
cd preaur
bun install
```

### Configuration

Preaur relies on a configuration file to run. 

Please see the [`preaur.config.yaml.example`](./preaur.config.yaml.example) file for a complete example configuration. This file controls maintainer info, CPU resource allocation, output repository details, and individual package definitions.

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

## 🛠️ Usage

Run the preaur CLI orchestrator:

```bash
# Process all packages defined in the configuration
bun run src/index.ts

# Process only a specific package
bun run src/index.ts -p fluent-lyrics-bin

# Specify a custom config file
bun run src/index.ts -c custom.config.yaml
```

*Built packages and databases will be deposited in the `./repo/<repo.name>/` directory.*
