# 📦 PreAUR 📦

[English](./README.md) | 简体中文

**PreAUR** 是一个用 TypeScript 编写的 Arch Linux AUR（不止 AUR）软件包自动构建与维护（算是吧）工具。

它把获取、更新、构建和发布软件包的流程串起来，同时自动维护一个本地 pacman 仓库。

## 功能

- **自动更新**：通过上游来源（如 GitHub release）或动态 `pkgver()` 函数检查新版本，并自动更新 `PKGBUILD`。
- **Git 同步**：把 AUR 仓库克隆到 `./pkgbuilds/`，可选通过 SSH 把更新提交并推送回 AUR。
- **干净的 chroot 构建**：交给 `devtools`（如 `extra-x86_64-build` 或 `pkgctl build`）安全地构建软件包，并根据 CPU 配置自动分配 `$MAKEFLAGS`。
- **本地仓库**：自动收集构建出的 `.pkg.tar.zst`，并在 `./repo/` 中维护本地 pacman 数据库（`repo-add`）。
- **智能缓存**：识别已经构建过的相同版本/pkgrel，避免重复编译。

## 快速开始

### 安装

从 AUR 安装：

```bash
paru -S preaur-git # 推荐，因为我喜欢它
paru -S preaur-bin
```

### 配置

PreAUR 需要一个配置文件才能运行。

完整的示例配置请见 [`preaur.config.yaml.example`](./preaur.config.yaml.example)。也可以在文件开头加上这一行来使用配置 schema：

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/kobe-koto/PreAUR/main/preaur.schema.json
```

运行 CLI 之前，先把它复制为 `preaur.config.yaml`：

```bash
cp preaur.config.yaml.example preaur.config.yaml
```

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
          - "Server = file:///home/preaur/repo/$arch"
```

配置了 `chrootPacman` 时，PreAUR 还会让 `makechrootpkg` 更新工作用的 chroot 副本，确保在安装依赖之前同步好自定义仓库的数据库。

#### PKGBUILD 元数据沙箱

PreAUR 默认在软件包构建开始前，把 PKGBUILD 的元数据命令放进 chroot 沙箱里执行，包括 `makepkg --printsrcinfo`、动态 `pkgver()` 更新和 `updpkgsums`。

元数据命令在一个由 PreAUR 管理的专用 chroot root 中运行，与 devtools 的构建 chroot 分开。默认的 root 由构建器推导：`extra-x86_64-build` 对应 `/var/lib/preaur/metadata/extra-x86_64`。

- root 不存在时，PreAUR 用 devtools 的 `mkarchroot` 创建它，使用与构建 chroot 相同的 pacman 和 makepkg 配置。
- 每次 PreAUR 运行时，会在第一条元数据命令之前用 `pacman -Syu` 更新一次 root，并确保已安装 `base-devel`、`git`、`pacman-contrib` 和 `pkgbuildSandbox.packages`。更新使用宿主机的包缓存和 mirrorlist。如果更新失败（例如没有网络），PreAUR 会打印警告并继续使用现有的 root。
- 动态 `pkgver()` 需要的 VCS 客户端（如 `subversion` 或 `mercurial`）会在第一次用到时装进 root，之后的运行会一直保留。

元数据命令本身从不安装软件包。在 `ephemeral: true`（默认）下，每条命令都通过 `systemd-nspawn --volatile=overlay` 运行：root 以只读方式挂载，上面盖一层 tmpfs overlay，所以不会复制任何东西，命令退出后所有改动都会丢弃，在任何文件系统上都是如此。命令执行时会对 root 的锁文件持有共享 `flock`，更新 root 时持有排他锁，因此 root 不会在命令运行中途被修改，多个 PreAUR 进程并发时也一样。在 `ephemeral: false` 下，命令直接在 root 上运行，并且串行执行。

由于 PreAUR 会往这个 root 里安装工具，它不能是 devtools 的构建 chroot，位于 `/var/lib/archbuild` 下的 root 会被拒绝。可以这样显式指定：

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

如果定时运行时使用免密 sudo，除了构建封装脚本，还需要放行沙箱命令和 `mkarchroot`。

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

