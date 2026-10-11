# toybox 命令清单（设备可用 / 不可用）

> **版本**：v0.1（首版）｜ **日期**：2026-10-11 ｜ **适用工程**：`oc-desktop-hos`
> **事实来源**：同型工程 `dsh-desktop-hos` 在真机上的**逐条探测**（🔶 沿用）。
> **证据口径**：✅ **实测**（含来源设备）｜🔶 **沿用**（同型工程记录，本工程未复现）｜⬜ **待验证**（本工程必须复验）。
> ⚠️ **本文件中的全部设备结论均为 🔶 沿用 + ⬜ 本工程待复验**：设备（`3QC0226526001227` / 系统与 toybox 版本 / applet 集合）都可能与本工程目标机不同，**不得**当作本工程已实测。

| 项 | 来源设备（dsh 真机） | 本工程 |
|---|---|---|
| 设备 / 系统 | `3QC0226526001227` / HarmonyOS 6.1.0.135（**API 24**）/ 2in1 | ⬜ 待记录（`docs/真机验证记录.md`） |
| `toybox` 版本 | **`toybox 0.8.12`** | ⬜ 待复验 |
| `/system/bin/sh` | **mksh R59**（`@(#)MIRBSD KSH R59 2020/10/31`），**不是** toysh | ⬜ 待复验 |
| 探测日期 | 2026-09-22 | ⬜ |

## 1. 结论速览

| 类别 | 数量 | 含义 | 能否直接敲命令名 |
|---|---|---|---|
| **A 类 · 真 toybox** | **166** | 软链 → `toybox`、applet 已编译、**且不被 shell 拦截** | ✅ 可（跑的是 toybox） |
| **A 类 · 被 shell 抢先** | **11** | 同为 toybox 软链，但 **mksh 内建 / 保留字抢先** | ⚠️ 可，但跑的是 **mksh 的实现**（要 toybox 须写 `toybox <n>`） |
| **B 类 · 只能 `toybox <n>`** | **1** | applet 已编译，**没有软链** | ❌ 直接敲 → not found |
| **悬空软链（坏）** | **42** | 软链 → `toybox`，但 applet **未编译** | ❌ 报 `toybox: Unknown command` |
| **非 toybox 软链** | **4** | 软链 → **别的系统程序**（`begetctl` / `fsck.f2fs`） | ⚠️ 会真的执行那个程序（含 `reboot`） |
| 裸名不存在 | 4 | `type` 报 not found | ❌ |
| （合计）编译进 toybox | **178** | `toybox` 无参输出的 applet 数 | — |

**一句话**：**166 个可直接当 toybox 用；11 个名字会落到 mksh 自己的实现；只有 `nc` 必须写 `toybox nc`；另有 42 个软链是坏的、4 个软链指向别的程序（危险）。**

## 2. 可用命令（A 类）

### 2.1 对 opencode v2 最相关的一组（本工程重点）

| 命令 | 类别 | 在 v2 里的用途 |
|---|---|---|
| `sh`（`/system/bin/sh`） | 系统二进制（mksh R59，**非** toybox） | shell 工具的执行后端（常驻单进程 + 哨兵行） |
| `ls` `cat` `head` `tail` `wc` `od` `xxd` `stat` `basename` `dirname` `realpath`(mksh) | A | 文件查看与元数据 |
| `grep` `sed` `awk` `cut` `sort` `uniq` `tr` `diff` `printf` | A | 文本处理与校验（`printf` / `ls` / `grep` / `sed` **不在**内建遮蔽之列） |
| `find` `xargs` | A | 文件发现与批处理 |
| `cp` `mv` `rm` `mkdir` `rmdir` `touch` `ln` `link` `readlink` `truncate` `split` | A | 文件变更（⚠️ `ln` 无 `-s` 的硬链接会被平台拒；见 §8） |
| `tar` `gzip` `gunzip` `zcat` `base64` `md5sum` `sha256sum` `cksum` `crc32` | A | 打包、压缩与校验 |
| `env` `id` `uname` `date` `which` `getconf` | A | 环境与诊断 |
| `ps` `kill`(mksh) `killall` `pkill` `pgrep` `timeout` `nohup` `setsid` `renice` | A | 进程管理（⚠️ 无 PTY、退出不可观测，见 §9） |
| `chmod` `chown` `chgrp` | A（存在） | ⚠️ **存在但语义受限**：应用域 `chmod` 静默不落实（hmdfs），需回读校验 |
| `timeout` | A | 可作为命令级超时的补充手段 |

### 2.2 全量分组（🔶 沿用，⬜ 本工程复验）

