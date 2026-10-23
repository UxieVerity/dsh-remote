' Run frpc without a console window and keep it alive.
' Window style 0 = hidden; True = wait for frpc to exit.
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = dir
exePath = dir & "\frpc.exe"
cfgPath = dir & "\frpc.toml"

Do
  shell.Run """" & exePath & """ -c """ & cfgPath & """", 0, True
  WScript.Sleep 10000
Loop
