# boot-guard.ps1 — guarded boot for DeepSeek Harness (Windows).
#
# Snapshots every profile, starts the harness, health-checks it, and on failure
# kills the tree, rolls back to the last good snapshot and retries once.
# On first-attempt failure it also writes an incident report + pending marker
# (the guard plugin then auto-triggers analysis in the next session).
#
# Wire it into your launcher so the harness starts through this script:
#   powershell -NoProfile -ExecutionPolicy Bypass -File boot-guard.ps1
#
# Two launch shapes are auto-detected:
#   * desktop shell — "<HarnessRoot>\DeepSeek Harness.exe" (the exe IS the app;
#     there is no `dsh web` subcommand). The shell serves on port 19387 and
#     answers 401 on / until the URL carries its token, which still counts as
#     a live server.
#   * web flavour  — "<HarnessRoot>\node_modules\.bin\dsh.cmd" web (port 3080).
# Override either with $env:DSH_GUARD_LAUNCH (an executable path) and
# $env:DSH_GUARD_ROOT / $env:DSH_GUARD_PORT / $env:DSH_GUARD_PROFILE /
# $env:DSH_GUARD_NODE.
#
# On success the script stays attached to the server tree (Wait-Process), so
# launchers that kill the tree on window close keep their close-to-quit
# semantics; launchers that detach keep the server resident.
#
# ASCII only: runs with Windows PowerShell 5.1 (no BOM).

param(
    [int]$FirstWaitSec = 60,
    [int]$RetryWaitSec = 30,
    [int]$Port = 0,               # 0 = probe 19387 / 3080
    [string]$Profile = "",        # "" = detect (desktop first)
    [string]$HarnessRoot = "",
    [string]$ServerArgs = "",
    [int]$RenderSettleSec = 20,
    [int]$RenderConfirmSec = 90
)

$ErrorActionPreference = "Continue"

# Force UTF-8 end-to-end for log files. Windows PowerShell 5.1's
# Add-Content/Set-Content default to the system ANSI code page (GBK on zh-CN)
# and decode native-child stdout with the console codepage, so Chinese in the
# guard CLI output becomes mojibake in the logs and incident reports. Pinning
# both sides to UTF-8 keeps every log valid UTF-8. The script file itself
# stays ASCII (PS 5.1 parses it as ANSI), only the log output is UTF-8.
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch {}

# --- Harness root: climb from this script until the shell or a dsh.cmd shows up.
# The package may be installed under profiles\<p>\node_modules\dsh-maid-guard
# (desktop), under the harness root, or in a linked dev checkout.
if (-not $HarnessRoot -and $env:DSH_GUARD_ROOT -and (Test-Path $env:DSH_GUARD_ROOT)) {
    $HarnessRoot = $env:DSH_GUARD_ROOT
}
if (-not $HarnessRoot) {
    $d = $PSScriptRoot
    for ($i = 0; $i -lt 8 -and $d; $i++) {
        if ((Test-Path (Join-Path $d "DeepSeek Harness.exe")) -or (Test-Path (Join-Path $d "node_modules\.bin\dsh.cmd"))) { $HarnessRoot = $d; break }
        $parent = Split-Path -Parent $d
        if (-not $parent -or $parent -eq $d) { break }
        $d = $parent
    }
}
if (-not $HarnessRoot) { $HarnessRoot = Split-Path -Parent $PSScriptRoot }
$HarnessRoot = $HarnessRoot.Trim().TrimEnd([char]34, [char]39, [char]92)  # strip stray quote/trailing slash

# --- DSH home: the desktop shell uses %USERPROFILE%\.dsh, the web flavour
# defaults to <root>\.dsh-home.
if (-not $env:DSH_HOME -or $env:DSH_HOME.Trim() -eq "") {
    $userHome = Join-Path $env:USERPROFILE ".dsh"
    if (Test-Path $userHome) { $env:DSH_HOME = $userHome } else { $env:DSH_HOME = Join-Path $HarnessRoot ".dsh-home" }
}

# --- Profile: explicit wins, then DSH_GUARD_PROFILE, then desktop, then web.
if (-not $Profile -or $Profile.Trim() -eq "") {
    if ($env:DSH_GUARD_PROFILE) { $Profile = $env:DSH_GUARD_PROFILE }
    elseif (Test-Path (Join-Path $env:DSH_HOME "profiles\desktop")) { $Profile = "desktop" }
    elseif (Test-Path (Join-Path $env:DSH_HOME "profiles\web")) { $Profile = "web" }
    else { $Profile = "desktop" }
}

