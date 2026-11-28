$ErrorActionPreference = 'Stop'
if (-not $env:WINDOWS_SIGNING_THUMBPRINT) { throw 'Missing pinned Windows certificate thumbprint' }
foreach ($path in @('release/win-unpacked/FreeAppStore.exe', 'release/FreeAppStore-win-x64.exe')) {
  $signature = Get-AuthenticodeSignature $path
  if ($signature.Status -ne 'Valid') { throw "Invalid Authenticode signature: $path" }
  if ($signature.SignerCertificate.Thumbprint -ne $env:WINDOWS_SIGNING_THUMBPRINT) { throw "Unexpected publisher: $path" }
  if ($null -eq $signature.TimeStamperCertificate) { throw "Missing trusted timestamp: $path" }
  Write-Output "Verified signed and timestamped: $path"
}
# This proves trusted publisher signatures and timestamps, not SmartScreen reputation.
@{ schemaVersion = 1; authenticode = $true; timestamped = $true } |
  ConvertTo-Json | Set-Content -Encoding utf8NoBOM release/windows-signing-verification.json
