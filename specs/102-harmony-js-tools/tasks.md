# 102 — 鸿蒙 JS 工具 任务清单

> **回引:** `spec.md` / `plan.md` ｜ **最后更新:** 2026-10-13
> 里程碑：M1 插件实现 → M2 构建接入 → M3 真机验证。

## M1 插件实现（T01–T04）

### T01 — `oc-plugin-harmony-search` 遍历器
| 项 | 内容 |
|---|---|
| 回引 | FR-tool-011、FR-tool-014、FR-tool-015 |
| 动作 | `plugins/oc-plugin-harmony-search/lib/walk.js`：纯函数 BFS 遍历（跳过表 / 上限 / 容错） |
| 完成判据 | `node --check` 通过；导出可被 Node 直接 import |
| 产出 | `lib/walk.js` |
| 风险 | 上限参数与 host 测试不一致 |

### T02 — `oc-plugin-harmony-search` 工具注册
| 项 | 内容 |
|---|---|
| 回引 | FR-tool-001、FR-tool-004、FR-tool-011、FR-tool-012、FR-tool-013 |
| 动作 | `plugins/oc-plugin-harmony-search/index.js`：`remove("opencode.tool.grep"/"glob")` + `add` 纯 JS 版 |
| 完成判据 | `node --check`；默认导出 `{ id, setup }`；`input` 为纯 JSON Schema |
| 产出 | `index.js`、`package.json`、`README.md` |
| 风险 | id 写错 → 内置工具未被移除（真机 `GET /api/plugin` 可见） |

### T03 — `oc-plugin-harmony-shell` 常驻 shell
| 项 | 内容 |
|---|---|
| 回引 | FR-tool-006、FR-tool-007、FR-tool-008、FR-tool-009、FR-tool-010 |
| 动作 | `plugins/oc-plugin-harmony-shell/index.js`：常驻 `spawn('/system/bin/sh')` + 随机哨兵 + 超时重启 |
| 完成判据 | `node --check`；`spawn` 只出现在 `/system/bin/sh` 一处；无 `cp.exec` |
| 产出 | `index.js`、`package.json`、`README.md` |
| 风险 | R1 哨兵碰撞；R2 就绪判定 |

### T04 — 插件静态断言
| 项 | 内容 |
|---|---|
| 回引 | FR-tool-003、FR-tool-020 |
| 动作 | 对 `plugins/**` 断言：无 `node-pty`/`forkpty`/`openpty`、无 `.node`/`.so`、无 `child_process.exec`、`spawn` 仅 `/system/bin/sh` |
| 完成判据 | 断言脚本对两个插件返回 0；对故意注入的违例返回非 0 |
| 产出 | `scripts/collect-app.mjs` 的断言段 |
| 风险 | 断言过宽会漏掉违例——需含反向用例 |

## M2 构建接入（T05–T07）

### T05 — `scripts/collect-app.mjs`
| 项 | 内容 |
|---|---|
| 回引 | FR-tool-016、FR-tool-020 |
| 动作 | 新增应用层收集阶段：copy `plugins/oc-plugin-*` → `resfile/resources/app/plugins/`，跑 T04 断言与 `node --check` |
| 完成判据 | resfile 内出现两个插件目录；断言输出全绿 |
| 产出 | `scripts/collect-app.mjs` |
| 风险 | 与 `collect-runtime` 的 `APP_KEEP` 白名单冲突（需同步加入 `plugins`） |

### T06 — 启动期物化
| 项 | 内容 |
|---|---|
| 回引 | FR-tool-016、FR-tool-017、FR-tool-018、FR-tool-019 |
| 动作 | `src-main/main.js` 新增阶段：从 resfile 的 `plugins/` copy 到 `<userData>/config/opencode/plugin/`（先清理同名） |
| 完成判据 | 启动日志出现物化条目；应用域目录存在且内容与包内一致 |
| 产出 | `src-main/main.js`（+ `resfile` 镜像） |
| 风险 | copy 失败必须可见（R5） |

### T07 — 流水线接线与文档
| 项 | 内容 |
|---|---|
| 回引 | FR-tool-021 |
| 动作 | 把 `collect-app.mjs` 接入构建说明与 `README.md` 流水线小节；新增 `scripts/test-harmony-plugins.mjs` |
| 完成判据 | 命令可跑；host 测试全绿 |
| 产出 | `README.md`、`scripts/test-harmony-plugins.mjs` |
| 风险 | 文档与脚本不一致 |

## M3 真机验证（T08–T09）

### T08 — 插件在设备上加载
| 项 | 内容 |
|---|---|
| 回引 | FR-tool-019、AC-04、AC-05 |
| 动作 | 部署后取应用域 `GET /api/plugin`；确认两插件 loaded 且非 failed |
| 完成判据 | inventory 命中 |
| 产出 | 接口摘录 |
| 风险 | 配置目录路径不符（U10） |

### T09 — 工具真机实测
| 项 | 内容 |
|---|---|
| 回引 | FR-tool-022、AC-06…AC-09 |
| 动作 | 真实对话触发 `shell`（含 `rc≠0`、stderr、超时）与 `grep`/`glob`（命中/不命中） |
| 完成判据 | 会话 `toolCall`/`toolResult` 齐备；无挂死 |
| 产出 | 会话记录摘录 |
| 风险 | 工具仍挂死 → 回退到「不暴露该工具」并在报告中如实登记 |