# --- Node: prefer an explicit path, then a PATH lookup, then the bundled runtime.
function Resolve-Node {
    if ($env:DSH_GUARD_NODE -and (Test-Path $env:DSH_GUARD_NODE)) { return $env:DSH_GUARD_NODE }
    $onPath = Get-Command node -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }
    foreach ($rel in @(
        "resources\runtime\primary-runtime\dependencies\node\bin\node.exe",
        "resources\runtime\dsh-primary-runtime\dependencies\node\bin\node.exe")) {
        $cand = Join-Path $HarnessRoot $rel
        if (Test-Path $cand) { return $cand }
    }
    return "node"
}
$nodeExe = Resolve-Node

# --- Ports: desktop serves 19387, the web flavour served 3080. Probe instead
# of assuming, because the shell picks its port at launch.
$script:Ports = @()
if ($env:DSH_GUARD_PORT) { $script:Ports += [int]$env:DSH_GUARD_PORT }
if ($Port -gt 0) { $script:Ports += $Port }
$script:Ports += 19387
$script:Ports += 3080
$script:Ports = @($script:Ports | Select-Object -Unique)
$script:LivePort = 0

# Locate the guard CLI shipped inside the installed package.
$cliNames = @("dsh-maid-guard", "dsh-plugin-guard")
$cli = ""
foreach ($n in $cliNames) {
    foreach ($cand in @(
        (Join-Path $env:DSH_HOME ("profiles\" + $Profile + "\node_modules\" + $n + "\scripts\guard-cli.js")),
        (Join-Path $HarnessRoot ("node_modules\" + $n + "\scripts\guard-cli.js")))) {
        if (Test-Path $cand) { $cli = $cand; break }
    }
    if ($cli) { break }
}

$logDir = Join-Path $env:DSH_HOME "guard\logs"
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$bootLog = Join-Path $logDir ("boot-" + $stamp + ".log")
$serverOut = Join-Path $logDir ("server-" + $stamp + ".out.log")
$serverErr = Join-Path $logDir ("server-" + $stamp + ".err.log")
$statusFile = Join-Path $logDir "last-boot.txt"

function Log([string]$msg) {
    Add-Content -Path $bootLog -Value ("[{0}] {1}" -f (Get-Date -Format "HH:mm:ss"), $msg) -Encoding UTF8
}
function Set-Status([string]$status, [string]$note) {
    ("{0} {1} {2} {3}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $status, $note, "(log: $stamp)") |
        Set-Content -Path $statusFile -Encoding UTF8
}
function Test-PortHealth([int]$p) {
    # The desktop shell answers 401 on / until the URL carries its token; a 401
    # still proves the server is alive, so any 2xx-4xx counts. Invoke-WebRequest
    # throws on 401, so read the status off the exception too.
    try {
        $r = Invoke-WebRequest -Uri ("http://127.0.0.1:$p/") -TimeoutSec 3 -UseBasicParsing
        $code = [int]$r.StatusCode
    } catch {
        $resp = $_.Exception.Response
        if ($null -eq $resp) { return $false }
        try { $code = [int]$resp.StatusCode } catch { return $false }
    }
    return ($code -ge 200 -and $code -lt 500)
}
function Test-Health {
    foreach ($p in $script:Ports) {
        if (Test-PortHealth $p) { $script:LivePort = $p; return $true }
    }
    $script:LivePort = $script:Ports[0]
    return $false
}
function Test-HarnessShell {
    # True when the desktop shell (not `dsh web`) is the launch target present
    # in this root.
    return (Test-Path (Join-Path $HarnessRoot "DeepSeek Harness.exe"))
}
function Invoke-Guard([string[]]$cliArgs) {
    if (-not $cli) { Log "  [guard] CLI not found; skipping $($cliArgs -join ' ')"; return "" }
    $out = & $nodeExe $cli @cliArgs 2>&1 | Out-String
    if ($out) { foreach ($line in ($out -split "`r?`n")) { if ($line.Trim()) { Log ("  [guard] " + $line.Trim()) } } }
    return $out
}
function Is-Alive([System.Diagnostics.Process]$p) {
    if ($null -eq $p) { return $false }
    try { $p.Refresh() } catch {}
    return (-not $p.HasExited)
}
function Wait-Healthy([int]$seconds, [System.Diagnostics.Process]$proc) {
    # Returns "ok" (healthy), "crashed" (the server process already exited, so
    # roll back immediately instead of waiting out the timeout), or "timeout"
    # (still running but never became healthy within $seconds).
    # The crash branch requires BOTH an unhealthy check AND a dead process, so
    # a server that hands off to a detached healthy child is never rolled back.
    $deadline = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-Health) { return "ok" }
        if (-not (Is-Alive $proc)) { return "crashed" }
        Start-Sleep -Milliseconds 250
    }
    return "timeout"
}
function Start-Server([string]$outLog, [string]$errLog) {
    # Three launch shapes, in priority order: an explicit $env:DSH_GUARD_LAUNCH
    # exe, the desktop shell exe in the harness root, or the cli/web flavour.
    $exeOverride = $env:DSH_GUARD_LAUNCH
    if ($exeOverride -and (Test-Path $exeOverride)) {
        $file = $exeOverride
        $argList = @()
    } elseif (Test-HarnessShell) {
        $file = Join-Path $HarnessRoot "DeepSeek Harness.exe"
        $argList = @()
    } else {
        $dshCmd = Join-Path $HarnessRoot "node_modules\.bin\dsh.cmd"
        if (-not (Test-Path $dshCmd)) { $dshCmd = "dsh.cmd" }
        $file = "cmd.exe"
        $argList = @('/d', '/s', '/c', ('"' + $dshCmd + '" web'))
    }
    if ($ServerArgs.Trim() -ne "") { $argList = $argList + ($ServerArgs.Trim() -split '\s+') }
    $p = Start-Process -FilePath $file `
        -ArgumentList $argList `
        -WorkingDirectory $HarnessRoot `
        -RedirectStandardOutput $outLog `
        -RedirectStandardError $errLog `
        -WindowStyle Hidden `
        -PassThru
    return $p
}
function Stop-ServerTree($p) {
    if ($p -and -not $p.HasExited) {
        try { & taskkill /PID $p.Id /T /F 2>&1 | Out-Null } catch {}
        try { $p.Kill() } catch {}
    }
}

function Test-RenderReady([int]$seconds) {
    # After HTTP is up, confirm the web client actually rendered. The guard
    # client POSTs /guard/api/booted on a successful root mount and
    # /guard/api/render-error on a root render crash (rc.7 "page opens but
    # black screen with an error"). HTTP / alone cannot tell these apart.
    # - JSON with renderError true  -> "rendercrash" (roll back)
    # - JSON with booted true       -> "ok" (client really rendered)
    # - JSON with booted false      -> keep polling (client not rendered yet)
    # - non-JSON response (the webServer catch-all serves the SPA HTML for
    #      unmatched paths)         -> "ok": the guard endpoint is not mounted
    #      (old guard / not installed) -> HTTP-only, old behavior
    # - deadline reached            -> "unconfirmed" (no heartbeat, no crash:
    #      the app may be stuck on a boot screen without reporting a root
    #      error; the caller decides how to treat the ambiguity)
    $deadline = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $deadline) {
        $resp = $null
        try {
            $resp = Invoke-WebRequest -Uri ("http://127.0.0.1:" + $script:LivePort + "/guard/api/render-error") -TimeoutSec 2 -UseBasicParsing
        } catch {
            $status = $_.Exception.Response.StatusCode
            if ($status -eq [System.Net.HttpStatusCode]::NotFound) { return "ok" }
            # 401 (desktop shell without a token), busy, or still booting: keep polling
        }
        if ($resp) {
            $parsed = $null
            try { $parsed = $resp.Content | ConvertFrom-Json } catch { $parsed = $null }
            $hasSignal = ($null -ne $parsed) -and (
                ($parsed.PSObject.Properties.Name -contains 'renderError') -or
                ($parsed.PSObject.Properties.Name -contains 'booted'))
            if (-not $hasSignal) { return "ok" }  # not the guard endpoint (HTML fallback / old guard)
            if ($parsed.renderError) { return "rendercrash" }
            if ($parsed.booted) { return "ok" }
        }
        Start-Sleep -Milliseconds 500
    }
    return "unconfirmed"
}

function Confirm-RenderReady {
    # Two-phase render confirmation. Phase 1 is a short settle; if it yields
    # nothing, phase 2 waits much longer because the launcher (launch.vbs)
    # opens the browser only AFTER the server answers — so a healthy render can
    # legitimately arrive tens of seconds after HTTP 200.
    # Returns "ok" | "rendercrash" | "unconfirmed".
    # -RenderSettleSec 0 disables the render check (headless/server-only boots).
    if ($RenderSettleSec -le 0) { return "ok" }
    $r = Test-RenderReady $RenderSettleSec
    if ($r -ne "unconfirmed") { return $r }
    if ($RenderConfirmSec -le 0) { return "unconfirmed" }
    Log ("client readiness unconfirmed after " + $RenderSettleSec + " s; extending " + $RenderConfirmSec + " s for the launcher to open the page")
    return Test-RenderReady $RenderConfirmSec
}

Log "=== boot guard start ==="
Log ("root=" + $HarnessRoot + " profile=" + $Profile + " ports=" + ($script:Ports -join ",") + " shape=" + $(if (Test-HarnessShell) { "desktop-shell" } else { "cli-web" }))
if (Test-Health) { Log ("already healthy on port " + $script:LivePort); Set-Status "OK" "already-running"; exit 0 }

$null = Invoke-Guard @("snapshot", "--tag", "pre-boot", "--reason", "automatic snapshot before boot")

$proc = Start-Server $serverOut $serverErr
Log "started server (pid $($proc.Id))"
$boot = Wait-Healthy $FirstWaitSec $proc
if ($boot -eq "ok") {
    # HTTP is up; confirm the web client actually rendered (rc.7 black-screen /
    # stuck-boot detection). A render crash or a never-ready client rolls back
    # just like a dead server.
    $render = Confirm-RenderReady
    if ($render -eq "ok") {
        Log "boot ok on first attempt"
        Set-Status "OK" "first-attempt"
        Wait-Process -Id $proc.Id
        Log "server tree exited; boot guard done"
        exit 0
    }
    if ($render -eq "rendercrash") {
        Log "client render crash detected; stopping and rolling back"
    } else {
        Log "client readiness unconfirmed after up to $($RenderSettleSec + $RenderConfirmSec) s (no render heartbeat, no render crash) - treating as failed and rolling back"
    }
    $boot = "rendercrash"
} else {
    Log "server not healthy ($boot) after up to $FirstWaitSec s; stopping and rolling back"
}
Stop-ServerTree $proc

$null = Invoke-Guard @("rollback", "--good")

$proc2 = Start-Server $serverOut $serverErr
Log "restarted server (pid $($proc2.Id))"
$retry = Wait-Healthy $RetryWaitSec $proc2
if ($retry -eq "ok") {
    $retryRender = Confirm-RenderReady
    if ($retryRender -ne "ok") { $retry = "rendercrash" }
}
if ($retry -eq "ok") {
    Set-Status "OK" "rolled-back-retry"
} else {
    Stop-ServerTree $proc2
    Set-Status "FAILED" ("boot-failed (" + $retry + ")")
    Log "rollback did not fix the boot; diagnosing the offending plugin for quarantine"
    $diag = Invoke-Guard @("quarantine", "--diagnose")
    $culprit = ""
    foreach ($line in ($diag -split "`r?`n")) {
        if ($line -match '^CULPRIT=(\S+)$') { $culprit = $Matches[1] }
    }
    if ($culprit -ne "" -and $culprit -ne "NONE") {
        Log "culprit plugin identified: $culprit - disabling it and booting without it"
        $null = Invoke-Guard @("quarantine", "--plugin", $culprit)
        $proc3 = Start-Server $serverOut $serverErr
        Log "restarted server without $culprit (pid $($proc3.Id))"
        $qBoot = Wait-Healthy $RetryWaitSec $proc3
        if ($qBoot -eq "ok") {
            $qRender = Confirm-RenderReady
            if ($qRender -ne "ok") { $qBoot = "rendercrash" }
        }
        if ($qBoot -eq "ok") {
            Log "boot ok after quarantining $culprit"
            Set-Status "QUARANTINED" ("$culprit 与当前 DSH 不兼容: 回滚无法解决, 已禁用并正常启动")
            Wait-Process -Id $proc3.Id
            Log "server tree exited; boot guard done (plugin quarantined)"
            exit 0
        }
        Stop-ServerTree $proc3
        Set-Status "FAILED" ("boot-failed-after-quarantine (" + $qBoot + ")")
        Log "still not healthy after quarantining $culprit"
    } else {
        Log "no quarantineable plugin identified from the boot logs; keeping the failure report"
    }
}

$null = Invoke-Guard @("incident", "--kind", "boot-failure")

if ($retry -eq "ok") { Wait-Process -Id $proc2.Id; Log "server tree exited; boot guard done"; exit 0 }
exit 1
