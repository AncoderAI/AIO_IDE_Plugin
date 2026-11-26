param(
  [Parameter(Mandatory = $true)][string]$ReadyFile,
  [Parameter(Mandatory = $true)][string]$RestoreFile
)

Add-Type -AssemblyName System.Windows.Forms
$source = [System.Windows.Forms.Clipboard]::GetDataObject()
$snapshot = New-Object System.Windows.Forms.DataObject
if ($null -ne $source) {
  foreach ($format in $source.GetFormats($false)) {
    $data = $source.GetData($format, $false)
    if ($data -is [System.IO.Stream]) {
      $copy = New-Object System.IO.MemoryStream
      if ($data.CanSeek) { $data.Position = 0 }
      $data.CopyTo($copy)
      $copy.Position = 0
      $data = $copy
    } elseif ($data -is [System.Drawing.Image]) {
      $data = $data.Clone()
    }
    if ($null -ne $data) { $snapshot.SetData($format, $false, $data) }
  }
}
[System.IO.File]::WriteAllText($ReadyFile, 'ready')
while (-not [System.IO.File]::Exists($RestoreFile)) {
  Start-Sleep -Milliseconds 50
}
if ($null -eq $source) {
  [System.Windows.Forms.Clipboard]::Clear()
} else {
  [System.Windows.Forms.Clipboard]::SetDataObject($snapshot, $true)
}