| 字段 | 取值 | 效果 |
|---|---|---|
| `llvm` | boolean | `CC=clang`、`CXX=clang++`、`AR=llvm-ar`、`RANLIB=llvm-ranlib`、`NM=llvm-nm`，makepkg 用 `llvm-strip` 做 strip。除非设置了 `lld: false` 或 `mold`，否则以 `driver` 模式用 LLD 链接。会安装 `clang` 和 `llvm`。 |
| `mold` | `true`、`driver`、`replace`、`false` | 用 mold 链接（见下方链接器模式）。会安装 `mold`。 |
| `lld` | `true`、`driver`、`replace`、`false` | 用 LLD 链接（见下方链接器模式）。`false` 会关掉 `llvm` 默认附带的 LLD，改用 GNU ld 链接。会安装 `lld`。 |
| `lto` | `default`、`off`、`thin`、`full` | `default` 保持 makepkg 的默认策略。`off` 设置 `!lto` 并移除继承来的 `-flto*` 参数。`thin` 使用 `-flto=thin`，要求 `llvm: true`。`full` 在 LLVM 下使用 `-flto=full`，在 GCC 下使用 `-flto=auto` 并配合 `gcc-ar`/`gcc-ranlib`/`gcc-nm`。 |
| `debug` | boolean | `false` 把 `OPTIONS` 中的 `debug` 换成 `!debug`；`true` 强制开启 `debug`。不设置则保持 chroot 的默认策略。 |
| `stripOnLink` | boolean | 在 `LDFLAGS` 中加入 `-s` 并设置 `!strip`。不会生成 debug 包，因为 makepkg 是在 strip 步骤中拆分调试信息的。 |

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

#### GitHub 来源的认证

如果大量使用 `github` 类型的 checker，获取数据可能会被限流。

请参考 [`.env.example`](./.env.example)。把它复制为 `.env` 并填入 `GITHUB_TOKEN`，以避免 API 限流：

```bash
cp .env.example .env
```

## 使用

运行 PreAUR CLI：

```bash
# 处理配置中的所有软件包
bun run src/index.ts

# 只处理指定的软件包
bun run src/index.ts -p some-pkg-bin

# 指定自定义配置文件
bun run src/index.ts -c custom.config.yaml
```

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
```

### 配置定时任务

**使用 Systemd Timer**

以 system service 的方式运行 PreAUR，并设置 `User=preaur`。如果改用 user unit，还需要执行 `loginctl enable-linger preaur`：timer 只在该用户的 service manager 运行时才会触发，而专用账号平时不会登录。

下面假设 PreAUR 的项目目录是 `~preaur/preaur`。

1. 创建 service 文件：
   `/etc/systemd/system/preaur.service`

   ```ini
   [Unit]
   Description=PreAUR Automated Package Builder
   Wants=network-online.target
   After=network-online.target

   [Service]
   Type=oneshot
   User=preaur
   Group=preaur
   # "~" 是 User= 指定用户的 home 目录。systemd 在这里只接受单独的 "~"，
   # 所以用 env -C 进入其下的项目目录。
   WorkingDirectory=~
   # 如果你是安装的 aur/preaur-{git,bin}, 它应该在这里
   ExecStart=/usr/bin/env -C preaur /usr/bin/preaur
   ```

   不要添加 `NoNewPrivileges=yes`：PreAUR 需要通过 sudo 调用 devtools 和 systemd-nspawn。`PrivateTmp=`、`ProtectSystem=` 等沙箱选项也可能导致 chroot 构建失败。

2. 创建 timer 文件：
   `/etc/systemd/system/preaur.timer`

   ```ini
   [Unit]
   Description=Run PreAUR Daily

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
   sudo systemctl daemon-reload
   sudo systemctl enable --now preaur.timer
   ```

   可以用 `systemctl status preaur` 和 `journalctl -u preaur` 查看运行情况。

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

某个包不再出现在 `packages` 中时，PreAUR 总会从 `data/versions.json` 删除它的条目，并提交为 `versions: remove <pkgname>`。`data/known_packages` 和 `data/known_maintainers` 会保留，所以把包重新加回来时批准状态不变，如果包文件还在也不会重新构建。

开启 `repo.removeOrphans` 后，PreAUR 会在删除条目之前先清理仓库：数据库中 `%BASE%` 等于该包 pkgbase 的所有条目都会通过 `repo-remove` 移除（包括拆分包和 `-debug` 包），并删除对应的包文件和 `.sig`。如果 `repo-remove` 失败，条目会保留，下次运行时重试。注意：

- PreAUR 解析 PKGBUILD 时会把 pkgbase（`pkgbase`，未定义时取第一个 `pkgname`）记录到 `data/versions.json`。没有记录的条目会依次尝试 AUR 包名和配置中的 `pkgname` 作为 base；数据库中没有匹配的条目时，退回到删除 `<pkgname>` 和 `<pkgname>-debug`；
- 只会删除 `data/versions.json` 里记录过的包，并且不会删除名字或 pkgbase 属于配置中现有包的条目。手动放进仓库的包不会被动到；
- 已经不在数据库里的旧拆分包文件，只有在名字与被移除的条目或退回用的名字相同时才会被删除；
- 关闭 `removeOrphans` 期间删除的条目已经不在了，之后再开启也不会清理这些包，需要用 `repo-remove` 和 `rm` 手动清理一次；
- 只有在有包需要处理时才会执行清理；没有任何包，或 `-p` 指定的包不在配置中时，程序会在清理之前退出。

这些选项覆盖不到的情况，可以对仓库目录使用 `paccache -rk1 -c repo/<name>`，或者看看我的 [archavenger](https://github.com/kobe-koto/archavenger)。
