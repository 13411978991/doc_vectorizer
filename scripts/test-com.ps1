# Single-file COM test to find what's blocking the regen
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = "Continue"

$testPath = "D:\IT审计\SAG-windows-pack\fixtures\smoke-test.docx"
if (Test-Path $testPath) { Remove-Item $testPath -Force }

Write-Host "starting Word COM..."
$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0
Write-Host "Word running. Adding document..."
$doc = $word.Documents.Add()
Write-Host "Document added. Writing content..."
$para = $doc.Content.Paragraphs.Add()
$para.Range.Text = "smoke test 中文`r`n"
Write-Host "Saving to $testPath..."
$doc.SaveAs2($testPath, 16)
Write-Host "Saved. Closing document..."
$doc.Close($false)
[System.Runtime.Interopservices.Marshal]::ReleaseComObject($para) | Out-Null
[System.Runtime.Interopservices.Marshal]::ReleaseComObject($doc) | Out-Null
$word.Quit()
[System.Runtime.Interopservices.Marshal]::ReleaseComObject($word) | Out-Null
[GC]::Collect()
[GC]::WaitForPendingFinalizers()
Write-Host "Done. File exists: $(Test-Path $testPath)"
if (Test-Path $testPath) { Get-Item $testPath | Format-Table Name, Length -AutoSize }