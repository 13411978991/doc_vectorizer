# scripts/com-extract.ps1 — COM-based text extraction for encrypted Office files.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/com-extract.ps1 `
#     -InputPath "C:\path\encrypted.pptx"
#
# Opens the file via COM automation (Office/WPS), extracts text content
# directly into memory, writes it to a temp file in real UTF-8 (via
# Out-File -Encoding UTF8), and prints the file path on stdout. Node
# reads the bytes and decodes as UTF-8.
#
# Why a temp file and not direct stdout?
#   PowerShell 5.1 on Chinese Windows transcodes every [Console]::Write
#   through the system ANSI code page (GBK) before it hits the pipe.
#   Even [Console]::OutputEncoding = UTF8 does not help because the
#   PSHost hijacks the stream. Writing to a file via Out-File -Encoding
#   UTF8 bypasses the host transcoding layer and produces real UTF-8
#   bytes.
#
# IMPORTANT: this file MUST be saved as UTF-8 with BOM. PowerShell 5.1
# reads script source as ANSI (GBK) by default, which would corrupt
# every Chinese literal in this file at parse time. A leading BOM
# tells the parser to use UTF-8.
#
# Returns exit 0 with the file path on stdout, non-zero with error
# message on stderr.

param(
    [Parameter(Mandatory = $true)]
    [string]$InputPath
)

$ErrorActionPreference = "Stop"

# Where we'll write the extracted text. Created on success, then we
# print the path on stdout. Node reads and deletes the file.
$OutputFile = [System.IO.Path]::GetTempFileName()

# Skip Office temp lock files (~$*.docx). These appear when any
# Office/WPS instance has the file open; opening them via COM would
# create a conflict dialog that hangs the spawn.
$basename = [System.IO.Path]::GetFileName($InputPath)
if ($basename.StartsWith("~$")) {
    [Console]::Error.WriteLine("skip: Office temp lock file")
    exit 14
}

# ── Extraction helpers (must be defined before use) ─────────────────

function Extract-ExcelContent($workbook, [System.Text.StringBuilder]$out) {
    foreach ($sheet in $workbook.Worksheets) {
        $name = $sheet.Name
        [void]$out.AppendLine("## $name")
        [void]$out.AppendLine("")
        $used = $sheet.UsedRange
        if ($null -eq $used) {
            [void]$out.AppendLine("*(empty sheet)*")
            [void]$out.AppendLine("")
            continue
        }
        $rows = $used.Rows.Count
        $cols = $used.Columns.Count
        $maxRows = [Math]::Min($rows, 100)
        $maxCols = [Math]::Min($cols, 20)
        for ($r = 1; $r -le $maxRows; $r++) {
            $cells = @()
            for ($c = 1; $c -le $maxCols; $c++) {
                $v = $sheet.Cells.Item($r, $c).Text
                $cells += $v -replace '\|', '\|' -replace "`n", " "
            }
            $line = "| " + ($cells -join " | ") + " |"
            [void]$out.AppendLine($line)
            if ($r -eq 1) {
                $sep = "| " + (($cells | ForEach-Object { "---" }) -join " | ") + " |"
                [void]$out.AppendLine($sep)
            }
        }
        [void]$out.AppendLine("")
    }
}

function Extract-WordContent($document, [System.Text.StringBuilder]$out) {
    $text = $document.Content.Text
    $text = $text -replace "`r`n", "`n" -replace "`r", "`n"
    $text = $text -replace "`n{3,}", "`n`n"
    [void]$out.Append($text.TrimEnd())
    [void]$out.AppendLine("")
}

