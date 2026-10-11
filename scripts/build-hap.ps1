# ============================================================================
# build-hap.ps1 — 用 DevEco 自带 JBR 构建并签名 HAP / App Pack
#                （工程规划 docs/工程规划-V2.md §6.1 阶段 ④、§6.4、附录 A）
# ----------------------------------------------------------------------------
# 为什么必须用 DevEco 自带 JBR（不要改用系统 Temurin / OpenJDK）：
#   SignHap 阶段由 hap-sign-tool.jar 读取并重写 HAP（zip）。若 PATH 上的 java 是
#   系统 Temurin/OpenJDK，其严格的 ZIP64 extra 字段校验会误报：
#       ERROR 11012006 File IO failed
#       Invalid CEN header (invalid zip64 extra data field size)
#   DevEco 自带 JBR 可正常签名（🔶 沿用 dsh 实测结论，见工程规划 §6.4/附录 A）。
#   因此本脚本把 JBR 的 bin 放到 PATH 最前面，并剔除 PATH 里的其它 JDK，再调用
#   hvigorw —— hvigor 是按 PATH（而非仅 JAVA_HOME）解析 java 的。
#
# 构建前置（本脚本不代跑；缺失会在 hvigorw 或真机上暴露，故这里只做提示）：
#   node scripts/collect-runtime.mjs      # 阶段 ①：运行时 SO / Chromium 资源 / better_sqlite3.node
#   node scripts/build-opencode.mjs       # 阶段 ②：opencode v2 产物 → tar.gz + SHA-256 marker
#   & "<DevEco>\tools\ohpm\bin\ohpm.bat" install   # 依赖（删除 oh_modules 后必须重跑）
#   node scripts/smoke-node22.mjs         # host 侧门禁：必须全绿才允许上真机（§6.4）
#
# 签名材料（证书/口令不在本脚本，也不在 build-profile.json5）：
#   - SIGN_MODE 环境变量由 -SignMode 解析后设置，hvigorw 子进程继承；
#   - hvigorfile.ts 按 SIGN_MODE 读取 signing.<mode>.local.json，并以「仅内存」方式
#     注入 signingConfigs（绝不写盘）：
#       debug   → signing.debug.local.json    （gitignored；样例 *.sample）
#       release → signing.release.local.json  （gitignored；样例 *.sample）
#
# 用法（在工程根目录）：
#   pwsh -NoProfile -ExecutionPolicy Bypass -File scripts\build-hap.ps1
#   pwsh -NoProfile -ExecutionPolicy Bypass -File scripts\build-hap.ps1 -BuildMode release -SignMode release
#   pwsh -NoProfile -ExecutionPolicy Bypass -File scripts\build-hap.ps1 -Task App -BuildMode release -SignMode release
#   pwsh -NoProfile -ExecutionPolicy Bypass -File scripts\build-hap.ps1 -DevEcoHome "D:\Program Files\DevEco Studio"
#   （PowerShell 7 为推荐解释器。Windows PowerShell 5.1 按 ANSI 代码页解码无 BOM 的 UTF-8 脚本，
#     会把本文件的中文字面量解坏并解析失败 —— 用 5.1 跑本脚本前须给本文件加 UTF-8 BOM。）
# 其余参数透传（-ExtraArgs，ValueFromRemainingArguments，均已实测）：
#   - 双横线选项：直接跟在命令后即可透传给 hvigorw
#       pwsh -NoProfile -ExecutionPolicy Bypass -File scripts\build-hap.ps1 --stacktrace --analyze=normal
#   - 单横线选项（如 -p）：会被 PowerShell 自身的参数绑定截获（报「参数名 'p' 不明确」），
#     必须用 -Command + 数组显式传给 -ExtraArgs
#       pwsh -NoProfile -Command "& './scripts/build-hap.ps1' -ExtraArgs @('-p','foo=bar')"
#
# 参数：
#   -Task Hap|App              默认 Hap；App = 应用级 App Pack（assembleApp --mode project，上架用 .app）
#   -BuildMode debug|release   默认 debug
#   -SignMode  debug|release   默认 debug（决定 hvigorfile.ts 注入哪份签名材料）
#   -DevEcoHome <目录>         默认 D:\oh-workspace\DevEco Studio
#   -SdkHome   <sdk 目录>      默认 <DevEcoHome>\sdk
#   -JbrHome   <JBR 根目录>    默认 <DevEcoHome>\jbr（必须是 DevEco 自带 JBR）
#   -NodeHome  <node 目录>     默认 <DevEcoHome>\tools\node
#   -Hvigorw   <hvigorw.bat>   默认 <DevEcoHome>\tools\hvigor\bin\hvigorw.bat
#
# 产物与上真机（Hap 任务）：
#   electron\build\default\outputs\default\electron-default-signed.hap
#     hdc uninstall rg.fellow99.oc.OCDesktop        # 部署前先卸载：清掉 userData 里的旧产物与 marker
#     hdc app install -r electron\build\default\outputs\default\electron-default-signed.hap
#     hdc shell aa start -a EntryAbility -b rg.fellow99.oc.OCDesktop
#     hdc shell "hilog -x | grep oc-desktop"                  # 取证
#     hdc fport tcp:19229 tcp:9229                            # CDP 端口转发（仅 debug 构建）
#   （debug 签名才能侧载；release 签名的包安装会报 not trusted app source）
#
# 退出码：0 = 成功；非零 = 失败。校验缺失直接 throw（fail-visible）；hvigorw 失败原样
#         返回其退出码，绝不把失败当成功继续。
# ============================================================================

