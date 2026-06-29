$ErrorActionPreference = "Continue"
$rg  = "rg-agentmcp"
$app = "nordkapp-ai-proxy"

if (Test-Path app.zip) { Remove-Item app.zip -Force }
Compress-Archive -Path server.js, context.js, package.json, package-lock.json -DestinationPath app.zip -Force
"zip exit=$LASTEXITCODE"

"=== deploy ==="
az webapp deploy --name $app --resource-group $rg --src-path app.zip --type zip 2>&1 | Select-Object -Last 6
"deploy exit=$LASTEXITCODE"
