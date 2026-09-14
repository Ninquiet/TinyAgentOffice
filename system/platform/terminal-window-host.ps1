param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('list', 'focus')]
  [string]$Command,

  [long]$Handle = 0,
  [int]$TargetPid = 0
)

$code = @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class TerminalWindowHostNative {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")]
  public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool IsWindow(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool IsIconic(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);

  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool BringWindowToTop(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern int GetWindowTextLength(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
}
"@

Add-Type -TypeDefinition $code -ErrorAction Stop

function Get-TerminalWindowList {
  $allowedNames = @('WindowsTerminal', 'OpenConsole', 'conhost', 'powershell', 'cmd')
  $items = New-Object System.Collections.Generic.List[object]

  $callback = [TerminalWindowHostNative+EnumWindowsProc]{
    param($hWnd, $lParam)

    if (-not [TerminalWindowHostNative]::IsWindowVisible($hWnd)) {
      return $true
    }

    $procId = 0
    [void][TerminalWindowHostNative]::GetWindowThreadProcessId($hWnd, [ref]$procId)
    if ($procId -le 0) {
      return $true
    }

    try {
      $proc = Get-Process -Id $procId -ErrorAction Stop
    } catch {
      return $true
    }

    if ($proc.ProcessName -notin $allowedNames) {
      return $true
    }

    $length = [TerminalWindowHostNative]::GetWindowTextLength($hWnd)
    $builder = New-Object System.Text.StringBuilder ($length + 1)
    [void][TerminalWindowHostNative]::GetWindowText($hWnd, $builder, $builder.Capacity)

    $items.Add([pscustomobject]@{
      handle = $hWnd.ToInt64()
      pid = [int]$procId
      processName = $proc.ProcessName
      title = $builder.ToString()
      isMinimized = [TerminalWindowHostNative]::IsIconic($hWnd)
    }) | Out-Null

    return $true
  }

  [TerminalWindowHostNative]::EnumWindows($callback, [IntPtr]::Zero) | Out-Null
  return $items
}

if ($Command -eq 'list') {
  @(
    Get-TerminalWindowList |
      Sort-Object processName, pid, handle
  ) | ConvertTo-Json -Depth 4 -Compress
  exit 0
}

if ($Handle -le 0) {
  throw 'focus requires --Handle > 0.'
}

$windowHandle = [IntPtr]$Handle
if (-not [TerminalWindowHostNative]::IsWindow($windowHandle)) {
  throw "Window handle $Handle is no longer valid."
}

if ([TerminalWindowHostNative]::IsIconic($windowHandle)) {
  [TerminalWindowHostNative]::ShowWindowAsync($windowHandle, 9) | Out-Null
  Start-Sleep -Milliseconds 250
}

[TerminalWindowHostNative]::BringWindowToTop($windowHandle) | Out-Null
[TerminalWindowHostNative]::SetForegroundWindow($windowHandle) | Out-Null

$wsh = New-Object -ComObject WScript.Shell
$activated = $false
if ($TargetPid -gt 0) {
  try {
    $activated = $wsh.AppActivate($TargetPid)
  } catch {
    $activated = $false
  }
}

if (-not $activated) {
  [TerminalWindowHostNative]::SetForegroundWindow($windowHandle) | Out-Null
}

Write-Output '{"ok":true}'
