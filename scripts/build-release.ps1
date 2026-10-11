# ============================================================================
# build-release.ps1 — 发布签名构建入口（固定 -BuildMode release -SignMode release）
#                    （工程规划 docs/工程规划-V2.md §6.1 阶段 ④、§8.4、§8.5）
# ----------------------------------------------------------------------------
# 与 debug 的关键差异：
#   1) release 签名的包**无法侧载**（hdc app install 会报 not trusted app source），
#      只能经应用市场分发；本地真机调试请改用 scripts\build-debug.ps1。
#   2) 必须提供 signing.release.local.json（gitignored；样例 signing.release.local.json.sample），
#      其中指向**发布证书 + 发布 Profile**；Profile 内含的权限/profile type 决定了能申请哪些
#      ACL 受限权限（§8.1）。缺失时本脚本直接报错退出，不做「无签名产物」的静默降级。
#   3) 上架产物形态：
#        - HAP（Task=Hap）→ electron\build\default\outputs\default\electron-default-signed.hap
#        - App Pack（Task=App）→ build\outputs\default\*-signed.app（应用市场提交用）
#   4) 上架前还须过 §8.5 合规前置清单（G1 ArkWeb 渲染、G2 图标无 alpha、G5 AI 标识、
#      G6 主体/应用名/包名三一致、G7 versionCode 递增、G10 清理探针与 --inspect 调试开关）。
#
# 前置：先跑 node scripts/collect-runtime.mjs 与 node scripts/build-opencode.mjs，
#       且 node scripts/smoke-node22.mjs 全绿。
#
# 用法（在工程根目录）：
#   pwsh -NoProfile -ExecutionPolicy Bypass -File scripts\build-release.ps1
#   pwsh -NoProfile -ExecutionPolicy Bypass -File scripts\build-release.ps1 -Task App
#   pwsh -NoProfile -ExecutionPolicy Bypass -File scripts\build-release.ps1 -DevEcoHome "D:\Program Files\DevEco Studio"
#   # 其余参数（-SdkHome / -JbrHome / -NodeHome / -Hvigorw）与 -ExtraArgs 之后的所有
#   # 实参原样透传给 build-hap.ps1。
#   （必须用 pwsh 7 运行；本仓库 .ps1 为无 BOM UTF-8，Windows PowerShell 5.1 解码中文字面量会解析失败）
#
# 退出码：透传 build-hap.ps1 / hvigorw 的退出码（非零即失败）。
# ============================================================================

[CmdletBinding()]
param(
    [ValidateSet('Hap', 'App')]
    [string]$Task = 'Hap',

    [string]$DevEcoHome = '',
    [string]$SdkHome    = '',
    [string]$JbrHome    = '',
    [string]$NodeHome   = '',
    [string]$Hvigorw    = '',

    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$ExtraArgs
)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$hapScript = Join-Path $PSScriptRoot 'build-hap.ps1'
if (-not (Test-Path -LiteralPath $hapScript)) {
    throw "未找到 build-hap.ps1：$hapScript"
}

# release 签名材料是硬前置：没有它就只会产出未签名包，不能上架也不能侧载。
$signingRelease = Join-Path $projectRoot 'signing.release.local.json'
if (-not (Test-Path -LiteralPath $signingRelease)) {
    throw "缺少 release 签名材料：$signingRelease（复制 signing.release.local.json.sample 并填入发布证书/Profile；该文件 gitignored）。本地真机调试请改用 scripts\build-debug.ps1。"
}

# 子进程解释器：必须是 pwsh 7。Windows PowerShell 5.1 会把无 BOM 的 UTF-8 脚本按 ANSI 代码页
# 解码，中文字面量会吞掉引号导致解析失败（已实测），因此这里 fail-fast，不做静默回退。
$psCmd = Get-Command pwsh -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $psCmd) {
    throw "未找到 pwsh 7：本仓库 .ps1 为无 BOM UTF-8，Windows PowerShell 5.1 解码中文字面量会解析失败。请安装 PowerShell 7 并用 pwsh 运行本脚本（或给 build-hap.ps1 加 UTF-8 BOM）。"
}
$psExe = $psCmd.Source

$forward = @(
    '-ExecutionPolicy', 'Bypass', '-File', $hapScript,
    '-Task', $Task,
    '-BuildMode', 'release',
    '-SignMode', 'release'
)
if ($DevEcoHome) { $forward += @('-DevEcoHome', $DevEcoHome) }
if ($SdkHome)    { $forward += @('-SdkHome', $SdkHome) }
if ($JbrHome)    { $forward += @('-JbrHome', $JbrHome) }
if ($NodeHome)   { $forward += @('-NodeHome', $NodeHome) }
if ($Hvigorw)    { $forward += @('-Hvigorw', $Hvigorw) }
if ($ExtraArgs)  { $forward += $ExtraArgs }

Write-Host "=== build-release: Task=$Task, BuildMode=release, SignMode=release（发布包不可侧载，仅供市场提交） ===" -ForegroundColor Green
& $psExe @forward
exit $LASTEXITCODE
