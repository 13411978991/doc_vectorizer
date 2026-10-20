$utf8Bom = New-Object System.Text.UTF8Encoding($true)
[System.IO.File]::WriteAllText("C:\Users\Administrator\test-com-extract.ps1", (Get-Content -Raw "D:\SAG\doc_vectorizer\release-desktop\win-unpacked\resources\native-cache\01b62dd29ffb\scripts\com-extract.ps1"), $utf8Bom)

# Make a test pointer file with valid base64
$realPath = "D:\SAG\fixtures\LongPaths\审计准则2024年度更新版-中国注册会计师协会-发布稿-完整版-含附录\0001_网络安全审查.pptx"
$b64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($realPath))
$ptr = "C:\Users\Administrator\test-pointer.txt"
[System.IO.File]::WriteAllText($ptr, $b64)
Write-Host "pointer file content: $b64"

# Run PS
$ps = "C:\Users\Administrator\test-com-extract.ps1"
Write-Host "=== Running PS directly ==="
& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $ps -InputPath $ptr 2>&1
Write-Host "exit: $LASTEXITCODE"

Remove-Item "C:\Users\Administrator\test-com-extract.ps1", $ptr -ErrorAction SilentlyContinue