[CmdletBinding()]
param(
    [ValidateSet('Hap', 'App')]
    [string]$Task = 'Hap',

    [ValidateSet('debug', 'release')]
    [string]$BuildMode = 'debug',

    [ValidateSet('debug', 'release')]
    [string]$SignMode = 'debug',

    [string]$DevEcoHome = 'D:\oh-workspace\DevEco Studio',
    [string]$SdkHome    = '',
    [string]$JbrHome    = '',
    [string]$NodeHome   = '',
    [string]$Hvigorw    = '',

    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$ExtraArgs
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot

# --- 1. 定位 DevEco 与工具链（缺失即 throw，绝不静默降级） -------------------
if (-not (Test-Path -LiteralPath $DevEcoHome)) {
    throw "DevEco Studio 目录不存在：$DevEcoHome（用 -DevEcoHome 指定实际安装位置）"
}
if (-not $SdkHome)  { $SdkHome  = Join-Path $DevEcoHome 'sdk' }
if (-not $JbrHome)  { $JbrHome  = Join-Path $DevEcoHome 'jbr' }
if (-not $NodeHome) { $NodeHome = Join-Path $DevEcoHome 'tools\node' }
if (-not $Hvigorw) {
    $hvigorCandidates = @(
        (Join-Path $DevEcoHome 'tools\hvigor\bin\hvigorw.bat'),
        (Join-Path $DevEcoHome 'tools\hvigor\bin\hvigorw.cmd')
    )
    $Hvigorw = $hvigorCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if (-not $Hvigorw) { $Hvigorw = $hvigorCandidates[0] }   # 交给下面的存在性校验统一报错
}

$jbrBin  = Join-Path $JbrHome 'bin'
$jbrJava = Join-Path $jbrBin 'java.exe'
$nodeExe = Join-Path $NodeHome 'node.exe'
$hvigorBin = Split-Path -Parent $Hvigorw

if (-not (Test-Path -LiteralPath $jbrJava))  { throw "未找到 DevEco 自带 JBR：$jbrJava（用 -JbrHome 指定；不要用系统 Temurin，会触发 Invalid CEN header）" }
if (-not (Test-Path -LiteralPath $nodeExe))  { throw "未找到 Node：$nodeExe（用 -NodeHome 指定；应为 DevEco 自带 Node）" }
if (-not (Test-Path -LiteralPath $Hvigorw))  { throw "未找到 hvigorw：$Hvigorw（用 -Hvigorw 指定）" }
if (-not (Test-Path -LiteralPath $SdkHome))  { throw "SDK 目录不存在：$SdkHome（用 -SdkHome 或 DEVECO_SDK_HOME 指定）" }

# --- 2. 固定工具链环境（工程规划 §6.4「工具链固定」） ------------------------
# 构建前清空 NODE_OPTIONS：外部注入的 --inspect / loader 会污染 hvigor 内置 Node 行为。
Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
$env:NODE_HOME       = $NodeHome
$env:DEVECO_SDK_HOME = $SdkHome
$env:JAVA_HOME       = $JbrHome
# hvigorfile.ts 据此选择 signing.<mode>.local.json（子进程继承本环境变量）。
$env:SIGN_MODE       = $SignMode

# PATH：JBR 在前，剔除 sdkman / Temurin 等其它 JDK（否则 hap-sign-tool 会误报）。
$kept = ($env:PATH -split ';') | Where-Object {
    $_ -and ($_ -ne $jbrBin) -and ($_ -ne $NodeHome) -and
    ($_ -notlike '*\.sdkman\candidates\java\*') -and ($_ -notlike '*temurin*') -and ($_ -notlike '*\Temurin-*')
}
$env:PATH = (@($jbrBin, $hvigorBin, $NodeHome) + $kept) -join ';'

Write-Host "projectRoot : $projectRoot" -ForegroundColor Cyan
Write-Host "DevEcoHome  : $DevEcoHome" -ForegroundColor Cyan
Write-Host "JBR         : $jbrBin   (java --version 见下)" -ForegroundColor Cyan
Write-Host "Node        : $nodeExe" -ForegroundColor Cyan
Write-Host "hvigorw     : $Hvigorw" -ForegroundColor Cyan
Write-Host "SDK         : $SdkHome" -ForegroundColor Cyan
Write-Host "SIGN_MODE   : $SignMode  (task=$Task, buildMode=$BuildMode)" -ForegroundColor Cyan
& $jbrJava -version

# --- 3. 前置产物提示（本脚本不代跑阶段 ①②；缺失会在 hvigorw 或真机阶段暴露） --
$appResDir = Join-Path $projectRoot 'web_engine\src\main\resources\resfile\resources\app'
$distMarker = Join-Path $appResDir 'opencode-dist.tar.gz'
Write-Host "`n提示：本脚本假定已先执行 'node scripts/collect-runtime.mjs' 与 'node scripts/build-opencode.mjs'" -ForegroundColor Yellow
if (-not (Test-Path -LiteralPath $distMarker)) {
    Write-Warning "未找到 $distMarker —— 请先跑 node scripts/collect-runtime.mjs 与 node scripts/build-opencode.mjs，否则构建出的 HAP 缺运行时/服务端产物。"
}

# --- 4. 组装 hvigor 任务 -----------------------------------------------------
# Hap：模块级包（真机装机/侧载）→ assembleHap --mode module
# App：应用级 App Pack（应用市场提交）→ assembleApp --mode project
if ($Task -eq 'App') {
    $hvigorTask = 'assembleApp'
    $hvigorMode = 'project'
    if ($BuildMode -ne 'release') { Write-Warning "App Pack 用于上架时应使用 -BuildMode release（当前 $BuildMode）。" }
    if ($SignMode -ne 'release')  { Write-Warning "App Pack 用于上架时必须使用 -SignMode release（当前 $SignMode）：调试材料签名的 .app 无法上架，仅供本地验证。" }
} else {
    $hvigorTask = 'assembleHap'
    $hvigorMode = 'module'
}

$hvigorArgs = @(
    $hvigorTask,
    '--mode', $hvigorMode,
    '-p', 'product=default',
    '-p', "buildMode=$BuildMode",
    '--no-daemon'
)
if ($ExtraArgs) { $hvigorArgs += $ExtraArgs }

Write-Host "`n=== hvigorw $($hvigorArgs -join ' ') (task=$Task, buildMode=$BuildMode, signMode=$SignMode) ===" -ForegroundColor Green
& $Hvigorw @hvigorArgs
$exitCode = $LASTEXITCODE
if ($null -eq $exitCode) { $exitCode = 0 }

# --- 5. 汇报产物与退出码 -----------------------------------------------------
if ($Task -eq 'App') {
    $appDir = Join-Path $projectRoot 'build\outputs\default'
    $app = Get-ChildItem -Path $appDir -Filter '*-signed.app' -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($app) {
        $size = [math]::Round($app.Length / 1MB, 1)
        Write-Host "产物：$($app.FullName) ($size MB)" -ForegroundColor Green
    } else {
        Write-Warning "未找到 signed .app：$appDir\*-signed.app"
    }
} else {
    $hap = Join-Path $projectRoot 'electron\build\default\outputs\default\electron-default-signed.hap'
    if (Test-Path -LiteralPath $hap) {
        $size = [math]::Round((Get-Item -LiteralPath $hap).Length / 1MB, 1)
        Write-Host "产物：$hap ($size MB)" -ForegroundColor Green
    } else {
        Write-Warning "未找到 signed HAP：$hap"
    }
}

Write-Host "hvigorw 退出码：$exitCode"
if ($exitCode -ne 0) {
    Write-Host "`n✗ 构建失败（exit $exitCode）：请检查上方 hvigorw 输出；不要继续安装/分发该产物。" -ForegroundColor Red
    exit $exitCode
}
Write-Host "`n✅ 构建成功（exit 0）。安装命令：hdc uninstall rg.fellow99.oc.OCDesktop ; hdc app install -r electron\build\default\outputs\default\electron-default-signed.hap ; hdc shell aa start -a EntryAbility -b rg.fellow99.oc.OCDesktop" -ForegroundColor Green
exit 0
