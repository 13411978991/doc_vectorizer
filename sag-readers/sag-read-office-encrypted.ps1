# sag-read-office-encrypted.ps1 — Office COM decryption fallback reader.
#
# Handles .docx / .pptx / .xlsx / .doc / .ppt / .xls files that the
# pure-Python readers can't open because they're encrypted (SafeNetLOCK,
# 奇安信, 深信服 DLP, etc.). It uses Office or WPS via COM automation
# to open the file, save it as a temporary unencrypted copy, then
# extract text from that copy.
#
# Implements the SAG reader protocol (see SPEC.md).
#
# Required: Office (Word / Excel / PowerPoint) or WPS installed on the
# machine. If neither is present, exits 2 so the exe can try the next
# reader in the chain.

# P3 — see sag_com-reader-arg-binding-20260918.md. The previous version
# declared `[Parameter(...)] [string]$Args` (PS's reserved automatic
# variable, which silently captures NOTHING because PowerShell identifier
# matching is case-insensitive and `$args` is special) and `[switch]$Probe`
# (PS 5.1 cannot bind `--probe` to a switch — it tries to parse `--probe`
# as `-probe` + `-e`, which errors with "A parameter cannot be found that
# matches parameter name '-e'"). Together those bugs meant the reader was
# unreachable from the Node side: every invocation exited 1 with no
# useful stderr. Fix: parse args by hand from the automatic `$args`
# variable, no `[switch]` parameters at all.

$InputPath = $null
$Probe = $false
$Meta = $false

foreach ($a in $args) {
    switch -Regex ($a) {
        '^--meta$' { $Meta = $true }
        '^--probe$' { $Probe = $true }
        default { if (-not $InputPath) { $InputPath = $a } }
    }
}

$ErrorActionPreference = "Stop"

$EXTENSIONS = @(".docx", ".pptx", ".xlsx", ".doc", ".ppt", ".xls")
$EXIT_OK = 0
$EXIT_UNSUPPORTED = 2

function Send-Meta {
    $meta = @{
        name        = "sag-read-office-encrypted"
        version     = "1.0.0"
        extensions  = $EXTENSIONS
        languages   = @("zh", "en", "ja", "ko")
        timeoutMs   = 600000
        needs       = @("powershell", "office-or-wps", "com-automation")
        maxBytes    = 524288000
    } | ConvertTo-Json -Compress
    [Console]::Out.WriteLine($meta)
}

function Test-Probe([string]$path) {
    if (-not (Test-Path -LiteralPath $path)) { return 1 }
    $ext = [System.IO.Path]::GetExtension($path).ToLower()
    if ($EXTENSIONS -notcontains $ext) { return 1 }
    return 0
}

function Get-ComApp([string]$ext) {
    # Pick the COM ProgID by extension. Try Office first, then WPS as
    # fallback. We don't blindly fall back to WPS because some corp
    # environments have ONLY WPS — and vice versa.
    switch -Regex ($ext) {
        '^\.(docx?|doc)$' {
            $candidates = @("Word.Application", "KWPS.Application")
        }
        '^\.(pptx?|ppt)$' {
            $candidates = @("PowerPoint.Application", "KWPP.Application")
        }
        '^\.(xlsx?|xls)$' {
            $candidates = @("Excel.Application", "KET.Application")
        }
        default { return $null }
    }
    foreach ($prog in $candidates) {
        try {
            $app = New-Object -ComObject $prog -ErrorAction Stop
            return @{ App = $app; ProgId = $prog }
        } catch {
            continue
        }
    }
    return $null
}

# P11 — PPT noise blacklist. Template sites, "请勿拍照/录音/录像" warnings,
# and similar fixed phrases get copied into every PPT on the share.
# Without this filter they show up as event titles + summary content,
# which is what the operator flagged as "extraction not accurate".
$PPT_NOISE_REGEX = '(?i)(请勿.{0,4}(拍照|摄影|录音|录像|翻拍)|网上模板|PPT下载|www\.[a-z0-9-]+\.(com|cn|net)|Introduction$|汇报人[:：]\s*$|\s*www\.1ppt\.com)'

