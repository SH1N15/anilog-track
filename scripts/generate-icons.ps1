Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$buildDir = Join-Path $root 'build'
$assetsDir = Join-Path $root 'assets'
New-Item -ItemType Directory -Force -Path $buildDir, $assetsDir | Out-Null

function New-RoundedRectanglePath([float]$x, [float]$y, [float]$width, [float]$height, [float]$radius) {
  $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $diameter = $radius * 2
  $path.AddArc($x, $y, $diameter, $diameter, 180, 90)
  $path.AddArc($x + $width - $diameter, $y, $diameter, $diameter, 270, 90)
  $path.AddArc($x + $width - $diameter, $y + $height - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc($x, $y + $height - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()
  return $path
}

function Save-AppIcon([string]$target) {
  $bitmap = [System.Drawing.Bitmap]::new(256, 256, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.Clear([System.Drawing.Color]::Transparent)

  $background = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#17231c'))
  $mint = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#91d7ad'))
  $rounded = New-RoundedRectanglePath 0 0 256 256 48
  $graphics.FillPath($background, $rounded)

  $outerA = [System.Drawing.PointF[]]@(
    [System.Drawing.PointF]::new(62, 190), [System.Drawing.PointF]::new(110, 60),
    [System.Drawing.PointF]::new(146, 60), [System.Drawing.PointF]::new(194, 190),
    [System.Drawing.PointF]::new(158, 190), [System.Drawing.PointF]::new(148, 161),
    [System.Drawing.PointF]::new(106, 161), [System.Drawing.PointF]::new(96, 190)
  )
  $innerA = [System.Drawing.PointF[]]@(
    [System.Drawing.PointF]::new(116, 130), [System.Drawing.PointF]::new(138, 130),
    [System.Drawing.PointF]::new(127, 96)
  )
  $graphics.FillPolygon($mint, $outerA)
  $graphics.FillPolygon($background, $innerA)
  $bitmap.Save($target, [System.Drawing.Imaging.ImageFormat]::Png)
  $rounded.Dispose()
  $background.Dispose()
  $mint.Dispose()
  $graphics.Dispose()
  $bitmap.Dispose()
}

function Save-TrayIcon([string]$target) {
  $bitmap = [System.Drawing.Bitmap]::new(32, 32, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.Clear([System.Drawing.Color]::Transparent)

  $light = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#eef8f2'))
  $dark = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#17231c'))
  $border = [System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml('#17231c'), 2)
  $rounded = New-RoundedRectanglePath 1 1 30 30 7
  $graphics.FillPath($light, $rounded)
  $graphics.DrawPath($border, $rounded)

  $outerA = [System.Drawing.PointF[]]@(
    [System.Drawing.PointF]::new(7.5, 24), [System.Drawing.PointF]::new(13.8, 7),
    [System.Drawing.PointF]::new(18.2, 7), [System.Drawing.PointF]::new(24.5, 24),
    [System.Drawing.PointF]::new(20.2, 24), [System.Drawing.PointF]::new(18.8, 20.4),
    [System.Drawing.PointF]::new(13.1, 20.4), [System.Drawing.PointF]::new(11.8, 24)
  )
  $innerA = [System.Drawing.PointF[]]@(
    [System.Drawing.PointF]::new(14.3, 16.7), [System.Drawing.PointF]::new(17.7, 16.7),
    [System.Drawing.PointF]::new(16, 11.5)
  )
  $graphics.FillPolygon($dark, $outerA)
  $graphics.FillPolygon($light, $innerA)
  $bitmap.Save($target, [System.Drawing.Imaging.ImageFormat]::Png)
  $rounded.Dispose()
  $light.Dispose()
  $dark.Dispose()
  $border.Dispose()
  $graphics.Dispose()
  $bitmap.Dispose()
}

Save-AppIcon (Join-Path $buildDir 'icon.png')
Save-AppIcon (Join-Path $assetsDir 'app-icon.png')
Save-TrayIcon (Join-Path $assetsDir 'tray.png')
