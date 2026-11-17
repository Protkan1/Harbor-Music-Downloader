Add-Type -AssemblyName UIAutomationClient
$root = [System.Windows.Automation.AutomationElement]::RootElement
$condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, 'Media Player')
$mp = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $condition)
if ($mp) {
    Write-Output "Found Media Player Window: $($mp.Current.Name)"
    $imgCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Image)
    $imgs = $mp.FindAll([System.Windows.Automation.TreeScope]::Descendants, $imgCond)
    Write-Output "Total image elements: $($imgs.Count)"
    foreach ($img in $imgs) {
        Write-Output "Image: Name='$($img.Current.Name)', HelpText='$($img.Current.HelpText)', AutomationId='$($img.Current.AutomationId)'"
    }
} else {
    Write-Output "Media Player not open"
}
