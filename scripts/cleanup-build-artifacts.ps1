param([switch]$Apply)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\','/')
if ((Get-Item -LiteralPath $root -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Workspace root is a reparse point' }
$artifactsRoot = Join-Path $root 'artifacts'
if (Test-Path -LiteralPath $artifactsRoot) {
  if ((Get-Item -LiteralPath $artifactsRoot -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Artifacts directory is a reparse point' }
} else { New-Item -ItemType Directory -Path $artifactsRoot | Out-Null }
$policyPath = Join-Path $root 'artifacts/artifact-retention.json'
if (!(Test-Path -LiteralPath $policyPath -PathType Leaf)) {
  $templatePath = Join-Path $root 'config/artifact-retention.default.json'
  if (!(Test-Path -LiteralPath $templatePath -PathType Leaf)) { throw 'Artifact retention template is missing' }
  if ((Get-Item -LiteralPath $templatePath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Artifact retention template is a reparse point' }
  Copy-Item -LiteralPath $templatePath -Destination $policyPath
}
if ((Get-Item -LiteralPath $policyPath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Artifact retention policy is a reparse point' }
$policy = Get-Content -LiteralPath $policyPath -Raw | ConvertFrom-Json
function Inside([string]$path) {
  $full = [IO.Path]::GetFullPath($path).TrimEnd('\','/')
  if (!$full.StartsWith($root + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw "Outside workspace: $full" }
  return $full
}
function PlainTree([string]$path) {
  $item = Get-Item -LiteralPath $path -Force
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Refuse reparse point: $path" }
  foreach ($child in (Get-ChildItem -LiteralPath $path -Force)) {
    if ($child.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Refuse reparse point: $($child.FullName)" }
    if ($child.PSIsContainer) { PlainTree $child.FullName }
  }
}
$benchDataRoot = Join-Path $root 'bench-data'
if (Test-Path -LiteralPath $benchDataRoot -PathType Container) { PlainTree $benchDataRoot }
$protected = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($name in @($policy.validatedReleases) + @($policy.extraProtectedDirectories)) {
  if ($name) { [void]$protected.Add((Inside (Join-Path $root $name))) }
}
$latestPath = Join-Path $root 'artifacts/rivu-directory-latest.json'
if (Test-Path -LiteralPath $latestPath -PathType Leaf) {
  $latest = Get-Content -LiteralPath $latestPath -Raw | ConvertFrom-Json
  [void]$protected.Add((Inside $latest.directory))
}
foreach ($manifest in $policy.fixtureManifests) {
  $manifestPath = Inside (Join-Path $root $manifest)
  if (Test-Path -LiteralPath $manifestPath) {
    $fixture = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ($fixture.directory) { [void]$protected.Add((Inside $fixture.directory)) }
    if ($fixture.databasePath) { [void]$protected.Add((Inside (Split-Path -Parent $fixture.databasePath))) }
  }
}
$candidates = @()
foreach ($item in (Get-ChildItem -LiteralPath $root -Directory -Force)) {
  if ($item.Name -eq 'release' -or $item.Name -like 'release-*') { $candidates += $item }
}
if (Test-Path -LiteralPath $benchDataRoot -PathType Container) {
  $candidates += @(Get-ChildItem -LiteralPath $benchDataRoot -Directory -Force)
}
$plan = @()
foreach ($item in $candidates) {
  $path = Inside $item.FullName
  PlainTree $path
  # Protect ancestors/descendants too, even if an extra pin names a nested path.
  $keep = $false
  foreach ($pin in $protected) {
    if ($path -eq $pin -or $path.StartsWith($pin+'\',[StringComparison]::OrdinalIgnoreCase) -or $pin.StartsWith($path+'\',[StringComparison]::OrdinalIgnoreCase)) { $keep=$true; break }
  }
  $size = (Get-ChildItem -LiteralPath $path -Recurse -File -Force | Measure-Object Length -Sum).Sum
  $plan += [pscustomobject]@{path=$path;bytes=[long]$size;action=$(if($keep){'keep'}else{'delete'})}
}
$report = [ordered]@{recordedAt=(Get-Date).ToString('o');applied=[bool]$Apply;workspace=$root;plan=$plan;deleted=@();logicalBytesDeleted=0}
$reportPath = Join-Path $root ('artifacts/artifact-cleanup-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N') + '.json')
$report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $reportPath -Encoding utf8
try {
if ($Apply) {
  # Fail closed for relevant jobs, including relative test/script invocations.
  $busy = @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -match '^(node|electron|Rivu)(\.exe)?$' -and
    ($_.CommandLine -like "*$root*" -or $_.ExecutablePath -like "$root\*" -or $_.CommandLine -match '(scripts[\\/]|tests[\\/]|--test\b)')
  })
  if ($busy.Count) { throw "Active application/build/test processes; cleanup deferred: $($busy.ProcessId -join ',')" }
  foreach ($target in @($plan | Where-Object action -eq 'delete')) {
    $path = Inside $target.path
    # Only immediate children of the two explicitly authorized roots.
    $parent = Split-Path -Parent $path
    if (!(($parent -eq $root -and ((Split-Path -Leaf $path) -eq 'release' -or (Split-Path -Leaf $path) -like 'release-*')) -or $parent -eq (Join-Path $root 'bench-data'))) { throw "Invalid deletion target: $path" }
    PlainTree $path
    $report['currentTarget'] = $path
    $report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $reportPath -Encoding utf8
    Remove-Item -LiteralPath $path -Recurse -Force
    $report.deleted += $path
    $report.logicalBytesDeleted += $target.bytes
    $report['currentTarget'] = $null
    $report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $reportPath -Encoding utf8
  }
}
} catch {
  $report['error'] = $_.Exception.Message
  throw
} finally {
$report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $reportPath -Encoding utf8
}
$plan | Format-Table action,bytes,path -AutoSize
Write-Output "Report: $reportPath"
Write-Output "Logical bytes deleted: $($report.logicalBytesDeleted)"
