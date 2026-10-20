$realPath = "D:\SAG\fixtures\LongPaths\审计准则2024年度更新版-中国注册会计师协会-发布稿-完整版-含附录\0001_网络安全审查.pptx"
$b64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($realPath))
$ptr = "C:\Users\Administrator\test-pointer.txt"
[System.IO.File]::WriteAllText($ptr, $b64)
Write-Host "pointer file content: $b64"
Write-Host "=== Running PS directly ==="
$ps = "D:\SAG\doc_vectorizer\release-desktop\win-unpacked\resources\native-cache\46f89b459c09\scripts\com-extract.ps1"
& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $ps -InputPath $ptr 2>&1 | Select-Object -First 20
Write-Host "exit: $LASTEXITCODE"
Remove-Item $ptr -ErrorAction SilentlyContinue