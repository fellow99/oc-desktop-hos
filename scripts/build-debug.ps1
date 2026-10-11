# ============================================================================
# build-debug.ps1 — 调试签名构建入口（固定 -BuildMode debug -SignMode debug）
#                  （工程规划 docs/工程规划-V2.md §6.4 真机调试循环）
# ----------------------------------------------------------------------------
# 为什么需要本包装：
#   只有 debug 签名的 HAP 才能用 hdc 侧载（release 签名的包安装会报
#   not trusted app source），因此本地真机调试/回归一律走本脚本。
#   签名材料来自 signing.debug.local.json（gitignored；样例 *.sample）；
#   hvigorfile.ts 在 SIGN_MODE=debug 时读取该文件并「仅内存」注入 signingConfigs，
#   绝不写回 build-profile.json5。
#
# 前置：先跑 node scripts/collect-runtime.mjs 与 node scripts/build-opencode.mjs
#       （build-hap.ps1 会给出缺失提示），host 侧门禁 node scripts/smoke-node22.mjs 全绿。
# 用法（在工程根目录）：
#   pwsh -NoProfile -ExecutionPolicy Bypass -File scripts\build-debug.ps1
#   pwsh -NoProfile -ExecutionPolicy Bypass -File scripts\build-debug.ps1 -Task App
#   pwsh -NoProfile -ExecutionPolicy Bypass -File scripts\build-debug.ps1 -DevEcoHome "D:\Program Files\DevEco Studio"
#   （必须用 pwsh 7 运行；本仓库 .ps1 为无 BOM UTF-8，Windows PowerShell 5.1 解码中文字面量会解析失败）
#   # 其余参数（-SdkHome / -JbrHome / -NodeHome / -Hvigorw）与 -ExtraArgs 之后的所有
#   # 实参原样透传给 build-hap.ps1（双横线选项可直接透传；单横线选项如 -p 会被 PowerShell 参数绑定截获）。
#
# 安装（部署前先卸载，清掉 userData 里的旧产物与 marker）：
#   hdc uninstall rg.fellow99.oc.OCDesktop
#   hdc app install -r electron\build\default\outputs\default\electron-default-signed.hap
#   hdc shell aa start -a EntryAbility -b rg.fellow99.oc.OCDesktop
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

$hapScript = Join-Path $PSScriptRoot 'build-hap.ps1'
if (-not (Test-Path -LiteralPath $hapScript)) {
    throw "未找到 build-hap.ps1：$hapScript"
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
    '-BuildMode', 'debug',
    '-SignMode', 'debug'
)
if ($DevEcoHome) { $forward += @('-DevEcoHome', $DevEcoHome) }
if ($SdkHome)    { $forward += @('-SdkHome', $SdkHome) }
if ($JbrHome)    { $forward += @('-JbrHome', $JbrHome) }
if ($NodeHome)   { $forward += @('-NodeHome', $NodeHome) }
if ($Hvigorw)    { $forward += @('-Hvigorw', $Hvigorw) }
if ($ExtraArgs)  { $forward += $ExtraArgs }

Write-Host "=== build-debug: Task=$Task, BuildMode=debug, SignMode=debug（debug 签名才能 hdc app install -r 侧载） ===" -ForegroundColor Green
& $psExe @forward
exit $LASTEXITCODE