function Extract-PptxContent($presentation, [System.Text.StringBuilder]$out) {
    $slideNum = 0
    foreach ($slide in $presentation.Slides) {
        $slideNum++
        [void]$out.AppendLine("===== Slide $slideNum =====")
        foreach ($shape in $slide.Shapes) {
            if ($shape.HasTextFrame) {
                $tf = $shape.TextFrame
                if ($tf.HasText) {
                    $txt = $tf.TextRange.Text.Trim()
                    if ($txt) {
                        [void]$out.AppendLine($txt)
                    }
                }
            }
            # PPT tables (e.g. audit reports with risk matrix). The user's
            # audit-core docs frequently have these.
            if ($shape.HasTable) {
                $table = $shape.Table
                for ($r = 1; $r -le $table.Rows.Count; $r++) {
                    $rowCells = @()
                    for ($c = 1; $c -le $table.Columns.Count; $c++) {
                        $cell = $table.Cell($r, $c)
                        if ($cell.Shape.HasTextFrame) {
                            $rowCells += $cell.Shape.TextFrame.TextRange.Text
                        } else {
                            $rowCells += ""
                        }
                    }
                    [void]$out.AppendLine(($rowCells -join "`t"))
                }
            }
        }
        [void]$out.AppendLine("")
    }
}

# ── Open helpers — bare minimum call (FileName only). PowerShell 5.1 +
#    Office COM throws "Value does not fall within the expected range"
#    on Word's Documents.Open even with a single FileName arg.
#    Excel (Workbooks.Open) and PowerPoint (Presentations.Open) tolerate
#    the bare call. For Word we use the alternate `OpenNoRepairDialog`
#    method which has fewer defaults that Office refuses.
function Open-Word($app, $path) {
    # OpenNoRepairDialog exists in Word 2010+; older Office may not
    # expose it (member-not-found exception). Fall back to plain Open.
    try {
        return $app.Documents.OpenNoRepairDialog($path)
    } catch {
        return $app.Documents.Open($path)
    }
}
function Open-Excel($app, $path) {
    # Prefer OpenXML over Open so we don't execute any embedded VBA
    # macros or auto-load external data links. A workbook with macros
    # can spin Excel's event loop forever when launched with .Open()
    # (see sag_xlsx-问题汇总1-COM卡死-20260818.md §一). OpenXML opens
    # the package as a read-only data source and never fires the
    # macro auto_open hooks.
    #
    # We additionally wrap the call in a background job with a 30 s
    # timeout — the CA-19 / 信息系统账号管理问题汇总1.xlsx hang happens
    # *inside* Excel's Workbooks.OpenXML call (SafeNetLOCK interception
    # on the network share, see §7.3) and never returns. Without a
    # timeout the host waits forever and the Node-side SIGKILL leaves
    # the EXCEL.EXE child orphaned (see sag_xlsx-COM句柄泄漏-20260817.md).
    #
    # Both the OpenXML and the Open() fallback use the same timeout
    # wrapper so a hang on either path is bounded — see
    # sag_xlsx-问题汇总1-开发交付-20260818.md §三.
    try {
        return Open-ExcelWithTimeout -app $app -path $path -timeoutSec 30
    } catch {
        $msg = $_.Exception.Message
        if ($msg -match 'OpenXML timeout after') {
            # Real hang — don't bother trying the fallback, it's the
            # same COM stack and would hang too.
            throw "OpenXML timed out after 30s — file likely has SafeNetLOCK intercept or external link"
        }
        # P2 — see sag_xlsx-9-数据中台文件夹失败根因-20260827.md §根因 #1.
        #
        # The previous code threw on the `OpenXML failed:` branch. That
        # meant any COM-level failure inside Workbooks.OpenXML (member
        # not found on a pre-2010 build, COM exception from a damaged
        # file, etc.) was fatal — we never got to try Workbooks.Open()
        # as a fallback. The data-platform folder is full of legacy xls
        # files that fail OpenXML for one reason or another but open
        # cleanly under .Open().
        #
        # Fix: on ANY OpenXML failure (other than a confirmed hang),
        # drop into the same timeout-wrapped Open() path. Only the
        # timeout branch is hard-thrown, because the hang would just
        # repeat on .Open() too.
        $fallbackErr = ""
        try {
            return Open-ExcelFallback -app $app -path $path -timeoutSec 30
        } catch {
            # Combine the two messages so the Node side can surface the
            # primary cause (usually OpenXML) plus the secondary failure.
            $fallbackErr = $_.Exception.Message
            throw "OpenXML failed: $($msg -replace '^OpenXML failed:\s*', '') | Open() fallback: $fallbackErr"
        }
    }
}