- **文件与目录（34）**：`basename` `cat`(mksh) `cmp` `comm` `cp` `cpio` `dd` `df` `dirname` `du` `file` `find` `install` `link` `ln` `ls` `lsattr` `mkdir` `mkfifo` `mknod` `mktemp` `mv` `readlink` `realpath`(mksh) `rm` `rmdir` `shred` `split` `stat` `tar` `touch` `truncate` `unlink` `xargs`
- **文本处理（31）**：`awk` `cat`(mksh) `cut` `diff` `dos2unix` `echo`(mksh) `egrep` `expand` `fgrep` `fmt` `grep` `head` `hexedit` `iconv` `more` `nl` `od` `paste` `patch` `printf` `rev` `sed` `sort` `strings` `tac` `tail` `tr` `uniq` `unix2dos` `wc` `xxd`
- **进程与作业（19）**：`iotop` `ipcs` `kill`(mksh) `killall` `lsof` `nice` `nohup` `nsenter` `pgrep` `pidof` `pkill` `prlimit` `ps` `renice` `setsid` `taskset` `time`(mksh) `timeout` `top`
- **系统信息与配置（17）**：`chroot` `date` `dmesg` `env` `free` `groups` `hostname` `id` `logname` `printenv` `sysctl` `uname` `uptime` `vmstat` `which` `who` `whoami`
- **网络（6）**：`ftpget` `ftpput` `ifconfig` `netstat` `ping` `ping6`
- **硬件 / I²C / 内核模块（4）**：`insmod` `lsmod` `reset` `rmmod`
- **终端与其它（4）**：`clear` `help` `tty` `watch`
- **其它（63）**：`base64` `cal` `chcon` `chgrp` `chmod` `chown` `chvt` `cksum` `count` `crc32` `expr` `factor` `fallocate` `false`(mksh) `flock` `freeramdisk` `fstype` `fsync` `getconf` `getfattr` `gunzip` `gzip` `inotifyd` `lspci` `lsusb` `mcookie` `md5sum` `mkpasswd` `mkswap` `mount` `mountpoint` `netcat` `nproc` `pwd`(mksh) `pwdx` `readahead` `route` `seq` `setfattr` `sha1sum` `sha256sum` `sha384sum` `sha512sum` `sleep`(mksh) `swapoff` `swapon` `sync` `tee` `telnet` `test`(mksh) `traceroute` `traceroute6` `true`(mksh) `ulimit`(mksh) `umount` `usleep` `uudecode` `uuencode` `uuidgen` `w` `wget` `yes` `zcat`

> **与上游默认构建的差异（重要）**：OpenHarmony 上游默认 `toybox_extended_cmd = false`，据此会推断 `awk` / `wget` / `diff` / `expr` / `tr` / `telnet` / `traceroute` / `traceroute6` / `getfattr` / `ipcs` 「未编译」。**来源设备上该开关已启用**，上述命令**全部已编译、软链齐全、可直接使用**。⇒ 本工程 MUST 用真机实测（`toybox <n> --help`）判定，**不得**照抄上游默认值（⬜）。

## 3. B 类：applet 已编译但没有软链（1 个）

裸名会 `not found`，必须写 `toybox <n>`。

| 名字 | 正确用法 | 说明 |
|---|---|---|
| `nc` | `toybox nc` | TCP/UDP 工具；`readlink /system/bin/nc` → 空，`type nc` → `not found`，但 `toybox nc --help` 正常 |

## 4. 悬空软链：看起来有、其实是坏的（42 个）

这些名字在 `/system/bin` 里**是软链**且 `readlink` 明确指向 `toybox`，但该 applet **没编译进二进制** ⇒ 执行得到 `toybox: Unknown command <n>`。

> ⚠️ **判定可用性必须用 `toybox <n> --help`**；用 `ls` 或 `command -v` 会误判为可用。

`acpi` `arch` `ascii` `blockdev` `bunzip2` `bzcat` `chattr` `chrt` `devmem` `dnsdomainname` `eject` `fsfreeze` `halt` `hwclock` `i2cdetect` `i2cdump` `i2cget` `i2cset` `ionice` `iorenice` `killall5` `logger` `login` `losetup` `makedevs` `microcom` `mix` `modinfo` `nbd-client` `oneit` `partprobe` `passwd` `pivot_root` `pmap` `poweroff` `rfkill` `sendevent` `sntp` `switch_root` `tunctl` `unshare` `vconfig`

## 5. 非 toybox 软链：指向别的系统程序（4 个）

| 名字 | `readlink` 目标 | 备注 |
|---|---|---|
| `reboot` | `begetctl` | ⚠️ **真实系统服务控制程序**：来源设备的探测过程中**确实重启了设备** |
| `service_control` | `begetctl` | ⚠️ 同上 |
| `resize.f2fs` | `fsck.f2fs` | 文件系统检查家族 |
| `sload.f2fs` | `fsck.f2fs` | 同上 |

