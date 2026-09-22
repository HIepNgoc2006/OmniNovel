param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Action,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$ExtraArgs
)

$ErrorActionPreference = "Stop"

$MobileDir = (Resolve-Path "$PSScriptRoot\..").Path
$PubCacheDir = "$MobileDir\.pub-cache"

if (!(Test-Path $PubCacheDir)) {
    New-Item -ItemType Directory -Path $PubCacheDir -Force | Out-Null
}

$Image = "ghcr.io/cirruslabs/flutter:3.24.5"
$ArgsString = if ($ExtraArgs) { $ExtraArgs -join " " } else { "" }
$Cmd = "flutter $Action $ArgsString".Trim()

Write-Host "[OmniNovel Mobile Runner] Executing: $Cmd inside isolated container ($Image)..." -ForegroundColor Cyan

docker run --rm `
    -v "${MobileDir}:/app" `
    -v "${PubCacheDir}:/root/.pub-cache" `
    -e "PUB_CACHE=/root/.pub-cache" `
    -w /app `
    $Image `
    sh -c "$Cmd"

if ($LASTEXITCODE -ne 0) {
    Write-Error "[OmniNovel Mobile Runner] Command failed with exit code $LASTEXITCODE"
}