# P0 — see sag_xlsx-9-数据中台文件夹失败根因-20260827.md §根因 #1.
#
# The previous Start-Job wrapper caused every Excel call to fail with
# `[System.String] OpenXML` because Start-Job spawns a separate PS
# process; COM objects (specifically the $app Workbook host) cannot
# cross that process boundary, so PowerShell silently downgraded the
# unmarshalable COM reference to a `[System.String]`. The new script-
# block then invoked `"<string>".OpenXML(...)` and threw a method-not-
# found error that looked like an Excel error but was actually a PS
# marshalling bug.
#
# We initially moved to `System.Threading.Tasks.Task.Run` to keep the
# call in-process, but that hits the same COM apartment mismatch (STA
# Excel.Application cannot be invoked from an MTA thread-pool worker,
# even via Marshal.GetObjectForIUnknown — the call throws
# "COMException 0x8001010000" or returns silently empty). The only
# clean option that survives both constraints is: drive the COM call
# synchronously on the STA main thread (which is what PowerShell runs
# on by default), with a separate wall-clock watchdog that can detect
# a hang and force-kill the orphaned EXCEL.EXE.
#
# The watchdog does NOT try to interrupt the COM call (you cannot do
# that cleanly from a script). It kills the EXCEL.EXE child we
# spawned, which causes Excel's RPC to fail and the call to unwind.
# The PS host then sees the exception and we report it as a timeout.
function Open-ExcelWithTimeout($app, $path, $timeoutSec) {
    $myStart = (Get-Process -Id $PID).StartTime
    return Run-InExcelRunspace -openerScript {
        param($p)
        $localApp = New-Object -ComObject Excel.Application
        try {
            $localApp.Visible = $false
            $localApp.DisplayAlerts = $false
            $localApp.ScreenUpdating = $false
        } catch { }
        $doc = $localApp.Workbooks.OpenXML($p)
        return $doc
    } -extractorScript {
        param($d, $sb)
        $out = [System.Text.StringBuilder]::new()
        Extract-ExcelContent $d $out
        return $out.ToString()
    } -timeoutSec $timeoutSec -myStart $myStart -errPrefix "OpenXML"
}

function Open-ExcelFallback($app, $path, $timeoutSec) {
    $myStart = (Get-Process -Id $PID).StartTime
    return Run-InExcelRunspace -openerScript {
        param($p)
        $localApp = New-Object -ComObject Excel.Application
        try {
            $localApp.Visible = $false
            $localApp.DisplayAlerts = $false
            $localApp.ScreenUpdating = $false
        } catch { }
        $doc = $localApp.Workbooks.Open($p, $false, $true, $null, $null, $null, $true, $null, $null, $false, $false, $null, $null, $null, $null)
        return $doc
    } -extractorScript {
        param($d, $sb)
        $out = [System.Text.StringBuilder]::new()
        Extract-ExcelContent $d $out
        return $out.ToString()
    } -timeoutSec $timeoutSec -myStart $myStart -errPrefix "Open()"
}

