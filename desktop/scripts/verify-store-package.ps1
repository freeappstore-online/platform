param([switch]$Smoke)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$packages = @(Get-ChildItem release-store/*.appx)
if ($packages.Count -ne 1) { throw 'Expected exactly one Store submission package' }
$archive = [System.IO.Compression.ZipFile]::OpenRead($packages[0].FullName)
try {
  $entry = $archive.GetEntry('AppxManifest.xml')
  if ($null -eq $entry) { throw 'Missing APPX manifest' }
  $reader = [System.IO.StreamReader]::new($entry.Open())
  try { [xml]$manifest = $reader.ReadToEnd() } finally { $reader.Dispose() }
  $identity = $manifest.Package.Identity
  $expectedName = if ($Smoke) { 'FreeAppStore.CISmoke' } else { $env:WINDOWS_STORE_IDENTITY_NAME }
  $expectedPublisher = if ($Smoke) { 'CN=FreeAppStore CI smoke only' } else { $env:WINDOWS_STORE_PUBLISHER }
  if (-not $expectedName -or -not $expectedPublisher) { throw 'Missing verified Partner Center identity' }
  if ($identity.Name -ne $expectedName -or $identity.Publisher -ne $expectedPublisher) { throw 'Store identity mismatch' }
  if ($identity.ProcessorArchitecture -ne 'x64' -or $identity.Version -notmatch '^[1-9]\d*\.\d+\.\d+\.0$') { throw 'Unexpected package architecture/version' }
  $app = $manifest.Package.Applications.Application
  if ($app.Id -ne 'FreeAppStore' -or $app.EntryPoint -ne 'Windows.FullTrustApplication') { throw 'Unexpected application entry point' }
  if ($null -eq $archive.GetEntry(($app.Executable -replace '\\', '/'))) { throw 'Missing packaged executable' }
  if ($null -eq $archive.GetEntry('app/resources/app.asar')) { throw 'Missing application archive' }
  $namespace = [System.Xml.XmlNamespaceManager]::new($manifest.NameTable)
  $namespace.AddNamespace('r', 'http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities')
  if ($null -eq $manifest.SelectSingleNode('//r:Capability[@Name="runFullTrust"]', $namespace)) { throw 'Missing desktop full trust capability' }
  Write-Output 'Store package identity, architecture, version, executable and full-trust manifest verified.'
} finally { $archive.Dispose() }
Get-FileHash $packages[0].FullName -Algorithm SHA256 | Select-Object Hash, Path
