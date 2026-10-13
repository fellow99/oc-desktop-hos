# 103 — 品牌化 任务清单

> **回引:** `spec.md` / `plan.md` ｜ **最后更新:** 2026-10-13 ｜ 里程碑：M1 脚本与素材 → M2 接流水线 → M3 真机验证

## M1 脚本与素材（T01–T04）

### T01 — PNG 工具（读写 / 缩放 / 去 alpha）
| 项 | 内容 |
|---|---|
| 回引 | FR-brand-009、FR-brand-011 |
| 动作 | `scripts/lib/branding.mjs`：最小 PNG 解码（需支持 8bit RGB/RGBA/调色板+alpha）、双线性缩放、去 alpha 转 RGB、PNG 编码 |
| 完成判据 | 对父工程 3 个物料可往返读写；去 alpha 后 `colorType=2`；同输入两次输出字节一致 |
| 产出 | `scripts/lib/branding.mjs` |
| 风险 | 调色板 PNG 解码不全 → 对无法处理的 PNG 必须硬失败（不静默） |

### T02 — 生成包内图标
| 项 | 内容 |
|---|---|
| 回引 | FR-brand-008、FR-brand-009、FR-brand-011、FR-brand-012 |
| 动作 | 生成/替换 `AppScope/.../media/{app_icon,icon,startIcon,product_logo_32,window_icon}.png` 与 `runtime-overlays/electron/.../media/{app_icon,startIcon}.png` |
| 完成判据 | 尺寸正确；应用级无 alpha；窗口图标保留 alpha；幂等（AC-10） |
| 产出 | 7 个 PNG + overlay 目录 |
| 风险 | R5：32² 缩放质量 |

### T03 — 归档变换
| 项 | 内容 |
|---|---|
| 回引 | FR-brand-001…FR-brand-007 |
| 动作 | `transformArchive()`：解码归档 → 文本资产品牌替换（含保护清单跳过）+ `<title>`/manifest 兜底 + 内联 Logo 替换 + 二进制资产整文件替换（favicon / apple-touch-icon / PWA 192/512）→ 重编码 |
| 完成判据 | 变换后条目数不变；解压后文件可解析；断言（T04）全绿 |
| 产出 | `scripts/lib/branding.mjs` 的变换段 |
| 风险 | R1/R3 |

### T04 — 断言脚本
| 项 | 内容 |
|---|---|
| 回引 | FR-brand-003、FR-brand-004 |
| 动作 | `scripts/verify-branding.mjs <archive.bin>`：§3 的 7 条断言，非零退出即失败 |
| 完成判据 | 对**变换前**归档返回非零（证明确实有可改之处）；对变换后返回 0 |
| 产出 | `scripts/verify-branding.mjs` |
| 风险 | 断言过宽会假绿灯——必须含「变换前必失败」的自证 |

## M2 接流水线（T05–T07）

### T05 — 接入 `collect-opencode.mjs`
| 项 | 内容 |
|---|---|
| 回引 | FR-brand-004 |
| 动作 | 在归档产出后、投放 resfile 前调用品牌化 + 断言；失败即中止 |
| 完成判据 | 构建输出出现品牌化日志与断言全绿 |
| 产出 | `scripts/collect-opencode.mjs` |
| 风险 | 与 `--no-app-copy` 等参数交互 |

### T06 — overlay 与守卫
| 项 | 内容 |
|---|---|
| 回引 | FR-brand-008、FR-brand-012 |
| 动作 | `collect-runtime.mjs`：`OVERLAY_FILES` 增 electron 模块 media 两项；图标守卫由「纯色占位」改为「与物料生成物 md5 一致」 |
| 完成判据 | 阶段 10 守卫全绿；模块级图标与物料一致 |
| 产出 | `scripts/collect-runtime.mjs`、`runtime-overlays/README.md` |
| 风险 | R7 |

### T07 — 壳侧显示名与文档
| 项 | 内容 |
|---|---|
| 回引 | FR-brand-006、FR-brand-016 |
| 动作 | 修正 `module_desc` 等仍以 `opencode` 指称本应用的文案；同步 `README.md` |
| 完成判据 | `grep -rn "opencode 桌面端"` 无命中 |
| 产出 | `string.json`（base/en_US/zh_CN）、`README.md` |
| 风险 | 与 overlay 白名单一致性 |

## M3 真机验证（T08）

### T08 — 真机品牌与不回归
| 项 | 内容 |
|---|---|
| 回引 | FR-brand-014、AC-04、AC-11、AC-12 |
| 动作 | 部署后取 `document.title`、首屏品牌区、应用图标；跑一次对话确认不回归 |
| 完成判据 | 标题为 `OC Desktop`；图标为新物料；对话正常 |
| 产出 | 截图 + 会话记录 |
| 风险 | R2 |
