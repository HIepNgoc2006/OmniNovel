$ErrorActionPreference = "Stop"

$MobileDir = (Resolve-Path "$PSScriptRoot\..").Path
$PubCacheDir = "$MobileDir\.pub-cache"

if (!(Test-Path $PubCacheDir)) {
    New-Item -ItemType Directory -Path $PubCacheDir -Force | Out-Null
}

$Image = "ghcr.io/cirruslabs/flutter:latest"
$CmdArgs = if ($args) { $args -join " " } else { "" }
$Cmd = "flutter $CmdArgs".Trim()

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
