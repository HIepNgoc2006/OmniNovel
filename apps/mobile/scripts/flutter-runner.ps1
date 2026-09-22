$ErrorActionPreference = "Stop"

$MobileDir = (Resolve-Path "$PSScriptRoot\..").Path
$PubCacheDir = "$MobileDir\.pub-cache"

if (!(Test-Path $PubCacheDir)) {
    New-Item -ItemType Directory -Path $PubCacheDir -Force | Out-Null
}

# Cố định image Flutter 3.44.0 (Dart 3.12.0) bất biến chống trôi dạt phiên bản
$Image = "ghcr.io/cirruslabs/flutter@sha256:217a3d81b124f3fab82b24633bf66b256cc74528b894e7f17103f70150232077"
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
