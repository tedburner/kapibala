# 在临时普通用户中验证真实对象访问；不改被测对象的 ACL，不记录密码或文件内容。
param([Parameter(Mandatory=$true)][string]$Config, [Parameter(Mandatory=$true)][string]$Output)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'Temporary user creation requires the disposable hosted CI job' }
$configValue = Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
$userName = 'kpbl' + [guid]::NewGuid().ToString('N').Substring(0, 10)
$publicDir = Join-Path $env:PUBLIC ('kpbl-' + [guid]::NewGuid().ToString('N'))
$created = $false
$record = $null
try {
  New-Item -ItemType Directory -Path $publicDir | Out-Null
  Copy-Item -LiteralPath $configValue.node -Destination (Join-Path $publicDir 'node.exe')
  Set-Content -LiteralPath (Join-Path $publicDir 'control.txt') -Value 'public-control-readable' -Encoding ASCII
  $inputFile = Join-Path $publicDir 'input.json'
  $configValue | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $inputFile -Encoding UTF8
  $probe = @'
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
(async () => {
 const config = JSON.parse(fs.readFileSync(path.join(__dirname,'input.json'),'utf8').replace(/^\uFEFF/,''));
 const controlReadable = fs.readFileSync(path.join(__dirname,'control.txt'),'utf8').trim()==='public-control-readable';
 const files = config.files.map(file => {
  try { fs.readFileSync(file); return {file,denied:false}; }
  catch(error) { return {file,denied:['EACCES','EPERM'].includes(error.code),code:error.code}; }
 });
 const pipe = await new Promise(resolve => {
  const socket=net.createConnection(config.pipe);
  const timer=setTimeout(()=>{socket.destroy();resolve({denied:false,reason:'timeout'});},5000);
  socket.once('connect',()=>{clearTimeout(timer);socket.destroy();resolve({denied:false,reason:'connected'});});
  socket.once('error',error=>{clearTimeout(timer);socket.destroy();resolve({denied:['EACCES','EPERM'].includes(error.code),code:error.code});});
 });
 console.log(JSON.stringify({user:process.env.USERNAME,controlReadable,files,pipe}));
})().catch(()=>process.exit(2));
'@
  Set-Content -LiteralPath (Join-Path $publicDir 'probe.cjs') -Value $probe -Encoding UTF8
  $password = ConvertTo-SecureString ([guid]::NewGuid().ToString('N') + '!aA9') -AsPlainText -Force
  New-LocalUser -Name $userName -Password $password -AccountNeverExpires | Out-Null
  $created = $true
  $group = Get-LocalGroup -SID 'S-1-5-32-545'
  $sid = (Get-LocalUser -Name $userName).SID.Value
  if (-not (Get-LocalGroupMember -Group $group.Name | Where-Object { $_.SID.Value -eq $sid })) {
    Add-LocalGroupMember -Group $group.Name -Member $userName
  }
  $credential = New-Object System.Management.Automation.PSCredential("$env:COMPUTERNAME\$userName", $password)
  $child = Start-Process -FilePath (Join-Path $publicDir 'node.exe') -ArgumentList @('"' + (Join-Path $publicDir 'probe.cjs') + '"') -Credential $credential -LoadUserProfile -WorkingDirectory $publicDir -RedirectStandardOutput (Join-Path $publicDir 'stdout.json') -RedirectStandardError (Join-Path $publicDir 'stderr.txt') -PassThru -Wait
  if ($child.ExitCode -ne 0) { throw "Second-user probe process failed: $($child.ExitCode)" }
  $observed = Get-Content -LiteralPath (Join-Path $publicDir 'stdout.json') -Raw | ConvertFrom-Json
  $valid = $observed.user -eq $userName -and $observed.controlReadable -eq $true -and @($observed.files | Where-Object { $_.denied -ne $true }).Count -eq 0 -and $observed.pipe.denied -eq $true
  $record = [ordered]@{status=$(if($valid){'passed'}else{'failed'}); owner=$env:USERNAME; observed=$observed}
} finally {
  if ($created) { Remove-LocalUser -Name $userName }
  if (Test-Path -LiteralPath $publicDir) { Remove-Item -LiteralPath $publicDir -Recurse -Force }
  if ($null -ne $record) {
    $record.userRemoved = $null -eq (Get-LocalUser -Name $userName -ErrorAction SilentlyContinue)
    $record.publicProbeRemoved = -not (Test-Path -LiteralPath $publicDir)
    $record | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $Output -Encoding UTF8
  }
}
if ($null -eq $record -or $record.status -ne 'passed' -or -not $record.userRemoved -or -not $record.publicProbeRemoved) { throw 'Cross-user private file or pipe denial assertion failed' }
