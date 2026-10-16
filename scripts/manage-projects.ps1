# Native, local-only folder picker for magpie-codex-bridge.
# Run through manage-projects.cmd on Windows. No MCP or network calls are made.
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

if ([string]::IsNullOrWhiteSpace($env:APPDATA)) {
    [System.Windows.Forms.MessageBox]::Show('APPDATA is missing. Please run the manager on Windows.', 'Magpie Project Manager', 'OK', 'Error') | Out-Null
    exit 1
}
$script:configDir = Join-Path $env:APPDATA 'magpie-local-review'
$script:configFile = Join-Path $script:configDir 'projects.json'
$script:projects = New-Object System.Collections.ArrayList

function Load-Projects {
    if (-not (Test-Path -LiteralPath $script:configFile -PathType Leaf)) { return }
    $parsed = ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($script:configFile))
    if ($null -eq $parsed -or $null -eq $parsed.roots) { throw 'Invalid projects.json: missing roots array' }
    foreach ($item in @($parsed.roots)) {
        if (-not $item.name -or -not $item.path) { throw 'Invalid project entry' }
        [void]$script:projects.Add([pscustomobject]@{ name = [string]$item.name; path = [string]$item.path })
    }
}

function Save-Projects {
    if (-not (Test-Path -LiteralPath $script:configDir)) { New-Item -ItemType Directory -Path $script:configDir -Force | Out-Null }
    $payload = @{ roots = @($script:projects | ForEach-Object { @{ name = $_.name; path = $_.path } }) } | ConvertTo-Json -Depth 8
    $tmp = Join-Path $script:configDir ('projects.' + [guid]::NewGuid().ToString('N') + '.tmp')
    try {
        [IO.File]::WriteAllText($tmp, $payload, (New-Object System.Text.UTF8Encoding($false)))
        Move-Item -LiteralPath $tmp -Destination $script:configFile -Force
    } finally {
        if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force }
    }
}

$form = New-Object System.Windows.Forms.Form
$form.Text = 'Magpie - Local Project Manager'
$form.ClientSize = New-Object System.Drawing.Size(740, 440)
$form.StartPosition = 'CenterScreen'
$form.MinimumSize = New-Object System.Drawing.Size(590, 390)
$form.Font = New-Object System.Drawing.Font('Segoe UI', 10)
$form.BackColor = [System.Drawing.Color]::White

$heading = New-Object System.Windows.Forms.Label
$heading.Text = 'Projects available to ChatGPT for read-only review'
$heading.Location = New-Object System.Drawing.Point(22, 20)
$heading.Size = New-Object System.Drawing.Size(680, 30)
$heading.Font = New-Object System.Drawing.Font('Segoe UI Semibold', 12)
$form.Controls.Add($heading)

$description = New-Object System.Windows.Forms.Label
$description.Text = 'Only you can add or remove folders here. Changes apply without restarting Magpie.'
$description.Location = New-Object System.Drawing.Point(22, 54)
$description.Size = New-Object System.Drawing.Size(680, 40)
$description.ForeColor = [System.Drawing.Color]::DimGray
$form.Controls.Add($description)

$list = New-Object System.Windows.Forms.ListView
$list.Location = New-Object System.Drawing.Point(22, 104)
$list.Size = New-Object System.Drawing.Size(690, 226)
$list.Anchor = 'Top,Bottom,Left,Right'
$list.View = 'Details'
$list.FullRowSelect = $true
$list.MultiSelect = $false
$list.HideSelection = $false
[void]$list.Columns.Add('Project', 165)
[void]$list.Columns.Add('Folder', 490)
$form.Controls.Add($list)

$add = New-Object System.Windows.Forms.Button
$add.Text = '+ Add folder'
$add.Size = New-Object System.Drawing.Size(140, 38)
$add.Location = New-Object System.Drawing.Point(22, 350)
$add.Anchor = 'Bottom,Left'
$form.Controls.Add($add)

