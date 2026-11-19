# Installs the hub "AirPods" agent on this Windows PC. Run in PowerShell:
#   irm -Headers @{Authorization="Bearer KEY"} HUB/agent/install-airpods.ps1 | iex
# Idempotent: run it again to update. ASCII only on purpose (Windows PowerShell 5.1 encoding).
$ErrorActionPreference = 'Stop'
$HubUrl = '__HUB_URL__'
$HubKey = '__HUB_KEY__'
$Dir = Join-Path $env:LOCALAPPDATA 'bot-hub-airpods'

function Say($m) { Write-Host "`n== $m" -ForegroundColor Cyan }
function Ok($m) { Write-Host "   OK  $m" -ForegroundColor Green }

Say "Dossier $Dir"
New-Item -ItemType Directory -Force -Path $Dir | Out-Null

# Stop a running agent before replacing its files
Get-CimInstance Win32_Process -Filter "Name like 'python%'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*airpods_hub.py*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

$files = @{
__FILES__
}
foreach ($name in $files.Keys) {
  [IO.File]::WriteAllBytes((Join-Path $Dir $name), [Convert]::FromBase64String($files[$name]))
}
$cfg = [ordered]@{ url = $HubUrl; key = $HubKey }
[IO.File]::WriteAllText((Join-Path $Dir 'hub.json'), ($cfg | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))
Ok "Fichiers de l'agent ecrits"

Say 'Python'
function Find-Python {
  $cands = @()
  foreach ($c in 'py', 'python') { $g = Get-Command $c -ErrorAction SilentlyContinue; if ($g) { $cands += $g.Source } }
  $cands += Get-ChildItem "$env:LOCALAPPDATA\Programs\Python\Python3*\python.exe" -ErrorAction SilentlyContinue | ForEach-Object FullName
  foreach ($p in $cands) {
    try { if ((& $p -c "import sys;print(sys.version_info>=(3,9))" 2>$null) -eq 'True') { return $p } } catch {}
  }
  return $null
}
$py = Find-Python
if (-not $py) {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { throw 'Python 3 introuvable et winget absent : installe Python depuis python.org puis relance cette ligne.' }
  winget install -e --id Python.Python.3.12 --scope user --silent --accept-package-agreements --accept-source-agreements | Out-Null
  $py = Find-Python
  if (-not $py) { throw 'Python vient d''etre installe : ferme PowerShell, rouvre-le et relance la meme ligne.' }
}
Ok "Python : $py"

$venvPy = Join-Path $Dir '.venv\Scripts\python.exe'
if (-not (Test-Path $venvPy)) { & $py -m venv (Join-Path $Dir '.venv') }
& $venvPy -m pip install --disable-pip-version-check -q --upgrade numpy sounddevice
if ($LASTEXITCODE -ne 0) { throw 'pip a echoue (connexion internet ?)' }
Ok 'numpy + sounddevice installes'

Say 'Demarrage automatique'
$pyw = Join-Path $Dir '.venv\Scripts\pythonw.exe'
$script = Join-Path $Dir 'airpods_hub.py'
$lnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'Hub AirPods.lnk'
$sh = New-Object -ComObject WScript.Shell
$s = $sh.CreateShortcut($lnk)
$s.TargetPath = $pyw
$s.Arguments = '"' + $script + '"'
$s.WorkingDirectory = $Dir
$s.Description = 'Agent AirPods du hub'
$s.Save()
Ok "Raccourci : $lnk"

Start-Process -FilePath $pyw -ArgumentList ('"' + $script + '"') -WorkingDirectory $Dir -WindowStyle Hidden
Start-Sleep -Seconds 6
Write-Host "`nTermine. L'agent tourne en arriere-plan et demarrera avec Windows." -ForegroundColor Green
Write-Host "Page du hub : $HubUrl/bot/airpods   -   Journal local : $Dir\airpods.log"
Write-Host 'Associe les AirPods au PC en Bluetooth si ce n''est pas deja fait.'
