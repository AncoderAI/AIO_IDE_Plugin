param(
  [Parameter(Mandatory = $true)]
  [int]$TargetProcessId,
  [Parameter(Mandatory = $true)]
  [int]$ExtensionHostProcessId
)

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class AioPreviewNative {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
}
'@

function Find-AioTab($window) {
  foreach ($label in @('AIO 工作台', 'AIO Workbench')) {
    $name = [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::NameProperty, $label)
    $items = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $name)
    foreach ($item in $items) {
      try {
        $rect = $item.Current.BoundingRectangle
        if ($rect.Width -gt 10 -and $rect.Height -gt 10 -and $rect.Height -lt 100) { return $item }
      } catch {}
    }
  }
  return $null
}

function Find-PreviewGroup($window, $aioTab) {
  $aioRect = $aioTab.Current.BoundingRectangle
  $tabType = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::TabItem)
  $tabs = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $tabType)
  $previewTab = $null
  $distance = [double]::PositiveInfinity
  foreach ($tab in $tabs) {
    try {
      $rect = $tab.Current.BoundingRectangle
      $gap = [Math]::Abs($rect.Left - $aioRect.Left)
      if ($gap -gt 1 -and [Math]::Abs($rect.Top - $aioRect.Top) -lt 24 -and $gap -lt $distance) {
        $previewTab = $tab
        $distance = $gap
      }
    } catch {}
  }
  if ($null -eq $previewTab) { return $null }
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $current = $previewTab
  while ($null -ne $current) {
    try {
      $rect = $current.Current.BoundingRectangle
      if ($rect.Height -gt 160 -and ($rect.Right -le ($aioRect.Left + 24) -or $rect.Left -ge ($aioRect.Right - 24))) { return $current }
      $current = $walker.GetParent($current)
    } catch { return $null }
  }
  return $null
}

$ownerProcess = [System.Diagnostics.Process]::GetProcessById($ExtensionHostProcessId)
$last = ''
$cachedHandle = [IntPtr]::Zero
$cachedAioTab = $null
$cachedPreview = $null
$nextLookup = [datetime]::MinValue
while (-not $ownerProcess.HasExited) {
  $state = 'inactive'
  try {
    $handle = [AioPreviewNative]::GetForegroundWindow()
    [uint32]$processId = 0
    [void][AioPreviewNative]::GetWindowThreadProcessId($handle, [ref]$processId)
    if ($processId -eq $TargetProcessId) {
      $window = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
      if ($handle -ne $cachedHandle) {
        $cachedHandle = $handle
        $cachedAioTab = $null
        $cachedPreview = $null
      }
      if ($null -eq $cachedPreview -and [datetime]::UtcNow -ge $nextLookup) {
        $nextLookup = [datetime]::UtcNow.AddSeconds(1)
        if ($null -eq $cachedAioTab) { $cachedAioTab = Find-AioTab $window }
        if ($null -ne $cachedAioTab) { $cachedPreview = Find-PreviewGroup $window $cachedAioTab }
      }
      if ($null -ne $cachedPreview) {
        $state = 'outside'
        $point = New-Object AioPreviewNative+POINT
        if ([AioPreviewNative]::GetCursorPos([ref]$point)) {
          $bounds = $cachedPreview.Current.BoundingRectangle
          if (-not $bounds.IsEmpty -and $bounds.Contains($point.X, $point.Y)) { $state = 'inside' }
        }
      }
    } else {
      $cachedHandle = [IntPtr]::Zero
      $cachedAioTab = $null
      $cachedPreview = $null
    }
  } catch {
    $state = 'inactive'
    $cachedAioTab = $null
    $cachedPreview = $null
  }
  if ($state -ne $last) {
    [Console]::Out.WriteLine($state)
    [Console]::Out.Flush()
    $last = $state
  }
  Start-Sleep -Milliseconds 120
}