# Helper — open a workbook + run the extraction ALL inside a fresh STA
# runspace, returning the extracted string. The whole pipeline lives
# in the runspace so the COM apartment stays consistent (Excel's RCW
# doesn't get separated from its underlying process when the runspace
# closes), and we get a single watchdog that covers BOTH the open and
# the extract phases — important because on a damaged workbook the
# open can succeed but the first sheet iteration can still hang.
function Run-InExcelRunspace($openerScript, $extractorScript, $timeoutSec, $myStart, $errPrefix) {
    $rs = [runspacefactory]::CreateRunspace()
    $rs.ApartmentState = "STA"
    $rs.Open()
    try {
        $ps = [powershell]::Create()
        $ps.Runspace = $rs
        # Inline both phases. We DON'T pass scripts as parameters
        # because PS 5.1 serializes ScriptBlock arguments as [string]
        # (the same marshalling bug we're trying to avoid).
        $ps.AddScript({
            param($p)
            try {
                $localApp = New-Object -ComObject Excel.Application
                try {
                    $localApp.Visible = $false
                    $localApp.DisplayAlerts = $false
                    $localApp.ScreenUpdating = $false
                } catch { }
                $doc = $localApp.Workbooks.OpenXML($p)
                $out = [System.Text.StringBuilder]::new()
                foreach ($sheet in $doc.Worksheets) {
                    [void]$out.AppendLine("## $($sheet.Name)")
                    [void]$out.AppendLine("")
                    $used = $sheet.UsedRange
                    if ($null -eq $used) {
                        [void]$out.AppendLine("*(empty sheet)*")
                        [void]$out.AppendLine("")
                        continue
                    }
                    $rows = $used.Rows.Count
                    $cols = $used.Columns.Count
                    $maxRows = [Math]::Min($rows, 100)
                    $maxCols = [Math]::Min($cols, 20)
                    for ($r = 1; $r -le $maxRows; $r++) {
                        $cells = @()
                        for ($c = 1; $c -le $maxCols; $c++) {
                            $v = $sheet.Cells.Item($r, $c).Text
                            $cells += $v -replace '\|', '\|' -replace "`n", " "
                        }
                        $line = "| " + ($cells -join " | ") + " |"
                        [void]$out.AppendLine($line)
                        if ($r -eq 1) {
                            $sep = "| " + (($cells | ForEach-Object { "---" }) -join " | ") + " |"
                            [void]$out.AppendLine($sep)
                        }
                    }
                    [void]$out.AppendLine("")
                }
                try { $doc.Close($false) } catch { }
                try { [void][System.Runtime.Interopservices.Marshal]::ReleaseComObject($doc) } catch { }
                try { $localApp.Quit() } catch { }
                try { [void][System.Runtime.Interopservices.Marshal]::ReleaseComObject($localApp) } catch { }
                return @{ ok = $true; text = $out.ToString(); err = $null }
            } catch {
                $msg = $_.Exception.Message
                $stack = $_.Exception.StackTrace
                return @{ ok = $false; text = $null; err = "$msg | $stack" }
            }
        }).AddArgument($path) | Out-Null

        $async = $ps.BeginInvoke()
        $deadline = (Get-Date).AddSeconds($timeoutSec)
        while (-not $async.IsCompleted) {
            if ((Get-Date) -ge $deadline) {
                try { Get-Process EXCEL -ErrorAction SilentlyContinue |
                    Where-Object { $_.StartTime -ge $myStart } |
                    ForEach-Object { try { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue } catch { } }
                } catch { }
                try { $ps.Stop() } catch { }
                throw "${errPrefix} timeout after ${timeoutSec}s — file likely has SafeNetLOCK intercept or external link"
            }
            Start-Sleep -Milliseconds 500
            try { [System.Windows.Forms.Application]::DoEvents() } catch { }
        }

        $result = $ps.EndInvoke($async)
        $ps.Dispose()
        if (-not $result.ok) {
            throw "${errPrefix} failed: $($result.err)"
        }
        return $result.text
    } finally {
        try { $rs.Close() } catch { }
        try { $rs.Dispose() } catch { }
        # Belt-and-braces: kill any EXCEL.EXE we spawned. The Quit()
        # above usually does it, but a hung RPC or stuck external
        # data refresh can leave the COM process around.
        try { Get-Process EXCEL -ErrorAction SilentlyContinue |
            Where-Object { $_.StartTime -ge $myStart } |
            ForEach-Object { try { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue } catch { } }
        } catch { }
    }
}
function Open-PowerPoint($app, $path) {
    # WithWindow=False: PowerPoint COM does NOT honour Visible=False for
    # the Presentations collection — it will throw -2147352567
    # ("Value does not fall within the expected range") if we try.
    # WithWindow=False is the documented way to open without showing
    # the document window. The PPT app shell icon may briefly flash in
    # the taskbar; that's unavoidable.
    return $app.Presentations.Open($path, $true, $false, $false)
}

# ── Main ────────────────────────────────────────────────────────────