> **安全禁令**：**不得**对未知的 `/system/bin` 二进制传任意参数做「探测」。来源设备的首轮探测即因为对 `reboot` 传了一个不存在的 flag 而重启设备。安全的探测方式是 `readlink` + `toybox <n> --help`。

## 6. mksh 的两层「遮蔽」（极易踩坑）

| 层 | 内容 | 后果 |
|---|---|---|
| **恒等 alias** | 约 **130 条**（`alias cat=cat`、`alias ls=ls` …） | 用 `command -v <n>` 判定路径会拿到 **alias 字符串**而不是路径 ⇒ 判路径请用 `type` / `whence -v` / `ls -l`；`which`（toybox applet）不走 alias 表，两者结论不同，别混用 |
| **真内建 / 保留字** | **只有 11 个**：内建 `cat` `echo` `false` `kill` `pwd` `realpath` `sleep` `test` `true` `ulimit` + 保留字 `time` | 裸名跑的是 **mksh 的实现**；要 toybox 实现须写 `toybox <n>` |

> ⚠️ **更正过的一条**：`printf` **不在**内建遮蔽之列（`unalias printf; type printf` → `tracked alias for /bin/printf`，即走 PATH 上的 toybox）；`ls` / `grep` / `sed` 同理**不是**内建。

## 7. shell 身份与「会骗人的探针」

| 探针 | 结果 | 可否用于判定 |
|---|---|---|
| `KSH_VERSION` | `@(#)MIRBSD KSH R59 2020/10/31` | ✅ **决定性** |
| `md5sum /system/bin/sh` vs `md5sum /system/bin/toybox` | `5b5e8eb9…` vs `19f83712…`（**不同**） | ✅ 可用 |
| `readlink /system/bin/sh` | 空 ⇒ `sh` 是**普通文件**，不是软链 | ✅ 可用 |
| `readlink /proc/self/exe` | 报 `/system/bin/toybox` | ❌ **会骗人，勿用** |
| `uname -a` 结尾 | `…aarch64 Toybox` | ❌ 内核 build-time utsname 字符串，与当前 shell 无关 |

**结论（🔶 沿用）**：来源设备的 `/system/bin/sh` = **mksh R59**。因此 opencode 的 shell 工具后端是 **mksh**，脚本不得使用 bash 专有语法（数组、`[[ ]]` 的扩展、`${var^^}` 等）与 bash 专有内建。

## 8. 不可用 / 受限的命令

### 8.1 整体不存在

`bash`、`busybox`、**GNU coreutils 全家**、`git`、`rg`、`curl`、`vi`、`man`、`strace`、`bc`、`fdisk`、`fsck`、`crond`，以及 §4 的 42 个悬空名字（含 `restorecon` `pivot_root` `switch_root` 等）。

### 8.2 存在但语义受限（不是「能不能跑」的问题，而是「跑不出预期结果」）

| 命令 | 限制 | 本工程处置 |
|---|---|---|
| `chmod` / `chown` | 应用域：`hmdfs` 上**不报错但不落实**（请求 `600/644/640` → 回读恒 `660`；`755` → `770`）；`hmfs` 如实生效。shell 域下 `chmod 640` 生效 | 写入后**回读校验**，不一致即报错（`specs/012-data-dirs-sqlite/`） |
| `ln -s`（软链） | 应用域 `EACCES`（`13900012`）；**shell 域成功** | 一律 **copy 物化**；不依赖软链 |
| `ln`（硬链） | **两个域都被拒**（`hmdfs` 无 `.link` 处理器） | 原子写只走 `rename` |
| `mount` / `umount` / `swapon` / `mkswap` / `insmod` / `rmmod` / `reboot` 等 | 无 root / 无权限；`reboot` 指向 `begetctl`（**会真的重启**） | 在工具层列入默认拒绝名单（`specs/010-tool-shell/` FR-010-035 同类项） |
| 交互式程序（`top` `watch` `more` `vi` 类） | **无 PTY、无 TTY**（平台级不可用） | 不承诺；工具描述引导使用非交互形式 |

### 8.3 与 opencode v2 依赖的对应关系

