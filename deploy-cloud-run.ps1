# =============================================================================
# One-Click Deployment für Google Cloud Run + Cloud Scheduler (Always Free Tier)
# =============================================================================
$ErrorActionPreference = "Stop"

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host " Google Cloud Run Deployment - Buffett Substanz-Scanner" -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan

# 1. Prüfe ob Google Cloud SDK (gcloud) installiert ist
if (-not (Get-Command gcloud -ErrorAction SilentlyContinue)) {
    $sdkPath1 = "$env:LOCALAPPDATA\Google\Cloud SDK\google-cloud-sdk\bin"
    $sdkPath2 = "C:\Program Files (x86)\Google\Cloud SDK\google-cloud-sdk\bin"
    if (Test-Path "$sdkPath1\gcloud.cmd") {
        $env:Path += ";$sdkPath1"
    } elseif (Test-Path "$sdkPath2\gcloud.cmd") {
        $env:Path += ";$sdkPath2"
    } else {
        Write-Host "`n[Hinweis] Google Cloud CLI (gcloud) ist noch nicht installiert." -ForegroundColor Yellow
        $install = Read-Host "Soll das Google Cloud SDK jetzt automatisch über winget installiert werden? (j/n)"
        if ($install -eq "j" -or $install -eq "y") {
            winget install Google.CloudSDK
            Write-Host "`nBitte starten Sie dieses PowerShell-Fenster nach der Installation einmal neu und führen Sie .\deploy-cloud-run.ps1 erneut aus." -ForegroundColor Green
            exit 0
        } else {
            Write-Host "Download-Link: https://cloud.google.com/sdk/docs/install" -ForegroundColor Cyan
            exit 1
        }
    }
}

# 2. Prüfe Google Cloud Login
$activeAccount = gcloud auth list --filter="status:ACTIVE" --format="value(account)" 2>$null
if (-not $activeAccount) {
    Write-Host "`nBitte melden Sie sich im Browser mit Ihrem Google-Konto an..." -ForegroundColor Yellow
    gcloud auth login
} else {
    Write-Host "Angemeldet als: $activeAccount" -ForegroundColor Green
}

# 3. Google Cloud Projekt automatisch anlegen oder auswählen
$currentProject = gcloud config get-value project 2>$null
if (-not $currentProject -or $currentProject -eq "(unset)") {
    $randomSuffix = Get-Random -Minimum 10000 -Maximum 99999
    $newProjectId = "buffett-scanner-$randomSuffix"
    Write-Host "`nErstelle automatisch neues Google Cloud Projekt: $newProjectId ..." -ForegroundColor Cyan
    gcloud projects create $newProjectId --name="Buffett Substanz Scanner"
    gcloud config set project $newProjectId
    $projectId = $newProjectId
} else {
    $projectId = $currentProject
    Write-Host "Verwende Google Cloud Projekt: $projectId" -ForegroundColor Green
}

# us-central1 hat das größte dauerhafte Always-Free-Tier-Kontingent bei Google Cloud Run
$region = "us-central1"
$serviceName = "buffett-substanz-scanner"

Write-Host "`n[1/3] Aktiviere benötigte Google Cloud APIs (Cloud Run, Cloud Build, Cloud Scheduler)..." -ForegroundColor Cyan
gcloud services enable run.googleapis.com cloudbuild.googleapis.com cloudscheduler.googleapis.com artifactregistry.googleapis.com

Write-Host "`n[2/3] Baue Container und veröffentliche auf Google Cloud Run (Scale-to-Zero = 0€ im Leerlauf)..." -ForegroundColor Cyan
gcloud run deploy $serviceName `
    --source . `
    --region $region `
    --allow-unauthenticated `
    --min-instances 0 `
    --max-instances 1 `
    --memory 512Mi `
    --cpu 1 `
    --timeout 120s

$serviceUrl = gcloud run services describe $serviceName --region $region --format="value(status.url)"
Write-Host "`nWebseite erfolgreich veröffentlicht unter:" -ForegroundColor Green
Write-Host " -> $serviceUrl" -ForegroundColor Yellow

Write-Host "`n[3/3] Richte täglichen Google Cloud Scheduler Job (08:00 Uhr Europe/Berlin) ein..." -ForegroundColor Cyan
$jobName = "buffett-daily-scan-job"
$cronUrl = "$serviceUrl/api/cron/daily-scan"

$existingJob = gcloud scheduler jobs describe $jobName --location $region 2>$null
if ($LASTEXITCODE -eq 0) {
    gcloud scheduler jobs update http $jobName `
        --location $region `
        --schedule "0 8 * * *" `
        --time-zone "Europe/Berlin" `
        --uri $cronUrl `
        --http-method POST
} else {
    gcloud scheduler jobs create http $jobName `
        --location $region `
        --schedule "0 8 * * *" `
        --time-zone "Europe/Berlin" `
        --uri $cronUrl `
        --http-method POST
}

Write-Host "`n================================================================" -ForegroundColor Green
Write-Host " FERTIG! Ihre Webseite läuft jetzt live in der Google Cloud:" -ForegroundColor Green
Write-Host " URL: $serviceUrl" -ForegroundColor Yellow
Write-Host " Täglicher Scan: Jeden Morgen um 08:00 Uhr automatisch" -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Green
Start-Process $serviceUrl
