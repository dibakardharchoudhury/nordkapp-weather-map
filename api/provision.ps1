$ErrorActionPreference = "Continue"
$rg   = "rg-agentmcp"
$loc  = "swedencentral"
$plan = "nordkapp-ai-plan"
$app  = "nordkapp-ai-proxy"
$aoai = "didharchagent-mcp-resource"
$pages = "https://dibakardharchoudhury.github.io"

az account set --subscription "ME-MngEnvMCAP677316-didharch-1" | Out-Null

"=== create plan ==="
az appservice plan create -n $plan -g $rg -l $loc --is-linux --sku B1 2>&1 | Out-Null
"plan exit=$LASTEXITCODE"

"=== create webapp ==="
az webapp create -n $app -g $rg -p $plan --runtime "NODE:20-lts" 2>&1 | Out-Null
"webapp exit=$LASTEXITCODE"

"=== assign system identity ==="
$mi = az webapp identity assign -n $app -g $rg --query principalId -o tsv 2>&1
"MI=$mi"

"=== app settings ==="
az webapp config appsettings set -n $app -g $rg --settings `
  AOAI_ENDPOINT="https://didharchagent-mcp-resource.services.ai.azure.com" `
  AOAI_DEPLOYMENT="model-router" `
  ALLOWED_ORIGINS="$pages" `
  SCM_DO_BUILD_DURING_DEPLOYMENT="true" `
  WEBSITE_NODE_DEFAULT_VERSION="~20" 2>&1 | Out-Null
"settings exit=$LASTEXITCODE"

"=== startup command ==="
az webapp config set -n $app -g $rg --startup-file "node server.js" 2>&1 | Out-Null
"startup exit=$LASTEXITCODE"

"=== keyless role: Cognitive Services OpenAI User on AOAI ==="
$aoaiId = az cognitiveservices account show -n $aoai -g $rg --query id -o tsv
"AOAI_ID=$aoaiId"
az role assignment create --assignee-object-id $mi --assignee-principal-type ServicePrincipal `
  --role "Cognitive Services OpenAI User" --scope $aoaiId 2>&1 | Out-Null
"role exit=$LASTEXITCODE"

"=== result ==="
az webapp show -n $app -g $rg --query "{host:defaultHostName, state:state}" -o json
