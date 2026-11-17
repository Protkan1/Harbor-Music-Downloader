param([string]$path)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
Function Await($WinRtTask, $ResultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
    $netTask = $asTask.Invoke($null, @($WinRtTask))
    $netTask.Wait(-1) | Out-Null
    $netTask.Result
}
[Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
$fullPath = [System.IO.Path]::GetFullPath($path)
$op = [Windows.Storage.StorageFile]::GetFileFromPathAsync($fullPath)
$file = Await $op ([Windows.Storage.StorageFile])
$propsOp = $file.Properties.GetMusicPropertiesAsync()
$props = Await $propsOp ([Windows.Storage.FileProperties.MusicProperties])
Write-Output "Title: $($props.Title)"
Write-Output "Artist: $($props.Artist)"
Write-Output "Album: $($props.Album)"

$thumbOp = $file.GetThumbnailAsync([Windows.Storage.FileProperties.ThumbnailMode]::MusicView, 512, [Windows.Storage.FileProperties.ThumbnailOptions]::UseCurrentScale)
$thumb = Await $thumbOp ([Windows.Storage.FileProperties.StorageItemThumbnail])
Write-Output "Thumbnail Type: $($thumb.Type), Size: $($thumb.OriginalWidth)x$($thumb.OriginalHeight)"
