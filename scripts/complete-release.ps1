param([switch]$BasicChecks)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Push-Location $root
try {
  $latest = Get-Content artifacts/rivu-directory-latest.json -Raw | ConvertFrom-Json
  $zipStream = [IO.File]::OpenRead($latest.zipPath)
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try { $zipHash = [BitConverter]::ToString($sha256.ComputeHash($zipStream)).Replace('-','') }
  finally { $sha256.Dispose(); $zipStream.Dispose() }
  if ($zipHash -ne $latest.sha256) { throw 'Candidate ZIP hash mismatch; cleanup refused' }
  if (-not $BasicChecks) {
    npm.cmd test
    if ($LASTEXITCODE -ne 0) { throw 'Full tests failed; retaining candidates and fixtures' }
  }
  $beforeExe = $env:RIVU_TEST_EXE
  try {
    $env:RIVU_TEST_EXE = $latest.executablePath
    node tests/desktop-smoke.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Packaged desktop test failed; retaining candidates and fixtures' }
  } finally { $env:RIVU_TEST_EXE = $beforeExe }
  $validationRecord = [ordered]@{
    recordedAt = (Get-Date).ToUniversalTime().ToString('o')
    directory = $latest.directory
    zipSHA256 = $zipHash
    mode = $(if ($BasicChecks) { 'basic' } else { 'full' })
    fullTestsRun = (-not [bool]$BasicChecks)
    desktopPassed = $true
    scope = 'ZIP identity and packaged desktop flows; does not imply all PRD performance targets passed'
  } | ConvertTo-Json
  [IO.File]::WriteAllText((Join-Path $root 'artifacts/release-validation-latest.json'), $validationRecord, (New-Object Text.UTF8Encoding($false)))
  $policyPath = Join-Path $root 'artifacts/artifact-retention.json'
  if (!(Test-Path -LiteralPath $policyPath -PathType Leaf)) {
    $artifactsRoot = Join-Path $root 'artifacts'
    if (Test-Path -LiteralPath $artifactsRoot) {
      if ((Get-Item -LiteralPath $artifactsRoot -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Artifacts directory is a reparse point' }
    } else { New-Item -ItemType Directory -Path $artifactsRoot | Out-Null }
    $templatePath = Join-Path $root 'config/artifact-retention.default.json'
    if (!(Test-Path -LiteralPath $templatePath -PathType Leaf)) { throw 'Artifact retention template is missing' }
    if ((Get-Item -LiteralPath $templatePath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Artifact retention template is a reparse point' }
    Copy-Item -LiteralPath $templatePath -Destination $policyPath
  }
  if ((Get-Item -LiteralPath $policyPath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Artifact retention policy is a reparse point' }
  $policy = Get-Content -LiteralPath $policyPath -Raw | ConvertFrom-Json
  $name = Split-Path -Leaf $latest.directory
  $previous = @($policy.validatedReleases | Where-Object { $_ -ne $name -and (Test-Path -LiteralPath (Join-Path $root $_)) } | Select-Object -First 1)
  $policy.validatedReleases = @($name) + $previous
  $policy | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $policyPath -Encoding utf8
  & (Join-Path $PSScriptRoot 'cleanup-build-artifacts.ps1')
  & (Join-Path $PSScriptRoot 'cleanup-build-artifacts.ps1') -Apply
} finally { Pop-Location }
