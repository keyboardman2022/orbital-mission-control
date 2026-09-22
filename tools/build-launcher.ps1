$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $PSScriptRoot 'OrbitalLauncher.cs'
$output = Join-Path $root 'ORBITAL.exe'
$compilerCandidates = @(
  'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe',
  'C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe'
)
$compiler = $compilerCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $compiler) { throw '找不到 Windows .NET Framework C# 编译器。' }

$iconPath = Join-Path ([IO.Path]::GetTempPath()) ('orbital-launcher-' + [Guid]::NewGuid().ToString('N') + '.ico')
Add-Type -AssemblyName System.Drawing
$bitmap = New-Object Drawing.Bitmap 64,64
$graphics = [Drawing.Graphics]::FromImage($bitmap)
try {
  $graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.Clear([Drawing.Color]::FromArgb(5,7,12))
  $orbitPen = New-Object Drawing.Pen ([Drawing.Color]::FromArgb(164,219,166)),3
  $glowBrush = New-Object Drawing.SolidBrush ([Drawing.Color]::FromArgb(255,172,92))
  $holeBrush = New-Object Drawing.SolidBrush ([Drawing.Color]::FromArgb(2,3,7))
  try {
    $graphics.DrawEllipse($orbitPen,6,19,52,27)
    $graphics.FillEllipse($glowBrush,20,20,24,24)
    $graphics.FillEllipse($holeBrush,24,24,16,16)
    $graphics.FillEllipse([Drawing.Brushes]::White,51,18,6,6)
    $icon = [Drawing.Icon]::FromHandle($bitmap.GetHicon())
    try { $stream = [IO.File]::Create($iconPath); try { $icon.Save($stream) } finally { $stream.Dispose() } } finally { $icon.Dispose() }
  } finally { $orbitPen.Dispose(); $glowBrush.Dispose(); $holeBrush.Dispose() }
} finally { $graphics.Dispose(); $bitmap.Dispose() }

try {
  & $compiler /nologo /target:winexe /optimize+ /platform:anycpu /reference:System.dll /reference:System.Windows.Forms.dll /win32icon:$iconPath /out:$output $source
  if ($LASTEXITCODE -ne 0) { throw "启动器编译失败，退出码 $LASTEXITCODE" }
} finally {
  Remove-Item -LiteralPath $iconPath -Force -ErrorAction SilentlyContinue
}
Write-Host "已生成：$output"
