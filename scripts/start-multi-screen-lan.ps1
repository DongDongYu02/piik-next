param(
    [string]$Address,
    [ValidateRange(1024, 65535)][int]$HttpPort = 18787,
    [ValidateRange(1024, 65535)][int]$HttpsPort = 18788,
    [string]$PublicBaseUrl,
    [ValidateRange(0, 65535)][int]$SfuUdpPort = 0,
    [string]$SfuPublicIP,
    [switch]$NoBuild
)

$ErrorActionPreference = 'Stop'
$repoDirectory = Split-Path -Parent $PSScriptRoot
$lanDirectory = Join-Path $repoDirectory 'build/lan'
$serverExecutable = Join-Path $repoDirectory 'build/dev/piik-server.exe'
$gatewayScript = Join-Path $PSScriptRoot 'lan-preview.mjs'
$nodeExecutable = (Get-Command node -ErrorAction Stop).Source
if ($HttpPort -eq $HttpsPort) { throw 'HTTP and HTTPS must use different ports.' }
if ($PublicBaseUrl) {
    $publicUri = $null
    if (-not [Uri]::TryCreate($PublicBaseUrl, [UriKind]::Absolute, [ref]$publicUri) -or
        $publicUri.Scheme -ne 'https' -or -not $publicUri.Host -or $publicUri.UserInfo -or
        $publicUri.AbsolutePath -ne '/' -or $publicUri.Query -or $publicUri.Fragment) {
        throw 'PublicBaseUrl must be an HTTPS origin without credentials, path, query or fragment.'
    }
    $PublicBaseUrl = $publicUri.GetLeftPart([UriPartial]::Authority)
}

if (-not $Address) {
    $candidates = @(Get-NetAdapter -Physical | Where-Object Status -eq 'Up' | ForEach-Object {
        Get-NetIPAddress -InterfaceIndex $_.InterfaceIndex -AddressFamily IPv4 |
            Where-Object { $_.IPAddress -notlike '169.254.*' -and $_.IPAddress -ne '127.0.0.1' }
    })
    if ($candidates.Count -ne 1) { throw 'Pass -Address with this computer''s LAN IPv4 address.' }
    $Address = $candidates[0].IPAddress
}
$parsedAddress = $null
if (-not [System.Net.IPAddress]::TryParse($Address, [ref]$parsedAddress) -or
    $parsedAddress.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork -or
    [System.Net.IPAddress]::IsLoopback($parsedAddress)) {
    throw 'Address must be a local physical adapter''s LAN IPv4 address.'
}
$lanInterface = @(Get-NetIPAddress -IPAddress $Address -AddressFamily IPv4 -ErrorAction Stop)
$physicalAdapter = @(Get-NetAdapter -Physical | Where-Object { $_.Status -eq 'Up' -and $_.InterfaceIndex -eq $lanInterface[0].InterfaceIndex })
if ($lanInterface.Count -ne 1 -or $physicalAdapter.Count -ne 1) {
    throw 'Address must identify one active physical IPv4 interface.'
}
if ($SfuUdpPort) {
    if (-not $SfuPublicIP) { $SfuPublicIP = $Address }
    $parsedSfuAddress = $null
    if (-not [System.Net.IPAddress]::TryParse($SfuPublicIP, [ref]$parsedSfuAddress) -or
        $parsedSfuAddress.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) {
        throw 'SfuPublicIP must be an IPv4 address reachable by participants.'
    }
    if (Get-NetUDPEndpoint -LocalPort $SfuUdpPort -ErrorAction SilentlyContinue) {
        throw "UDP port $SfuUdpPort is in use. Choose an unused SFU port."
    }
} elseif ($SfuPublicIP) {
    throw 'SfuPublicIP requires SfuUdpPort.'
}
$lanHttpsOrigin = "https://${Address}:$HttpsPort"
if (-not $PublicBaseUrl) { $PublicBaseUrl = $lanHttpsOrigin }
foreach ($binding in @(@('127.0.0.1', $HttpPort), @($Address, $HttpPort), @($Address, $HttpsPort))) {
    if (Get-NetTCPConnection -LocalAddress $binding[0] -LocalPort $binding[1] -State Listen -ErrorAction SilentlyContinue) {
        throw "Port $($binding[0]):$($binding[1]) is in use. Stop the earlier preview first."
    }
}