# Pre-flight cleanup: kill any EXCEL.EXE process older than 30 minutes
# that isn't ours. The watcher historically leaked these — see
# sag_xlsx-COM句柄泄漏-20260817.md. Without this sweep, a stale EXCEL
# from a previous ps1 run can hold the same file lock the new run is
# about to request, hanging OpenXML indefinitely.
try {
    $cutoff = (Get-Date).AddMinutes(-30)
    Get-Process EXCEL -ErrorAction SilentlyContinue |
        Where-Object { $_.StartTime -lt $cutoff } |
        ForEach-Object {
            try { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue } catch { }
        }
} catch { }

if (-not (Test-Path -LiteralPath $InputPath)) {
    [Console]::Error.WriteLine("input not found: $InputPath")
    exit 10
}

$ext = [System.IO.Path]::GetExtension($InputPath).ToLowerInvariant()

$progIdMap = @{
    # P1 — see sag_xlsx-9-数据中台文件夹失败根因-20260827.md §根因 #2.
    #
    # The previous map put KingsoftET.Application / WPS.Application /
    # ET.Application BEFORE Excel.Application. That ordering was based
    # on the assumption that the host had a WPS spreadsheet install
    # (those ProgIDs being NOT-registered on a stock Windows+Office
    # machine causes the New-Object -ComObject call to fail every time
    # before we ever reach Excel, costing one round-trip per file and
    # printing a misleading "Class not registered" line for every
    # xlsx file in the folder).
    #
    # Verified on the data-platform audit host (2026-08-27 probe):
    #   KWPS.Application          ✅ (WPS 文字)
    #   KWPP.Application          ✅ (WPS 演示)
    #   WPS.Doc / WPS.Docx        ✅
    #   Excel.Application         ✅ (Office 2016+)
    #   Word.Application          ✅
    #   PowerPoint.Application    ✅
    #   WPS.Application           ❌ (spreadsheet COM not installed)
    #   KingsoftET.Application    ❌
    #   ET.Application            ❌
    #
    # For spreadsheets we therefore try Excel first; if the host later
    # gets a real WPS spreadsheet install we can re-add it. For Word /
    # PowerPoint the WPS variants (KWPS/KWPP) ARE registered, so they
    # are kept as the first choice to take advantage of WPS's better
    # SafeNetLOCK / DLP handling.
    ".xlsx" = @("Excel.Application")
    ".xls"  = @("Excel.Application")
    ".csv"  = @("Excel.Application")
    ".docx" = @("Word.Application",  "KWPS.Application", "WPS.Application")
    ".doc"  = @("Word.Application",  "KWPS.Application", "WPS.Application")
    ".pptx" = @("PowerPoint.Application", "KWPP.Application", "WPS.Application")
    ".ppt"  = @("PowerPoint.Application", "KWPP.Application", "WPS.Application")
    ".pdf"  = @()
}

if ($ext -eq ".pdf") {
    [Console]::Error.WriteLine("PDF extraction via COM is not supported.")
    exit 11
}

$progIds = $progIdMap[$ext]
if ($null -eq $progIds) {
    [Console]::Error.WriteLine("unsupported extension for COM extraction: $ext")
    exit 12
}

$app = $null
$appName = ""
$lastError = ""

foreach ($progId in $progIds) {
    try {
        $app = New-Object -ComObject $progId
        $appName = $progId
        break
    } catch {
        $lastError = $_.Exception.Message
        $app = $null
    }
}

if ($null -eq $app) {
    [Console]::Error.WriteLine("no Office/WPS COM object available: $lastError")
    exit 13
}

