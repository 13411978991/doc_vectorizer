# Quick: try with explicit Template parameter
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = "Continue"
$base = "D:\IT审计\SAG-windows-pack\fixtures\regen-test"
if (Test-Path $base) { Remove-Item $base -Recurse -Force }
New-Item -ItemType Directory -Path $base -Force | Out-Null

$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0
$word.Options.CreateBackup = $false
$word.Options.SavePropertiesPrompt = $false
$word.Options.PromptUpdateStyle = $false

# Template "" = blank document; the missing-template wait is what
# usually hangs Word in a fresh user profile.
$t0 = Get-Date
Write-Host "1) adding doc with explicit empty template..."
$doc = $word.Documents.Add("", $false, 0, $false)
Write-Host "   done in $(((Get-Date) - $t0).TotalSeconds)s"

Write-Host "2) writing text..."
$para = $doc.Content.Paragraphs.Add()
$para.Range.Text = "test 中文 `r`n"
$t1 = Get-Date
Write-Host "3) saving..."
$doc.SaveAs2("$base\test1.docx", 16)
Write-Host "   saved in $(((Get-Date) - $t1).TotalSeconds)s"

$doc.Close($false)
[System.Runtime.Interopservices.Marshal]::ReleaseComObject($doc) | Out-Null
$word.Quit()
[System.Runtime.Interopservices.Marshal]::ReleaseComObject($word) | Out-Null
[GC]::Collect()
[GC]::WaitForPendingFinalizers()
Write-Host "done"
Get-ChildItem $base -File | Format-Table Name, Length -AutoSize