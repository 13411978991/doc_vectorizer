param(
    [string]$Root,
    [string]$OutDir,
    [string]$BuildLabel = ""
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

# Discover the exes dynamically (avoids encoding issues with the Chinese
# name in some PowerShell hosts).
$exeFiles = Get-ChildItem -Path $Root -Filter "*.exe" -File -ErrorAction SilentlyContinue
if ($exeFiles.Count -eq 0) {
    throw "no .exe found in $Root"
}
$mainExe = $exeFiles | Where-Object { $_.Name -notlike "*-ingest-worker*" -and $_.Name -notlike "*-mcp*" } | Select-Object -First 1
$mcpExe  = $exeFiles | Where-Object { $_.Name -like "*-mcp.exe" } | Select-Object -First 1
if (-not $mainExe) { throw "no main 黑洞.exe found" }
$mainBase = [System.IO.Path]::GetFileNameWithoutExtension($mainExe.Name)
Write-Host "Main exe: $($mainExe.Name)"
Write-Host "MCP exe:  $($mcpExe.Name)"

$ts = Get-Date -Format "yyyyMMdd-HHmmss"
$zipPath = Join-Path $OutDir ("sag-{0}{1}.zip" -f $BuildLabel, $ts)
$stageRoot = Split-Path $OutDir -Parent
$stage = Join-Path $stageRoot ("sag-release-stage-{0}" -f $ts)
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Path $stage | Out-Null

# Build the ship-list as plain string-to-string pairs so the loop never
# has to guess whether an entry is a FileInfo or a hashtable.
$shipList = New-Object System.Collections.Generic.List[object]
$shipList.Add([pscustomobject]@{ Name = $mainExe.Name; Src = $mainExe.FullName })

$sidecars = @(
    "$mainBase.native-map.json",
    "$mainBase.migrations.json",
    # .scripts.json is the base64-packed Python + PowerShell helpers
    # (com-extract.ps1, extract-office.py, requirements.txt). The SEA
    # runtime unpacks it into the native-cache directory — it never
    # appears as plaintext on the end user's filesystem.
    "$mainBase.scripts.json",
    ".env.example",
    "mcp-config.json",
    "mcp-config-stdio.json",
    "README.txt"
)
foreach ($s in $sidecars) {
    $p = Join-Path $Root $s
    if (Test-Path $p) { $shipList.Add([pscustomobject]@{ Name = $s; Src = $p }) }
    else { Write-Host "  missing (skip): $s" }
}

# stdio MCP launcher (optional — clients that need stdio)
if ($mcpExe) {
    $mcpBase = [System.IO.Path]::GetFileNameWithoutExtension($mcpExe.Name)
    $shipList.Add([pscustomobject]@{ Name = $mcpExe.Name; Src = $mcpExe.FullName })
    foreach ($s in @("$mcpBase.native-map.json", "$mcpBase.migrations.json")) {
        $p = Join-Path $Root $s
        if (Test-Path $p) { $shipList.Add([pscustomobject]@{ Name = $s; Src = $p }) }
        else { Write-Host "  missing (skip): $s" }
    }
}

$webDist = Join-Path $Root "web\dist"
if (Test-Path $webDist) {
    $shipList.Add([pscustomobject]@{ Name = "web\dist"; Src = $webDist })
} else { Write-Host "  missing (skip): web/dist/" }

# Runtime file-converter scripts (Python + PowerShell) are NO LONGER
# shipped as a sibling `scripts/` directory next to the exe — they are
# base64-packed into <exe>.scripts.json (see build-sea-bundle.mjs) and
# unpacked into the native-cache directory at runtime. Shipping the
# helpers as plain files on disk would expose the decryption flow to
# end users.

Write-Host "Staging:"
foreach ($item in $shipList) {
    $dst = Join-Path $stage $item.Name
    Write-Host "  + $($item.Name)"
    $parent = Split-Path $dst
    if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent | Out-Null }
    if ((Get-Item $item.Src -Force).PSIsContainer) {
        robocopy $item.Src $dst /E /NFL /NDL /NJH /NJS /NP /R:1 /W:1 | Out-Null
    } else {
        Copy-Item -Force $item.Src $dst
    }
}

Write-Host "Compressing -> $zipPath"
[System.IO.Compression.ZipFile]::CreateFromDirectory($stage, $zipPath, [System.IO.Compression.CompressionLevel]::Optimal, $false)
Remove-Item -Recurse -Force $stage
$size = (Get-Item $zipPath).Length
Write-Host ("Done: {0} ({1:N1} MB)" -f $zipPath, ($size / 1MB))