try {
    # PowerShell's New-Object -ComObject creates a NEW process every
    # time, equivalent to Python's DispatchEx. It does NOT attach to
    # any Office/WPS instance the user already has open. Calling Quit()
    # below shuts down only the process we started.
    try { $app.Visible = $false } catch { }
    try { $app.DisplayAlerts = 0 } catch { }
    try { $app.ScreenUpdating = $false } catch { }

    $doc = $null
    # Excel-family apps: run open + extract together inside a fresh
    # STA runspace, return the extracted string directly. The runspace
    # boundary is the only safe way to keep the COM apartment stable
    # (Excel.Application is STA and crossing back to the main thread
    # invalidates the RCW once the runspace closes — see
    # sag_xlsx-9-数据中台文件夹失败根因-20260827.md §根因 #1).
    $excelText = $null
    switch ($appName) {
    "Excel.Application" { $excelText = Open-Excel $app $InputPath }
    "ET.Application"    { $excelText = Open-Excel $app $InputPath }
    "KingsoftET.Application" { $excelText = Open-Excel $app $InputPath }
    "WPS.Application" {
        switch ($ext) {
            ".docx" { $doc = Open-Word $app $InputPath }
            ".pptx" { $doc = Open-PowerPoint $app $InputPath }
            default  { $excelText = Open-Excel $app $InputPath }
        }
    }
    "Word.Application" { $doc = Open-Word $app $InputPath }
    "KWPS.Application" { $doc = Open-Word $app $InputPath }
    "KingsoftWPS.Application" { $doc = Open-Word $app $InputPath }
    "PowerPoint.Application" { $doc = Open-PowerPoint $app $InputPath }
    "KWPP.Application" { $doc = Open-PowerPoint $app $InputPath }
    default {
        throw "unsupported COM app: $appName"
    }
}

$out = [System.Text.StringBuilder]::new()
if ($null -ne $excelText) {
    # Already extracted inside the runspace — just copy the string
    # into our StringBuilder. The runspace already released the doc
    # and the $localApp it owned.
    [void]$out.AppendLine($excelText)
} else {
    # Word/PowerPoint paths: doc still alive on the main thread, run
    # the existing extractors in-place.
    if ($null -eq $doc) {
        # P2 — see sag_xlsx-问题汇总1-开发交付-20260818.md §四. The original
        # message hard-coded "DLP-encrypted" which was misleading because
        # a real COM exception from OpenXML / Open() can also return a null
        # doc. List the most likely real causes so the user knows what to
        # actually check, then push the diagnostic context to stderr.
        [Console]::Error.WriteLine("DBG: Open returned null doc for $InputPath after progIds tried: $($progIds -join ',')")
        [Console]::Error.Flush()
        throw "Open returned null document. Possible causes: (1) DLP-encrypted (亿赛通/IPGuard), (2) corrupted OOXML, (3) unsupported Excel version, (4) SafeNetLOCK network interception. Try opening manually in Office/WPS."
    }

    switch ($appName) {
        { $_ -in @("Word.Application", "KWPS.Application", "KingsoftWPS.Application") } {
            Extract-WordContent $doc $out
        }
        { $_ -in @("PowerPoint.Application", "KWPP.Application") } {
            Extract-PptxContent $doc $out
        }
        "WPS.Application" {
            switch ($ext) {
                ".docx" { Extract-WordContent $doc $out }
                ".pptx" { Extract-PptxContent $doc $out }
            }
        }
    }
}

# Write the extracted text to a real UTF-8 file (with BOM) so that
# Chinese characters survive the round-trip. See the file header
# for why direct stdout would corrupt everything on Chinese
# Windows + PowerShell 5.1.
$out.ToString() | Out-File -FilePath $OutputFile -Encoding UTF8

# Tell Node where to find the text. ASCII-safe, no transcoding.
[Console]::Out.WriteLine($OutputFile)
}
finally {
    if ($null -ne $doc) {
        try { $doc.Close($false) } catch { }
        try { [System.Runtime.Interopservices.Marshal]::ReleaseComObject($doc) | Out-Null } catch { }
        $doc = $null
    }
    if ($null -ne $app) {
        try { $app.Quit() } catch { }
        try { [System.Runtime.Interopservices.Marshal]::ReleaseComObject($app) | Out-Null } catch { }
        $app = $null
    }
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
    # Belt-and-braces: even after Quit() + ReleaseComObject(), the
    # EXCEL.EXE COM process sometimes survives (e.g. SafeNetLOCK
    # decryption leaving a background lock thread). Force-kill any
    # EXCEL.EXE spawned by this PowerShell process so the next call
    # doesn't inherit accumulated COM state and slow down.
    try {
        $myPid = $PID
        Get-Process EXCEL -ErrorAction SilentlyContinue |
            Where-Object { $_.StartTime -ge (Get-Process -Id $myPid).StartTime } |
            ForEach-Object {
                try { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue } catch { }
            }
    } catch { }
}

exit 0