New-Item -ItemType Directory -Path $lanDirectory -Force | Out-Null
# Private certificate and config stay inside ignored, access-restricted output.
$currentIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$directoryAcl = [System.Security.AccessControl.DirectorySecurity]::new()
$directoryAcl.SetAccessRuleProtection($true, $false)
foreach ($principal in @($currentIdentity.User, [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
    $directoryAcl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
        $principal, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
}
Set-Acl -LiteralPath $lanDirectory -AclObject $directoryAcl
$configPath = Join-Path $lanDirectory 'config.json'
$pfxPath = Join-Path $lanDirectory 'piik-lan.pfx'
$certificatePath = Join-Path $lanDirectory 'piik-lan.cer'
$previousConfig = $null
if (Test-Path -LiteralPath $configPath) { $previousConfig = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json }
$reuse = $previousConfig -and $previousConfig.address -eq $Address -and
    (Test-Path -LiteralPath $pfxPath) -and (Test-Path -LiteralPath $certificatePath)
if ($reuse) {
    $previousCertificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($certificatePath)
    $reuse = $previousCertificate.NotAfter -gt [DateTime]::Now.AddDays(1)
    $previousCertificate.Dispose()
}
if ($reuse) {
    $certificatePassword = $previousConfig.pfxPassword
} else {
    $randomBytes = [byte[]]::new(32)
    $random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $random.GetBytes($randomBytes)
    $random.Dispose()
    $certificatePassword = [Convert]::ToBase64String($randomBytes)
    $rsa = [System.Security.Cryptography.RSA]::Create()
    $rsa.KeySize = 2048
    try {
        $request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
            'CN=Piik LAN', $rsa, [System.Security.Cryptography.HashAlgorithmName]::SHA256,
            [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
        $san = [System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
        $san.AddIpAddress([System.Net.IPAddress]::Parse($Address))
        $san.AddIpAddress([System.Net.IPAddress]::Parse('127.0.0.1'))
        $san.AddDnsName('localhost')
        $request.CertificateExtensions.Add($san.Build())
        $request.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false, $false, 0, $true))
        $request.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new(
            [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature -bor
            [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyEncipherment, $true))
        $usage = [System.Security.Cryptography.OidCollection]::new()
        $usage.Add([System.Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.1')) | Out-Null
        $request.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($usage, $true))
        $certificate = $request.CreateSelfSigned([DateTimeOffset]::Now.AddMinutes(-5), [DateTimeOffset]::Now.AddDays(90))
        try {
            [IO.File]::WriteAllBytes($pfxPath, $certificate.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx, $certificatePassword))
            [IO.File]::WriteAllBytes($certificatePath, $certificate.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert))
        } finally { $certificate.Dispose() }
    } finally { $rsa.Dispose() }
}
$configuration = @{
    address = $Address; httpPort = $HttpPort; httpsPort = $HttpsPort; backendPort = $HttpPort
    pfxPath = $pfxPath; certificatePath = $certificatePath; pfxPassword = $certificatePassword
}
[IO.File]::WriteAllText($configPath, ($configuration | ConvertTo-Json), [Text.UTF8Encoding]::new($false))

if (-not $NoBuild) {
    Push-Location $repoDirectory
    try {
        & npm.cmd run build:web
        if ($LASTEXITCODE -ne 0) { throw 'Web build failed.' }
        & go build -o $serverExecutable ./cmd/piik-server
        if ($LASTEXITCODE -ne 0) { throw 'Server build failed.' }
    } finally { Pop-Location }
}
if (-not (Test-Path -LiteralPath $serverExecutable)) { throw 'Build the server before using -NoBuild.' }

$firewallRuleName = "Piik-MultiScreen-LAN-$Address-$HttpPort-$HttpsPort"
try {
    if (-not (Get-NetFirewallRule -Name $firewallRuleName -ErrorAction SilentlyContinue)) {
        New-NetFirewallRule -Name $firewallRuleName -DisplayName "Piik multi-screen LAN ($Address)" -Direction Inbound -Action Allow -Protocol TCP `
            -LocalAddress $Address -LocalPort @($HttpPort, $HttpsPort) -RemoteAddress LocalSubnet `
            -InterfaceAlias $lanInterface[0].InterfaceAlias -Program $nodeExecutable -Profile Any | Out-Null
    }
} catch { Write-Warning 'Could not add the scoped LAN firewall rule. If clients cannot connect, run this script as administrator.' }
if ($SfuUdpPort) {
    $sfuFirewallRuleName = "Piik-MultiScreen-LAN-SFU-$Address-$SfuUdpPort"
    try {
        if (-not (Get-NetFirewallRule -Name $sfuFirewallRuleName -ErrorAction SilentlyContinue)) {
            New-NetFirewallRule -Name $sfuFirewallRuleName -DisplayName "Piik multi-screen LAN SFU ($Address)" -Direction Inbound -Action Allow -Protocol UDP `
                -LocalAddress $Address -LocalPort $SfuUdpPort -RemoteAddress LocalSubnet `
                -InterfaceAlias $lanInterface[0].InterfaceAlias -Program $serverExecutable -Profile Any | Out-Null
        }
    } catch { Write-Warning 'Could not add the scoped SFU UDP firewall rule. Run this script as administrator if media cannot connect.' }
}

$environmentKeys = @('LISTEN_HOST', 'PORT', 'PUBLIC_BASE_URL', 'ALLOWED_ORIGINS', 'ROOM_DATABASE_PATH', 'PIIK_ENV', 'STUN_URLS', 'NAT_PREDICTION_ENABLED', 'SFU_UDP_PORT', 'SFU_LISTEN_HOST', 'SFU_PUBLIC_IP', 'SFU_ONLY')
$savedEnvironment = @{}
foreach ($key in $environmentKeys) { $savedEnvironment[$key] = [Environment]::GetEnvironmentVariable($key, 'Process') }
$serverProcess = $null
$gatewayProcess = $null
try {
    $env:LISTEN_HOST = '127.0.0.1'
    $env:PORT = [string]$HttpPort
    $env:PUBLIC_BASE_URL = $PublicBaseUrl
    $env:ALLOWED_ORIGINS = (@("http://localhost:$HttpPort", "http://127.0.0.1:$HttpPort", "http://${Address}:$HttpPort", $lanHttpsOrigin, $PublicBaseUrl) | Select-Object -Unique) -join ','
    $env:ROOM_DATABASE_PATH = ':memory:'
    $env:PIIK_ENV = 'development'
    $env:STUN_URLS = ''
    $env:NAT_PREDICTION_ENABLED = 'false'
    $env:SFU_UDP_PORT = if ($SfuUdpPort) { [string]$SfuUdpPort } else { '' }
    $env:SFU_LISTEN_HOST = $Address
    $env:SFU_PUBLIC_IP = if ($SfuUdpPort) { $SfuPublicIP } else { '' }
    $env:SFU_ONLY = if ($SfuUdpPort) { 'true' } else { 'false' }
    $serverProcess = Start-Process -FilePath $serverExecutable -WorkingDirectory $lanDirectory -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $lanDirectory 'server.out.log') -RedirectStandardError (Join-Path $lanDirectory 'server.err.log')
    $ready = $false
    for ($attempt = 0; $attempt -lt 50; $attempt++) {
        if ($serverProcess.HasExited) { throw 'Piik server exited; see build/lan/server.err.log.' }
        try { $ready = (Invoke-RestMethod "http://127.0.0.1:$HttpPort/healthz" -TimeoutSec 1).status -eq 'ok' } catch { }
        if ($ready) { break }
        Start-Sleep -Milliseconds 100
    }
    if (-not $ready) { throw 'Piik server did not become ready.' }
    $gatewayProcess = Start-Process -FilePath $nodeExecutable -ArgumentList @(('"' + $gatewayScript + '"'), ('"' + $configPath + '"')) `
        -WorkingDirectory $repoDirectory -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $lanDirectory 'gateway.out.log') `
        -RedirectStandardError (Join-Path $lanDirectory 'gateway.err.log')
    Write-Host "LAN sharing: https://${Address}:$HttpsPort/multi"
    if ($PublicBaseUrl -ne $lanHttpsOrigin) {
        Write-Host "Domain sharing (requires HTTPS reverse proxy): $PublicBaseUrl/multi"
        Write-Host "Local reverse proxy upstream: http://127.0.0.1:$HttpPort"
    }
    Write-Host "LAN viewing: http://${Address}:$HttpPort/multi"
    if ($SfuUdpPort) {
        Write-Host "Multi-screen server media: UDP ${Address}:$SfuUdpPort (advertised ${SfuPublicIP}:$SfuUdpPort)"
        Write-Host 'The SFU firewall rule allows the local subnet. Public clients require a separate UDP forwarding/firewall rule.'
    } else { Write-Host 'Multi-screen media: direct browser P2P (no server forwarding).' }
    Write-Host "Public certificate: http://${Address}:$HttpPort/piik-lan.cer"
    Write-Host ('Certificate SHA-256: ' + (Get-FileHash -LiteralPath $certificatePath -Algorithm SHA256).Hash)
    Write-Host 'Clients must trust the public piik-lan.cer once before sharing over HTTPS. Never copy the PFX or config.json.'
    Write-Host 'Keep this terminal running. Ctrl+C stops this preview and clears temporary rooms.'
    while (-not $serverProcess.HasExited -and -not $gatewayProcess.HasExited) { Start-Sleep -Seconds 1 }
    throw 'A preview process exited; inspect build/lan/*.err.log.'
} finally {
    foreach ($child in @($gatewayProcess, $serverProcess)) {
        if ($child -and -not $child.HasExited) { Stop-Process -InputObject $child -ErrorAction SilentlyContinue }
    }
    foreach ($key in $environmentKeys) { [Environment]::SetEnvironmentVariable($key, $savedEnvironment[$key], 'Process') }
}
