; GameBoost setup (Inno Setup 6). Built by .github/workflows/release.yml:
;   iscc /DMyAppVersion=1.2.3 installer\gameboost.iss
; Expects the prepared app in build\app (bin, src, ui, package.json, runtime\node.exe).
; Per-user install – no admin rights needed; GameBoost itself asks for elevation when started.

#define MyAppName "GameBoost"
#ifndef MyAppVersion
  #define MyAppVersion "0.0.0"
#endif
#define MyAppURL "https://github.com/Delido/gameboost"

[Setup]
AppId={{8F3C2A51-6B7E-4E2D-9C1A-47616D654273}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher=Delido
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}/issues
AppUpdatesURL={#MyAppURL}/releases
DefaultDirName={localappdata}\Programs\GameBoost
DisableProgramGroupPage=yes
DisableDirPage=auto
PrivilegesRequired=lowest
OutputDir=..\dist
OutputBaseFilename=GameBoost-Setup-{#MyAppVersion}
SetupIconFile=..\ui\icon.ico
UninstallDisplayIcon={app}\ui\icon.ico
UninstallDisplayName={#MyAppName}
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
CloseApplications=yes
RestartApplications=no
VersionInfoVersion={#MyAppVersion}

[Languages]
Name: "german"; MessagesFile: "compiler:Languages\German.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Desktop-Verknüpfung erstellen"; GroupDescription: "Verknüpfungen:"

[Files]
Source: "..\build\app\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[InstallDelete]
; Remove files of older versions that no longer exist
Type: filesandordirs; Name: "{app}\src"
Type: filesandordirs; Name: "{app}\ui"
Type: filesandordirs; Name: "{app}\bin"

[Run]
; Start menu (+ desktop) shortcut with "Run as administrator" flag and without console window
Filename: "{app}\runtime\node.exe"; Parameters: """{app}\bin\gameboost.js"" install --desktop"; Tasks: desktopicon; Flags: runhidden
Filename: "{app}\runtime\node.exe"; Parameters: """{app}\bin\gameboost.js"" install"; Tasks: not desktopicon; Flags: runhidden
Filename: "{userprograms}\GameBoost.lnk"; Description: "GameBoost jetzt starten"; Flags: postinstall shellexec nowait skipifsilent

[UninstallRun]
Filename: "{app}\runtime\node.exe"; Parameters: """{app}\bin\gameboost.js"" cleanup"; Flags: runhidden; RunOnceId: "GameBoostCleanup"

[Code]
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  ResultCode: Integer;
begin
  if CurUninstallStep = usUninstall then
  begin
    // SuppressibleMsgBox: silent uninstalls (/SUPPRESSMSGBOXES) keep the changes (default: No)
    if SuppressibleMsgBox('Sollen alle von GameBoost vorgenommenen Systemänderungen auf die ursprünglichen Werte zurückgesetzt werden?' + #13#10#13#10 +
              'Empfohlen, wenn du GameBoost nicht erneut installieren willst. (Windows fragt dafür nach Administratorrechten.)',
              mbConfirmation, MB_YESNO, IDNO) = IDYES then
      Exec(ExpandConstant('{app}\runtime\node.exe'), '"' + ExpandConstant('{app}\bin\gameboost.js') + '" revert --all', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  end;
end;
