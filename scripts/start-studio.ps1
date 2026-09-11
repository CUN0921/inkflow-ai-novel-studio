param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$studioRoot = Split-Path -Parent $PSScriptRoot
$candidates = @()
$installedNode = Get-Command node.exe -ErrorAction SilentlyContinue
if ($installedNode) { $candidates += $installedNode.Source }
$candidates += @(
  (Join-Path $studioRoot 'runtime\node.exe'),
  (Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'),
  (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
  (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe')
)
$runtime = $null
foreach ($candidate in ($candidates | Select-Object -Unique)) {
  if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  & $candidate --input-type=module -e "import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(':memory:'); db.close();" 2>$null | Out-Null
  $supported = $LASTEXITCODE -eq 0
  $ErrorActionPreference = $previousPreference
  if ($supported) { $runtime = $candidate; break }
}
if (-not $runtime) {
  Write-Host 'No compatible Node.js runtime found. Install Node.js 22.5+ or put node.exe in runtime\.'
  exit 1
}
try {
  $arguments = @((Join-Path $PSScriptRoot 'start-studio.mjs'))
  if ($NoBrowser) { $arguments += '--no-browser' }
  & $runtime @arguments
  exit $LASTEXITCODE
} catch {
  Write-Host $_.Exception.Message
  exit 1
}
