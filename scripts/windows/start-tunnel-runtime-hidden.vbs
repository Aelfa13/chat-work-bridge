Option Explicit

Dim fileSystem, shell, powerShellPath, launcherPath, command, exitCode
Set fileSystem = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

If WScript.Arguments.Count <> 2 Then
    WScript.Quit 2
End If

powerShellPath = WScript.Arguments(0)
launcherPath = WScript.Arguments(1)

If Not fileSystem.FileExists(powerShellPath) Then
    WScript.Quit 3
End If
If Not fileSystem.FileExists(launcherPath) Then
    WScript.Quit 4
End If

command = Quote(powerShellPath) & _
    " -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden" & _
    " -ExecutionPolicy Bypass -File " & Quote(launcherPath)
exitCode = shell.Run(command, 0, True)
WScript.Quit exitCode

Function Quote(value)
    Quote = Chr(34) & value & Chr(34)
End Function
