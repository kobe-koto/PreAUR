# 📦 PreAUR 📦

[English](./README.md) | 简体中文

**PreAUR** 是一个用 TypeScript 编写的 Arch Linux AUR（不止 AUR）软件包自动构建与维护（算是吧）工具。

它把获取、更新、构建和发布软件包的流程串起来，同时自动维护一个本地 pacman 仓库。

## 功能

- **自动更新**：通过上游 checker（GitHub release、Debian/APT 与 RPM 仓库，或任意 JSON HTTP API）或动态 `pkgver()` 函数检查新版本，并自动更新 `PKGBUILD`。
- **Git 同步**：把 AUR 仓库克隆到 `./pkgbuilds/`，可选通过 SSH 把更新提交并推送回 AUR。
- **干净的 chroot 构建**：交给 `devtools`（如 `extra-x86_64-build` 或 `pkgctl build`）安全地构建软件包，并根据 `resources.cpu` 设置 `$MAKEFLAGS`。
- **本地仓库**：自动收集构建出的 `.pkg.tar.zst`，并在 `./repo/<repo.name>/` 中维护本地 pacman 数据库（`repo-add`）。
- **智能缓存**：跳过已经构建过相同版本/pkgrel 的包；静态 PKGBUILD 的 git commit 没变时，也不再重新解析。
- **所有权审批**：只构建经你批准的软件包和 AUR 维护者，所有权变化时会要求重新批准。

## 快速开始

### 安装

从 AUR 安装：

```bash
paru -S preaur-git # 推荐，因为我喜欢它
paru -S preaur-bin
```

两者都会提供 `/usr/bin/preaur`、man 手册 `preaur(1)` 和 `preaur-config(5)`，以及配置 schema。