| v2 侧依赖 | 设备上的现实 | 本工程处置 |
|---|---|---|
| `bash` / shell 工具 | 有 `/system/bin/sh`（mksh R59）+ toybox，**无 bash** | 非 PTY 常驻单 shell + 哨兵行；命令语义按 mksh + toybox 披露 |
| 内容搜索（`rg` 下载 + 执行 / `fff` FFI） | 无 `rg`；运行时下载物是 aarch64 glibc ELF，且用户目录不可 exec、ELF 需二进制证书；`fff` 需 Node 26 的 FFI | v1 明示降级（空结果 + 可见提示）；Phase 2 纯 JS 走查变体 |
| `git` 集成 / VCS | **无 `git`** | v1 不做；Phase 2 评估纯 JS 方案 |
| 产物解压（tar.gz） | 有 `tar` / `gzip` / `gunzip`（toybox） | 解压由宿主 Node（`zlib` + 自建流式解压）负责，`tar`/`gzip` 仅作诊断手段 |
| LSP / formatter / MCP 外部进程 | 设备无对应工具链 | v1 明示不可用 |

## 9. 复现步骤（安全版）

```bash
# ① 编译集与版本（不执行未知二进制）
hdc shell toybox                 # → applet 名单（来源设备为 178）
hdc shell "toybox --version"     # → toybox 0.8.12

# ② 软链真相（安全，不执行）
hdc shell "readlink /system/bin/cat"      # → toybox        （A 类）
hdc shell "readlink /system/bin/nc"       # → 空            （B 类）
hdc shell "readlink /system/bin/acpi"     # → toybox 但未编译（悬空）
hdc shell "readlink /system/bin/reboot"   # → begetctl      （不是 toybox！勿执行）

# ③ applet 是否可调度
hdc shell "toybox awk --help | head -1"   # 有输出 ⇒ 已编译

# ④ 是否被 shell 抢先（必须先 unalias）
hdc shell "sh -c 'unalias cat; type cat'"
hdc shell "sh -c 'unalias printf; type printf'"

# ⑤ shell 身份裁定
hdc shell "sh -c 'echo \$KSH_VERSION'"; hdc shell "md5sum /system/bin/sh /system/bin/toybox"
```

> ⚠️ 以上命令在 **`sh` 域**执行；`/data/service/hnp` 等路径在该域可能被 SELinux 隐藏 ⇒ 凡涉及**应用可访问性**的结论 MUST 在应用域（`--inspect` / 宿主日志）复核。

## 10. 本工程复验清单（⬜）

| # | 待复验项 | 方式 | 结论落点 |
|---|---|---|---|
| ⬜-1 | `toybox --version` 与 applet 总数（来源设备为 0.8.12 / 178） | 真机 | `docs/真机验证记录.md` |
| ⬜-2 | A 类集合是否一致（166 直连 + 11 被 mksh 抢先） | `readlink` + `unalias` + `type` 批量探测 | 同上 |
| ⬜-3 | `toybox_extended_cmd` 类命令（`awk` `wget` `diff` `expr` `tr` `telnet` `traceroute` `getfattr` `ipcs`）是否已编译 | `toybox <n> --help` | 同上 |
| ⬜-4 | B 类是否只有 `nc` | 批量 `readlink` + `toybox <n> --help` | 同上 |
| ⬜-5 | 悬空软链集合（来源设备 42 个） | 批量判定 | 同上 |
| ⬜-6 | 非 toybox 软链集合（来源设备 4 个，含 `reboot` → `begetctl`） | `readlink` | 同上 |
| ⬜-7 | mksh 内建 / 保留字集合（来源设备 10 + `time`） | `unalias` 后 `type` | 同上 |
| ⬜-8 | `/system/bin/sh` 身份（md5 + `KSH_VERSION`） | 真机 md5 比对 | 同上 |
| ⬜-9 | `PATH` 中真实存在的目录（来源设备：`/usr/local/bin`、`/usr/bin`、`/data/app/bin` 不存在） | 应用域 `process.env.PATH` + `existsSync` | 同上 |
| ⬜-10 | `/data/service/hnp/bin` 是否可访问（**必须应用域观测**） | 应用域 `existsSync` + 结构校验 | 同上 |

## 11. 引用

- `docs/工程规划-V2.md` §5.3（PATH 与绝对路径规则）、§7.3（能力缺口与降级）、§7.4（内容搜索与 PTY 专项）、§7.1（bash 与文件类工具验收）。
- `docs/鸿蒙环境能力清单.md` #18（可用命令集）、#5/#6/#7（`symlink` / `hardlink` / `chmod`）、#3（PTY）、#4（用户目录 ELF 不可执行）。
- `specs/010-tool-shell/` —— 命令执行契约与能力披露要求（FR-010-032 ~ FR-010-035）。
- 外部来源（转述，非本工程实测）：`dsh-desktop-hos/docs/toybox命令清单.md`（真机逐条探测，2026-09-22；含原始数据文件 `logs/20260922-1/toybox-probe/` 与复现脚本），以及 OpenHarmony `third_party_toybox` / `third_party_mksh` 的构建事实。