$remove = New-Object System.Windows.Forms.Button
$remove.Text = 'Remove selected'
$remove.Size = New-Object System.Drawing.Size(165, 38)
$remove.Location = New-Object System.Drawing.Point(172, 350)
$remove.Anchor = 'Bottom,Left'
$form.Controls.Add($remove)

$close = New-Object System.Windows.Forms.Button
$close.Text = 'Done'
$close.Size = New-Object System.Drawing.Size(110, 38)
$close.Location = New-Object System.Drawing.Point(602, 350)
$close.Anchor = 'Bottom,Right'
$close.Add_Click({ $form.Close() })
$form.Controls.Add($close)

$status = New-Object System.Windows.Forms.Label
$status.Text = 'Local permissions only. Do not select your entire home directory.'
$status.Location = New-Object System.Drawing.Point(22, 404)
$status.Size = New-Object System.Drawing.Size(690, 26)
$status.Anchor = 'Bottom,Left,Right'
$status.ForeColor = [System.Drawing.Color]::Gray
$form.Controls.Add($status)

function Refresh-ProjectList {
    $list.Items.Clear()
    foreach ($p in $script:projects) {
        $row = New-Object System.Windows.Forms.ListViewItem($p.name)
        [void]$row.SubItems.Add($p.path)
        [void]$list.Items.Add($row)
    }
}

$add.Add_Click({
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.Description = 'Choose one source project folder to allow for read-only review'
    $dialog.ShowNewFolderButton = $false
    if ($dialog.ShowDialog($form) -ne [System.Windows.Forms.DialogResult]::OK) { return }
    try {
        $selected = (Get-Item -LiteralPath $dialog.SelectedPath -ErrorAction Stop).FullName
        if ([IO.Path]::GetPathRoot($selected) -eq $selected) { throw 'Do not select an entire drive.' }
        if ((Get-Item -LiteralPath $selected).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Symbolic-link folders are not allowed.' }
        foreach ($p in $script:projects) {
            if ($p.path -ieq $selected) { throw 'This folder is already in the list.' }
        }
        $baseName = [IO.Path]::GetFileName($selected.TrimEnd([char[]]@([char]'\', [char]'/')))
        $baseName = ($baseName -replace '[^a-zA-Z0-9_.-]', '-').Trim([char[]]@('-', '.'))
        if (-not $baseName) { $baseName = 'project' }
        $name = $baseName
        $i = 2
        while (@($script:projects | Where-Object { $_.name -eq $name }).Count -gt 0) {
            $name = "$baseName-$i"; $i++
        }
        [void]$script:projects.Add([pscustomobject]@{ name = $name; path = $selected })
        try { Save-Projects }
        catch { $script:projects.RemoveAt($script:projects.Count - 1); throw }
        Refresh-ProjectList
        $status.Text = "Added '$name'. Magpie can read it on the next tool call."
    } catch {
        [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'Cannot add project', 'OK', 'Warning') | Out-Null
    }
})

$remove.Add_Click({
    if ($list.SelectedIndices.Count -lt 1) { return }
    $i = [int]$list.SelectedIndices[0]
    $item = $script:projects[$i]
    if ([System.Windows.Forms.MessageBox]::Show("Remove access to '$($item.name)'?", 'Confirm removal', 'YesNo', 'Question') -ne [System.Windows.Forms.DialogResult]::Yes) { return }
    $script:projects.RemoveAt($i)
    try { Save-Projects }
    catch { $script:projects.Insert($i, $item) | Out-Null; [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'Cannot save', 'OK', 'Error') | Out-Null; return }
    Refresh-ProjectList
    $status.Text = "Removed '$($item.name)'. New requests cannot read it."
})

try { Load-Projects; Refresh-ProjectList }
catch {
    [System.Windows.Forms.MessageBox]::Show("Cannot open project list: $($_.Exception.Message)`n$script:configFile", 'Magpie Project Manager', 'OK', 'Error') | Out-Null
    exit 1
}
[void]$form.ShowDialog()