从源码运行（需要 [Bun](https://bun.sh)）：

```bash
git clone https://github.com/kobe-koto/PreAUR.git && cd PreAUR
bun install
bun run start   # 等同于 `preaur`
```

### 配置

PreAUR 以当前目录作为项目目录：从这里读取 `preaur.config.yaml` 和 `.env`，状态（`data/`）、AUR 仓库副本（`pkgbuilds/`）、构建文件（`work/`）、日志（`logs/`）和本地仓库（`repo/`）也都放在这里。请创建一个专用目录，并始终在其中运行 `preaur`：

```bash
mkdir ~/preaur && cd ~/preaur
curl -o preaur.config.yaml https://raw.githubusercontent.com/kobe-koto/PreAUR/main/preaur.config.yaml.example
```

[`preaur.config.yaml.example`](./preaur.config.yaml.example) 是带注释的示例。所有选项见 [docs/config-reference.md](./docs/config-reference.md)（也可以 `man 5 preaur-config`）。示例的第一行通过配置 schema 为编辑器提供补全和校验：

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/kobe-koto/PreAUR/main/preaur.schema.json
```

#### 首次运行：批准软件包和维护者

PreAUR 只构建经你批准、且由经你批准的 AUR 维护者维护的软件包。每次运行时，它会把每个配置的软件包记录到 `data/known_packages`，把它的 AUR 维护者和共同维护者记录到 `data/known_maintainers`。新条目带有 `!!!` 前缀，表示未批准：

```text
# data/known_packages
!!! visual-studio-code-bin # Maintainer: some-aur-user

# data/known_maintainers
!!! some-aur-user # Maintaining: visual-studio-code-bin
```

只要还有未批准的条目，运行就会在构建前以 `Unapproved AUR ownership entries found` 停止。首次运行时这是正常的。检查这些条目，把信任的条目前的 `!!! ` 删掉，再运行一次即可。

当软件包的 AUR 维护者发生变化，或者来源改成自定义 `git` 地址时，它会再次被标记为未批准。

#### 项目 Git 自动化

如果项目目录是一个配置了对应 remote（默认 `origin`）的 git 仓库，PreAUR 会让 `data/` 与远端保持同步。该功能默认开启（`git.enabled: true`）：

- 每次运行前先 fetch，再执行 `git pull --ff-only`。设置 `git.sync.allow_remote_overwrite_local: true` 时改为执行 `git reset --hard <remote>/<branch>`，会丢弃本地改动。
- 运行过程中把 `data/` 的变化（版本、批准列表）提交，结束时推送（`git.push.force` 会加上 `--force`）。

如果目录不是 git 仓库或 remote 不存在，会打印警告并跳过。设置 `git.enabled: false` 可关闭。

#### Chroot Pacman 仓库

`config.chrootPacman` 可以给 devtools chroot 构建追加 pacman 配置片段。PreAUR 会基于所选 devtools 的基础配置生成一份 pacman.conf，并以 `/etc/pacman.conf` 绑定进 chroot。

宿主机上的 include 文件由 PreAUR 读取，并展开到生成的 chroot 配置中：

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

只有生成的 pacman.conf 会被绑定进 chroot，所以 `Server` 必须能在 chroot 内访问（例如 http(s) 地址），宿主机上的 `file://` 路径在 chroot 里是看不到的。要安装 PreAUR 自己构建的包，请使用软件包的 `repo_packages`。

配置了 `chrootPacman` 时，PreAUR 还会让 `makechrootpkg` 更新工作用的 chroot 副本，确保在安装依赖之前同步好自定义仓库的数据库。

#### PKGBUILD 元数据沙箱

PreAUR 默认在软件包构建开始前，把 PKGBUILD 的元数据命令放进 chroot 沙箱里执行，包括 `makepkg --printsrcinfo`、动态 `pkgver()` 更新和 `updpkgsums`。

元数据命令在一个由 PreAUR 管理的专用 chroot root 中运行，与 devtools 的构建 chroot 分开。默认的 root 由构建器推导：`extra-x86_64-build` 对应 `/var/lib/preaur/metadata/extra-x86_64`。

- root 不存在时，PreAUR 用 devtools 的 `mkarchroot` 创建它，使用与构建 chroot 相同的 pacman 和 makepkg 配置。
- 每次 PreAUR 运行时，会在第一条元数据命令之前用 `pacman -Syu` 更新一次 root，并确保已安装 `base-devel`、`git`、`pacman-contrib` 和 `pkgbuildSandbox.packages`。更新使用宿主机的包缓存和 mirrorlist。如果更新失败（例如没有网络），PreAUR 会打印警告并继续使用现有的 root。
- 动态 `pkgver()` 需要的 VCS 客户端（如 `subversion` 或 `mercurial`）会在第一次用到时装进 root，之后的运行会一直保留。

元数据命令本身从不安装软件包。在 `ephemeral: true`（默认）下，每条命令都通过 `systemd-nspawn --volatile=overlay` 运行：root 以只读方式挂载，上面盖一层 tmpfs overlay，所以不会复制任何东西，命令退出后所有改动都会丢弃，在任何文件系统上都是如此。命令执行时会对 root 的锁文件持有共享 `flock`，更新 root 时持有排他锁，因此 root 不会在命令运行中途被修改，多个 PreAUR 进程并发时也一样。在 `ephemeral: false` 下，命令直接在 root 上运行，并且串行执行。

由于 PreAUR 会往这个 root 里安装工具，它不能是 devtools 的构建 chroot，位于 `/var/lib/archbuild` 下的 root 会被拒绝。如需使用其他 root 或安装额外工具：

```yaml
config:
  pkgbuildSandbox:
    root: /srv/preaur/metadata/extra-x86_64
    packages:
      - nodejs
```

`pkgbuildSandbox` 的其他选项见[配置参考](./docs/config-reference.md)。定时运行的设置见[免密 sudo](#为-preaur-build-用户组配置免密-sudo)。

单个软件包也可以要求在 chroot 里做构建前准备。`pre-build-packages` 会在构建开始前安装，`pre-build-scripts` 会在构建开始前以 root 身份在 chroot 中运行：

```yaml
packages:
  - pkgname: "demo"
    pre-build-packages:
      - "custom-tool"
    pre-build-scripts:
      - |
        install -Dm644 /dev/null /etc/demo-prebuild-marker
```

#### 工具链选项（Clang/LLVM、mold、LTO）

`config.toolchain` 为所有软件包设置编译器、链接器和 makepkg 构建选项。单个软件包可以用自己的 `toolchain` 块覆盖其中的字段。软件包里设置的字段逐项覆盖全局字段；没设置的字段沿用全局值，再没有就使用 chroot 中 makepkg 的默认值。

```yaml
config:
  toolchain:
    llvm: true
    lto: thin
    debug: false

packages:
  - pkgname: "fast-thing"
    toolchain:
      mold: replace       # 所有链接都用 mold，替代全局 llvm 默认的 LLD
  - pkgname: "picky-thing"
    toolchain:
      llvm: false         # 这个包改回 GCC
      lto: default        # LTO 也回到 makepkg 的默认策略
```

可用字段为 `llvm`、`mold`、`lld`、`lto`、`debug` 和 `stripOnLink`，各自的具体作用见[配置参考](./docs/config-reference.md#configtoolchain)。注意 `stripOnLink` 不会生成 debug 包，因为 makepkg 是在 strip 步骤中拆分调试信息的。

链接器模式（适用于 `mold` 和 `lld`；`true` 等同于 `driver`）：

| 模式 | 做法 | 影响范围 |
|---|---|---|
| `driver` | 在 `LDFLAGS` 中加 `-fuse-ld=<linker>`，在 `RUSTFLAGS` 中加 `-C link-arg=-fuse-ld=<linker>`，并设置 `LD=ld.<linker>` | 经由编译器驱动（gcc、clang、通过 cc 链接的 rustc）完成、且遵循 `LDFLAGS`/`RUSTFLAGS` 的链接 |
| `replace` | 把构建 chroot 中的 `/usr/bin/ld` 换成指向 `ld.<linker>` 的软链接；设置 `LD=ld.<linker>` | 所有链接，包括直接调用 `ld` 或忽略 `LDFLAGS` 的构建系统，效果类似 `mold -run` |

`replace` 只修改当前 worker 的 chroot 副本，而 devtools 每次构建前都会把副本从干净的 root 重置，所以不会影响其他软件包。`ld.bfd` 仍然是真正的 GNU ld，PKGBUILD 依然可以用 `-fuse-ld=bfd` 退回。由于它也会影响直接调用 `ld` 的软件包，建议全局使用 `driver`，只在需要的软件包上单独使用 `replace`。

mold 和 LLD 都接受 GNU ld 的命令行，但都不是完全的替代品：mold 只支持一小部分 linker script，两者也都缺少一些 bfd 特有的选项。使用自定义 linker script 的软件包（内核模块、引导程序、固件、EFI 程序）可能需要设置 `mold: false` / `lld: false`。

读取配置时会检查的链接器规则（按每个软件包合并全局设置后检查）：

- `mold` 和 `lld` 不能同时启用。如果全局启用了其中一个，某个软件包想换成另一个时，必须把前者设为 `false`。
- 使用 GCC（未开启 `llvm`）时启用 `lld`，必须同时设置 `lto: off`，因为 LLD 无法链接 GCC 的 LTO 目标文件，而 makepkg 默认开启 LTO。
- `lto: thin` 要求 `llvm: true`。

实现方式：

- 每次构建时，PreAUR 把一份 makepkg.conf 配置片段写到软件包的工作目录，并以只读方式绑定挂载到 devtools chroot 的 `/etc/makepkg.conf.d/zz-preaur-toolchain.conf`（`makechrootpkg -D`）。makepkg 会在 `/etc/makepkg.conf` 和 devtools 自带的配置片段之后读取它，所以 chroot 本身的配置从不被修改。
- 所需工具（`clang`、`llvm`、`lld`、`mold`）通过 `pre-build-packages` 所用的同一个辅助包安装进 chroot。在 `replace` 模式下，辅助包的安装脚本还会在软件包自己的 `pre-build-scripts` 运行之前创建 `/usr/bin/ld` 软链接。
- 工具链选项需要 devtools 的 `*-build` 构建器，其他构建器会直接报错。

局限：

- 在 `driver` 模式下，直接调用 `ld` 的构建系统仍然使用 GNU ld；这类情况请用 `replace`。
- PKGBUILD 的 `options` 仍然优先（`!lto`、`!buildflags`、`!strip`、`!debug`），PKGBUILD 中写死的编译器或参数也会覆盖这些设置。
- `lto` 只针对 C/C++（`CFLAGS`、`CXXFLAGS`、`LDFLAGS`），不配置 Rust 的 LTO。
- 只修改工具链选项，不会触发已构建版本的重新构建。

#### 构建 chroot 的存储与并行构建

当 `resources.parallel` 设为 N 时，PreAUR 会给每个并发的 devtools 构建分配独立的 chroot 副本（`<user>-preaur-worker-1` … `-N`，位于 `/var/lib/archbuild/<repo>-<arch>/root` 旁边）。devtools 的 `archbuild` 总是给 `makechrootpkg` 传 `-c`，所以**每次构建都会把 worker 副本从干净的 root 重置一遍**。这会产生多少 I/O，取决于 `/var/lib/archbuild` 所在的文件系统：

| 文件系统 | `makechrootpkg` 如何重置副本 | 每次构建的开销 |
|---|---|---|
| btrfs，且 `root` 是 subvolume | `btrfs subvolume snapshot` | 几乎为零（CoW，只动 metadata） |
| 其他（ext4、xfs 等） | 对整个 root 执行 `rsync -a --delete` | 每个 worker 的每次构建都完整复制一遍构建 root（数百 MB、数万个文件） |

在需要构建大量软件包或运行多个 worker 的机器上，建议把 `/var/lib/archbuild` 放在 btrfs 上。它不必是根文件系统，单独的 btrfs 分区或 loop 挂载的 btrfs 镜像都可以：

```bash
truncate -s 64G /var/lib/archbuild.img
mkfs.btrfs /var/lib/archbuild.img
mkdir -p /var/lib/archbuild
mount -o loop,compress=zstd /var/lib/archbuild.img /var/lib/archbuild
# 再在 /etc/fstab 中添加对应条目，以便开机挂载
```

只有在创建时目录已经位于 btrfs 上，`mkarchroot` 才会把 `root` 建成 subvolume。如果把已有的 `/var/lib/archbuild` 迁移到 btrfs，需要删除其中的 `<repo>-<arch>` 目录（例如 `sudo rm -rf --one-file-system /var/lib/archbuild/extra-x86_64`），让下一次构建把 root 和 worker 副本重新建成 subvolume。检查方法：`stat -c %i /var/lib/archbuild/extra-x86_64/root` 应输出 `256`，`stat -f -c %T /var/lib/archbuild` 应输出 `btrfs`。

把 `/var/lib/archbuild` 放在 tmpfs 上也能避免磁盘 I/O，但每个 worker 副本都会占用内存（大约 N × root 大小，再加上构建目录），而且复制本身依然会发生。

PKGBUILD 元数据沙箱不受影响：它使用 `--volatile=overlay`，无论什么文件系统都不会复制 root。

#### GitHub checker 的认证

如果大量使用 `github` 类型的 checker，获取数据可能会被限流。在项目目录的 `.env` 中写入 `GITHUB_TOKEN`（参考 [`.env.example`](./.env.example)）即可避免 API 限流：

```bash
echo 'GITHUB_TOKEN=<your token>' > .env
chmod 600 .env
```

## 使用

在项目目录中运行：

```bash
# 处理配置中的所有软件包
preaur

# 只处理指定的软件包
preaur -p some-pkg-bin

# 指定自定义配置文件
preaur -c custom.config.yaml
```

从源码运行时使用 `bun run start`（例如 `bun run start -p some-pkg-bin`）。

*构建出的软件包和数据库会放在 `./repo/<repo.name>/` 目录中。*

## 部署与定时运行

PreAUR 在设计时就考虑了无人值守运行。

### 创建 preaur-build 用户组

```bash
groupadd preaur-build
```

### 为 `preaur-build` 用户组配置免密 sudo

运行 `sudo visudo`，追加以下权限：

```sudoers
Defaults:%preaur-build env_keep += "SOURCE_DATE_EPOCH SRCDEST SRCPKGDEST PKGDEST LOGDEST NPROC MAKEFLAGS PACKAGER GNUPGHOME BUILDTOOL"
%preaur-build ALL=(ALL) NOPASSWD: /usr/bin/extra-x86_64-build, /usr/bin/multilib-build, /usr/bin/pkgctl
%preaur-build ALL=(ALL) NOPASSWD: /usr/bin/systemd-nspawn, /usr/bin/mkarchroot
```

### 为 PreAUR 创建用户

```bash
useradd -m -G preaur-build preaur
# 让该用户的 systemd timer 在没有登录会话时也能运行
loginctl enable-linger preaur
```

后续步骤都以 `preaur` 用户身份执行（例如 `sudo -iu preaur`），项目目录为 `~/preaur`。

### 配置 AUR 推送（可选）

设置了 `push: true` 的软件包会通过 SSH 推送到 AUR。为 `preaur` 用户生成密钥，把公钥添加到你的 [AUR 账户](https://aur.archlinux.org/account)，并首次连接一次以接受主机密钥：

```bash
ssh-keygen -t ed25519 -f ~/.ssh/aur -N ''
printf 'Host aur.archlinux.org\n  User aur\n  IdentityFile ~/.ssh/aur\n' >> ~/.ssh/config
ssh aur@aur.archlinux.org help
```

### 配置定时任务

**使用 Systemd Timer**

1. 创建 service 文件：
   `~/.config/systemd/user/preaur.service`

   ```ini
   [Unit]
   Description=PreAUR Automated Package Builder

   [Service]
   Type=simple
   WorkingDirectory=%h/preaur
   # 如果你是安装的 aur/preaur-{git,bin}, 它应该在这里
   ExecStart=/usr/bin/preaur
   ```

2. 创建 timer 文件：
   `~/.config/systemd/user/preaur.timer`

   ```ini
   [Unit]
   Description=Run PreAUR twice a day

   [Timer]
   # 每天凌晨 2 点
   OnCalendar=*-*-* 2:00:00
   # 每天下午 1 点
   OnCalendar=*-*-* 13:00:00
   Persistent=true

   [Install]
   WantedBy=timers.target
   ```

3. 启用 timer：

   ```bash
   systemctl --user daemon-reload
   systemctl --user enable --now preaur.timer
   ```

## 清理过时的软件包

默认情况下，PreAUR 不会删除本地仓库里的任何包文件。设置 `repo.removeOld` 后，新版本入库时 `repo-add` 会删除被替换的旧版本：

```yaml
repo:
  name: localrepo
  removeOld: true # repo-add -R，约等于 `paccache -rk1 -c repo/localrepo`
  removeOrphans: true # 对从配置中移除的包执行 repo-remove
```

开启 `removeOld` 后，如果新构建的包替换了数据库中同名但版本不同的包，`repo-add -R` 会删除旧的包文件和对应的 `.sig`。重新添加完全相同的版本只会提示 "already existed"，不会删除文件。另外：

- 不再产出的包（例如去掉的拆分包、关闭 debug 后的 `-debug` 包）没有同名新包来替换。`repo-add` 之后，如果这些包在数据库中的 `%BASE%` 与刚构建的包相同，PreAUR 会用 `repo-remove` 移除它们并删除文件。这一步失败时只会记录日志，构建仍然算作成功；
- 开启前就已经脱离数据库的旧文件不会被清理，没有 `%BASE%` 字段的数据库条目也不会；
- 如果 PKGBUILD 更改了 pkgbase，旧 pkgbase 下的包不会被移除；
- 回滚到旧版本需要重新构建，因为旧的包文件已经被删除。

### 从配置中移除的包

某个包不再出现在 `packages` 中时，PreAUR 总会从 `data/versions.json` 删除它的条目（启用[项目 Git 自动化](#项目-git-自动化)时提交为 `versions: remove <pkgname>`）。`data/known_packages` 和 `data/known_maintainers` 会保留，所以把包重新加回来时批准状态不变，如果包文件还在也不会重新构建。

开启 `repo.removeOrphans` 后，PreAUR 会在删除条目之前先清理仓库：数据库中 `%BASE%` 等于该包 pkgbase 的所有条目都会通过 `repo-remove` 移除（包括拆分包和 `-debug` 包），并删除对应的包文件和 `.sig`。如果 `repo-remove` 失败，条目会保留，下次运行时重试。注意：

- PreAUR 解析 PKGBUILD 时会把 pkgbase（`pkgbase`，未定义时取第一个 `pkgname`）记录到 `data/versions.json`。没有记录的条目会依次尝试 AUR 包名和配置中的 `pkgname` 作为 base；数据库中没有匹配的条目时，退回到删除 `<pkgname>` 和 `<pkgname>-debug`；
- 只会删除 `data/versions.json` 里记录过的包，并且不会删除名字或 pkgbase 属于配置中现有包的条目。手动放进仓库的包不会被动到；
- 已经不在数据库里的旧拆分包文件，只有在名字与被移除的条目或退回用的名字相同时才会被删除；
- 关闭 `removeOrphans` 期间删除的条目已经不在了，之后再开启也不会清理这些包，需要用 `repo-remove` 和 `rm` 手动清理一次；
- 只有在有包需要处理时才会执行清理；没有任何包，或 `-p` 指定的包不在配置中时，程序会在清理之前退出。

这些选项覆盖不到的情况，可以对仓库目录使用 `paccache -rk1 -c repo/<name>`，或者看看我的 [archavenger](https://github.com/kobe-koto/archavenger)。

## 开发

```bash
bun install
bun test            # 运行测试
bun run typecheck   # 类型检查 src/（仅 Node 类型）和 test/（Bun 类型）
bun run build       # 用 esbuild 打包到 dist/index.js
bun run gen-schema  # 重新生成 preaur.schema.json、docs/config-reference.md 和 man 手册
```

### Bun 与 Node API

PreAUR 使用 Bun 开发和测试，但 `src/` 中的源码是纯 Node.js 代码。许多运行时都兼容 Node.js API，而它们各自的专有 API 彼此并不兼容，因此只使用 Node API 能让 PreAUR 保持可移植：

- `src/` 只使用 Node.js API（`node:*` 模块，以及 `fetch` 等 Web 标准），不使用 `Bun.*`、`bun:*` 或 Bun 专有的 `import.meta` 字段。`tsconfig.json` 为 `src/` 只加载 Node 类型，用到 Bun 专有 API 时 `bun run typecheck` 会报错。
- `src/` 只使用 Node 能通过类型擦除直接运行的 TypeScript 语法（`erasableSyntaxOnly`），相对导入都带 `.ts` 扩展名，因此无需构建即可 `node src/index.ts`。
- 构建使用面向 Node 的 esbuild，`build.ts` 本身也能在 Node 上运行。
- 源码之外的工具可以使用 Bun 专有 API：测试使用 `bun:test`，并通过 `test/tsconfig.json` 获得 Bun 类型。
