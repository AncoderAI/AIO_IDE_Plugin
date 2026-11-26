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
  $name = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::NameProperty, 'AIO 工作台')
  $items = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $name)
  $best = $null
  foreach ($item in $items) {
    try {
      $rect = $item.Current.BoundingRectangle
      if ($rect.Width -gt 10 -and $rect.Height -gt 10 -and $rect.Height -lt 100) { $best = $item; break }
    } catch {}
  }
  return $best
}

function Find-PreviewGroup($window, $aioTab) {
  $aioRect = $aioTab.Current.BoundingRectangle
  $tabType = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::TabItem)
  $tabs = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $tabType)
  $previewTab = $null
  $previewLeft = [double]::NegativeInfinity
  foreach ($tab in $tabs) {
    try {
      $rect = $tab.Current.BoundingRectangle
      if ($rect.Left -lt $aioRect.Left -and [Math]::Abs($rect.Top - $aioRect.Top) -lt 24 -and $rect.Left -gt $previewLeft) {
        $previewTab = $tab
        $previewLeft = $rect.Left
      }
    } catch {}
  }
  if ($null -eq $previewTab) { return $null }
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $current = $previewTab
  while ($null -ne $current) {
    try {
      $rect = $current.Current.BoundingRectangle
      if ($rect.Height -gt 160 -and $rect.Right -le ($aioRect.Left + 24)) { return $current }
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