function Convert-OfficeFile([string]$path, [string]$ext) {
    $tmpRoot = [System.IO.Path]::Combine(
        [System.IO.Path]::GetTempPath(),
        "sag-read-" + [System.Guid]::NewGuid().ToString("N")
    )
    $null = New-Item -ItemType Directory -Path $tmpRoot -Force

    $comInfo = Get-ComApp $ext
    if (-not $comInfo) {
        Write-Error "no Office/WPS COM server available"
        exit $EXIT_UNSUPPORTED
    }

    $app = $comInfo.App
    try {
        $app.Visible = $false
        $app.DisplayAlerts = 0  # wdAlertsNone / xlAlertsNone / ppAlertsNone

        switch -Regex ($ext) {
            '^\.(docx?|doc)$' {
                $doc = $app.Documents.Open($path, $false, $true)  # ReadOnly=True, Visible ignored
                try {
                    $extracted = @()
                    $extracted += "# " + [System.IO.Path]::GetFileName($path)
                    $extracted += ""
                    $extracted += $doc.Content.Text
                } finally {
                    $doc.Close($false)
                    [System.Runtime.Interopservices.Marshal]::ReleaseComObject($doc) | Out-Null
                }
            }
            '^\.(pptx?|ppt)$' {
                $pres = $app.Presentations.Open($path, $true, $false, $false)  # ReadOnly=True
                try {
                    $extracted = @()
                    $extracted += "# " + [System.IO.Path]::GetFileName($path)
                    $extracted += ""
                    for ($i = 1; $i -le $pres.Slides.Count; $i++) {
                        $slide = $pres.Slides.Item($i)
                        $extracted += "## Slide $i"
                        $extracted += ""
                        foreach ($shape in $slide.Shapes) {
                            if ($shape.HasTextFrame -eq $true) {
                                $text = $shape.TextFrame.TextRange.Text
                                # P11 — drop footer / watermark / template-site text
                                if ($text.Trim() -and ($text -notmatch $PPT_NOISE_REGEX)) {
                                    $extracted += $text.Trim()
                                    $extracted += ""
                                }
                            }
                        }
                    }
                } finally {
                    $pres.Close()
                    [System.Runtime.Interopservices.Marshal]::ReleaseComObject($pres) | Out-Null
                }
            }
            '^\.(xlsx?|xls)$' {
                $wb = $app.Workbooks.Open($path, $true)  # ReadOnly=True
                try {
                    $extracted = @()
                    $extracted += "# " + [System.IO.Path]::GetFileName($path)
                    $extracted += ""
                    foreach ($ws in $wb.Worksheets) {
                        $extracted += "## Sheet - $($ws.Name)"
                        $extracted += ""
                        $usedRange = $ws.UsedRange
                        if ($usedRange -eq $null) { continue }
                        $rows = $usedRange.Rows.Count
                        $cols = $usedRange.Columns.Count
                        $maxRows = [Math]::Min($rows, 20000)
                        $maxCols = [Math]::Min($cols, 100)
                        for ($r = 1; $r -le $maxRows; $r++) {
                            $line = @()
                            for ($c = 1; $c -le $maxCols; $c++) {
                                $v = $ws.Cells.Item($r, $c).Text
                                $line += ($v -replace "\|", "\|" -replace "`r?`n", " ")
                            }
                            $extracted += ($line -join " | ")
                        }
                        if ($rows -gt $maxRows) {
                            $extracted += ""
                            $extracted += "*(truncated: $($rows - $maxRows) more rows)*"
                        }
                    }
                } finally {
                    $wb.Close($false)
                    [System.Runtime.Interopservices.Marshal]::ReleaseComObject($wb) | Out-Null
                }
            }
        }
        $app.Quit()
    } finally {
        [System.Runtime.Interopservices.Marshal]::ReleaseComObject($app) | Out-Null
        [System.GC]::Collect()
        Remove-Item -LiteralPath $tmpRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
    return $extracted
}

if ($Meta) {
    Send-Meta
    exit $EXIT_OK
}

if ($Probe) {
    exit (Test-Probe $InputPath)
}

if (-not $InputPath) {
    [Console]::Error.WriteLine("usage: sag-read-office-encrypted.ps1 [--meta|--probe F] <file>")
    exit 1
}

try {
    $ext = [System.IO.Path]::GetExtension($InputPath).ToLower()
    $lines = Convert-OfficeFile -path $InputPath -ext $ext
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $lines | ForEach-Object { [Console]::Out.WriteLine($_) }
    $bytes = (Get-Item -LiteralPath $InputPath).Length
    $meta = @{
        title       = [System.IO.Path]::GetFileName($InputPath)
        bytes       = $bytes
        extractedAt = (Get-Date).ToString("s")
        engine      = "office-com"
    } | ConvertTo-Json -Compress
    [Console]::Error.WriteLine($meta)
    exit $EXIT_OK
} catch [System.IO.FileNotFoundException] {
    [Console]::Error.WriteLine("file not found: $InputPath")
    exit 1
} catch {
    $msg = $_.Exception.Message
    if ($msg -match "password|encrypt|locked") {
        [Console]::Error.WriteLine("still encrypted after COM attempt: $msg")
        exit $EXIT_UNSUPPORTED
    }
    [Console]::Error.WriteLine("COM extract failed: $msg")
    exit 3  # transient
}