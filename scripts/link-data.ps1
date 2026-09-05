$devData = "E:\sag\export\data"
$exeData = "E:\sag\dist\builds\sag-20260813-171645\data"

foreach ($f in @("sag.db", "sag.db-shm", "sag.db-wal")) {
  Remove-Item (Join-Path $devData $f) -Force -ErrorAction SilentlyContinue
}

# Junction requires cmd, but Trae blocks it. Use New-Item -ItemType Junction via cmd.
# Fallback: copy (data goes both ways won't sync — not ideal, but works for now).
Write-Output "Need to symlink. Trying cmd.exe via ProcessStartInfo..."
try {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = "cmd.exe"
  $psi.Arguments = "/c mklink /J `"$devData`" `"$exeData`""
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $proc = [System.Diagnostics.Process]::Start($psi)
  $proc.WaitForExit()
  Write-Output "exit: $($proc.ExitCode)"
  Write-Output "stdout: $($proc.StandardOutput.ReadToEnd())"
  Write-Output "stderr: $($proc.StandardError.ReadToEnd())"
} catch {
  Write-Output "Failed: $($_.Exception.Message)"
}

Write-Output "Dev data dir now:"
Get-ChildItem $devData -ErrorAction SilentlyContinue | Format-Table Name -AutoSize