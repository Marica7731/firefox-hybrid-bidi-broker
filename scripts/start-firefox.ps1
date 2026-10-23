<# Starts ONE test-only Firefox profile. Run once per configured instance with different ports/profile paths.
   Example: .\scripts\start-firefox.ps1 -Port 9222 -ProfileDir .\.data\firefox-a
   Never point ProfileDir at a personal browsing profile. #>
param(
  [Parameter(Mandatory=$true)][ValidateRange(1024,65535)][int]$Port,
  [Parameter(Mandatory=$true)][string]$ProfileDir,
  [string]$FirefoxPath = 'C:\Program Files\Mozilla Firefox\firefox.exe'
)
$ErrorActionPreference='Stop'
if(!(Test-Path $FirefoxPath)){throw "Firefox executable not found: $FirefoxPath"}
$full=[System.IO.Path]::GetFullPath($ProfileDir)
New-Item -ItemType Directory -Force -Path $full | Out-Null
Start-Process -FilePath $FirefoxPath -ArgumentList @('-no-remote','-profile',"`"$full`"",'--remote-debugging-port',$Port)
Write-Host "Firefox test instance requested. BiDi: ws://127.0.0.1:$Port/session"
