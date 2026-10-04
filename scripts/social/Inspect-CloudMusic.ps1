param(
    [Parameter(Mandatory = $true)][string]$CloudMusicPath,
    [ValidateRange(1024, 65535)][int]$Port = 9229
)
$ErrorActionPreference = 'Stop'
$resolvedMusicPath = (Resolve-Path -LiteralPath $CloudMusicPath).ProviderPath
if ([IO.Path]::GetFileName($resolvedMusicPath) -ine 'cloudmusic.exe') { throw 'Expected cloudmusic.exe' }
$listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop)
if ($listeners.Count -eq 0) { throw 'No listener' }
$owners = @($listeners.OwningProcess | Select-Object -Unique)
if ($owners.Count -ne 1) { throw 'Ambiguous owner' }
$musicOwner = Get-CimInstance Win32_Process -Filter "ProcessId = $($owners[0])"
if ($musicOwner.ExecutablePath -ine $resolvedMusicPath) { throw 'Wrong process' }
if (@($listeners | Where-Object LocalAddress -ne '127.0.0.1').Count -gt 0) { throw 'Non-loopback listener' }
[pscustomobject]@{
    processId = $owners[0]
    expectedPath = $resolvedMusicPath
    actualPath = $musicOwner.ExecutablePath
    addresses = @($listeners.LocalAddress)
} | ConvertTo-Json -Compress
