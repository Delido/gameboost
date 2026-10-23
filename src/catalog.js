// Catalog of all tweaks. Each tweak is a list of declarative operations that the engine
// can detect, apply (with backup of the original value) and revert.
//
// risk:   safe | moderate | advanced
// reboot: none | explorer | logoff | reboot
// impact: 1 (gering) .. 3 (hoch) – used for the optimization score
// Categories marked `optional` are matters of taste: they are not part of presets or the score.
import { fileURLToPath } from "node:url";

const HKCU = "HKCU";
const HKLM = "HKLM";

/** Registry value. `def` is used when reverting without a backup (undefined = delete value). */
const reg = (hive, path, name, kind, value, def) => ({ type: "reg", hive, path, name, kind, value, def });
const dword = (hive, path, name, value, def) => reg(hive, path, name, "DWord", value, def);
const str = (hive, path, name, value, def) => reg(hive, path, name, "String", value, def);
/** Service start type: Disabled | Manual | Automatic */
const svc = (name, startup) => ({ type: "service", name, startup });
/** Power setting (AC index) of the active power plan. */
const power = (sub, setting, ac) => ({ type: "power", sub, setting, ac });
/** Custom PowerShell. apply may return a backup object which revert receives as $backup. */
const custom = (detect, apply, revert, { admin = true } = {}) => ({ type: "custom", detect, apply, revert, admin });

export const CATEGORIES = [
  { id: "gaming", title: "Gaming", icon: "🎮", description: "Spielmodus, Aufnahme-Overhead, Vollbild und Scheduler-Prioritäten" },
  { id: "power", title: "CPU & Energie", icon: "⚡", description: "Energieplan, Core Parking und Stromsparfunktionen" },
  { id: "network", title: "Netzwerk & Latenz", icon: "🌐", description: "Ping, Paket-Drosselung und Hintergrund-Downloads" },
  { id: "input", title: "Maus & Tastatur", icon: "🖱️", description: "Rohe Mauseingabe und störende Tastenkürzel" },
  { id: "services", title: "Dienste", icon: "⚙️", description: "Unnötige Hintergrunddienste abschalten" },
  { id: "privacy", title: "Hintergrund & Telemetrie", icon: "🛡️", description: "Telemetrie, Werbung, Copilot und Hintergrund-Apps" },
  { id: "visual", title: "Darstellung", icon: "✨", description: "Animationen und Effekte für ein reaktionsschnelleres System" },
  { id: "system", title: "System", icon: "🧠", description: "Speicher, Dateisystem, Updates und Sicherheit vs. Leistung" },
  { id: "contextmenu", title: "Kontextmenü", icon: "📋", description: "Rechtsklick-Menü aufräumen und erweitern", optional: true },
];

const MMCSS = String.raw`SOFTWARE\Microsoft\Windows NT\CurrentVersion\Multimedia\SystemProfile`;
const SUB_PROCESSOR = "54533251-82be-4824-96c1-47b60b740d00";
const SUB_USB = "2a737441-1930-4402-8d77-b2bebba308a3";
const SUB_PCIE = "501a4d13-42af-4429-9fd1-a8218c268e20";

// Own, fixed GUID for the "GameBoost Ultimate" power plan so it can be detected reliably.
export const GAMEBOOST_PLAN = "6a6d6542-6f6f-4374-8000-47616d654273";

export const ULTIMATE_PLAN_PS = String.raw`
function GB-EnsurePlan {
  $guid = '${GAMEBOOST_PLAN}'
  $list = powercfg /list
  if (-not ("$list" -match $guid)) {
    $code = GB-Run "$env:SystemRoot\System32\powercfg.exe" @('-duplicatescheme', 'e9a42b02-d5df-448d-aa00-03f14749eb61', $guid)
    if ($code -ne 0 -or -not ("$(powercfg /list)" -match $guid)) {
      GB-Run "$env:SystemRoot\System32\powercfg.exe" @('-duplicatescheme', '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c', $guid) | Out-Null
    }
    if (-not ("$(powercfg /list)" -match $guid)) { throw 'Energieplan konnte nicht erstellt werden (Modern Standby?)' }
    powercfg -changename $guid 'GameBoost Ultimate' 'Höchstleistung für Spiele (erstellt von GameBoost)' | Out-Null
  }
  return $guid
}
`;

const BLOCKED = String.raw`Software\Microsoft\Windows\CurrentVersion\Shell Extensions\Blocked`;
/** Hides a shell extension / Windows 11 menu entry for the current user. */
const block = (clsid) => str(HKCU, BLOCKED, clsid, "");
const CLASSIC_MENU = String.raw`Software\Classes\CLSID\{86ca1aa0-34aa-4e8b-a509-50c905bae2a2}`;

// Own context menu entries call the GameBoost CLI of this installation.
const psq = (v) => "'" + String(v).replace(/'/g, "''") + "'";
const CLI = fileURLToPath(new URL("../bin/gameboost.js", import.meta.url));
const ICON = fileURLToPath(new URL("../ui/icon.ico", import.meta.url));
const cliCommand = (args) => `"${process.env.SystemRoot || "C:\\Windows"}\\System32\\conhost.exe" --headless "${process.execPath}" "${CLI}" ${args}`;

/** Custom op for an own context menu verb (HKCU\Software\Classes\<class>\shell\GameBoost.<id>). */
function verb(id, classes, label, command, extra = {}) {
  const keys = classes.map((c) => psq(`Software\\Classes\\${c}\\shell\\GameBoost.${id}`)).join(", ");
  const set = Object.entries({ MUIVerb: label, ...extra }).map(([n, v]) => `GB-RegSet 'HKCU' $k ${psq(n)} 'String' ${psq(v)}`).join("; ");
  return custom(
    String.raw`
      foreach ($k in @(${keys})) { $c = GB-RegGet 'HKCU' "$k\command" ''; if (-not $c.exists -or $c.value -ne ${psq(command)}) { return $false } }
      return $true`,
    String.raw`
      foreach ($k in @(${keys})) { ${set}; GB-RegSet 'HKCU' "$k\command" '' 'String' ${psq(command)} }
      return @{}`,
    String.raw`foreach ($k in @(${keys})) { [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($k, $false) }`,
    { admin: false },
  );
}

const TELEMETRY_TASKS = [
  String.raw`\Microsoft\Windows\Application Experience\|Microsoft Compatibility Appraiser`,
  String.raw`\Microsoft\Windows\Application Experience\|ProgramDataUpdater`,
  String.raw`\Microsoft\Windows\Application Experience\|MareBackup`,
  String.raw`\Microsoft\Windows\Application Experience\|PcaPatchDbTask`,
  String.raw`\Microsoft\Windows\Autochk\|Proxy`,
  String.raw`\Microsoft\Windows\Customer Experience Improvement Program\|Consolidator`,
  String.raw`\Microsoft\Windows\Customer Experience Improvement Program\|UsbCeip`,
  String.raw`\Microsoft\Windows\DiskDiagnostic\|Microsoft-Windows-DiskDiagnosticDataCollector`,
  String.raw`\Microsoft\Windows\Feedback\Siuf\|DmClient`,
  String.raw`\Microsoft\Windows\Feedback\Siuf\|DmClientOnScenarioDownload`,
  String.raw`\Microsoft\Windows\Windows Error Reporting\|QueueReporting`,
];
const TASKS_PS = `$GB_TASKS = @(${TELEMETRY_TASKS.map(psq).join(", ")})\n`;

const MSI_PS = String.raw`
$GB_MSI = @(Get-PnpDevice -Class Display -PresentOnly -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -like 'PCI\*' } | ForEach-Object {
  "SYSTEM\CurrentControlSet\Enum\$($_.InstanceId)\Device Parameters\Interrupt Management\MessageSignaledInterruptProperties"
})
`;

export const TWEAKS = [
  // ───────────────────────────── Gaming ─────────────────────────────
  {
    id: "game-mode",
    category: "gaming",
    title: "Windows-Spielmodus aktivieren",
    description: "Priorisiert Spiele bei CPU/GPU-Ressourcen und verhindert Treiber-Updates und Neustart-Hinweise während des Spielens.",
    risk: "safe", reboot: "none", impact: 2,
    ops: [
      dword(HKCU, String.raw`Software\Microsoft\GameBar`, "AutoGameModeEnabled", 1, 1),
      dword(HKCU, String.raw`Software\Microsoft\GameBar`, "AllowAutoGameMode", 1, 1),
    ],
  },
  {
    id: "disable-game-dvr",
    category: "gaming",
    title: "Game DVR / Hintergrundaufnahme deaktivieren",
    description: "Die Xbox-Game-Bar-Hintergrundaufnahme kostet permanent GPU-Leistung und Encoder-Zeit. Manuelle Screenshots per Game Bar bleiben möglich.",
    risk: "safe", reboot: "none", impact: 3,
    ops: [
      dword(HKCU, String.raw`System\GameConfigStore`, "GameDVR_Enabled", 0, 1),
      dword(HKCU, String.raw`Software\Microsoft\Windows\CurrentVersion\GameDVR`, "AppCaptureEnabled", 0, 1),
      dword(HKCU, String.raw`Software\Microsoft\Windows\CurrentVersion\GameDVR`, "HistoricalCaptureEnabled", 0, 0),
      dword(HKLM, String.raw`SOFTWARE\Policies\Microsoft\Windows\GameDVR`, "AllowGameDVR", 0),
    ],
  },
  {
    id: "windowed-optimizations",
    category: "gaming",
    title: "Optimierungen für Spiele im Fenstermodus",
    description: "Nutzt das Flip-Modell auch für DirectX 10/11-Spiele im randlosen Fenster: geringere Latenz und VRR/Auto-HDR-Unterstützung.",
    risk: "safe", reboot: "none", impact: 2,
    ops: [str(HKCU, String.raw`Software\Microsoft\DirectX\UserGpuPreferences`, "DirectXUserGlobalSettings", "SwapEffectUpgradeEnable=1;")],
  },
  {
    id: "hags",
    category: "gaming",
    title: "Hardwarebeschleunigte GPU-Planung (HAGS)",
    description: "Die GPU verwaltet ihren Videospeicher selbst. Reduziert Latenz und ist Voraussetzung für DLSS Frame Generation. Benötigt aktuelle Treiber.",
    risk: "moderate", reboot: "reboot", impact: 2,
    ops: [dword(HKLM, String.raw`SYSTEM\CurrentControlSet\Control\GraphicsDrivers`, "HwSchMode", 2, 1)],
  },
  {
    id: "mmcss-games",
    category: "gaming",
    title: "Multimedia-Scheduler auf Spiele ausrichten",
    description: "Gibt Spiel-Threads im MMCSS höchste GPU- und CPU-Priorität und reserviert weniger CPU-Zeit für Hintergrundaufgaben.",
    risk: "moderate", reboot: "reboot", impact: 2,
    ops: [
      dword(HKLM, MMCSS, "SystemResponsiveness", 10, 20),
      dword(HKLM, MMCSS + String.raw`\Tasks\Games`, "GPU Priority", 8, 8),
      dword(HKLM, MMCSS + String.raw`\Tasks\Games`, "Priority", 6, 2),
      str(HKLM, MMCSS + String.raw`\Tasks\Games`, "Scheduling Category", "High", "Medium"),
      str(HKLM, MMCSS + String.raw`\Tasks\Games`, "SFIO Priority", "High", "Normal"),
    ],
  },
  {
    id: "priority-separation",
    category: "gaming",
    title: "Vordergrund-Programme bevorzugen (Win32PrioritySeparation)",
    description: "Kurze, variable Zeitscheiben mit Bonus für das aktive Fenster (Wert 0x26). Verbessert Frametimes in CPU-limitierten Spielen.",
    risk: "moderate", reboot: "none", impact: 2,
    ops: [dword(HKLM, String.raw`SYSTEM\CurrentControlSet\Control\PriorityControl`, "Win32PrioritySeparation", 0x26, 2)],
  },
  {
    id: "disable-fso",
    category: "gaming",
    title: "Vollbildoptimierungen global deaktivieren",
    description: "Erzwingt echtes exklusives Vollbild bei älteren Spielen. Unter Windows 11 meist nicht nötig – kann Alt-Tab verlangsamen und Overlays stören.",
    risk: "advanced", reboot: "logoff", impact: 1,
    ops: [
      dword(HKCU, String.raw`System\GameConfigStore`, "GameDVR_FSEBehaviorMode", 2, 0),
      dword(HKCU, String.raw`System\GameConfigStore`, "GameDVR_FSEBehavior", 2),
      dword(HKCU, String.raw`System\GameConfigStore`, "GameDVR_HonorUserFSEBehaviorMode", 1, 0),
      dword(HKCU, String.raw`System\GameConfigStore`, "GameDVR_DXGIHonorFSEWindowsCompatible", 1, 0),
    ],
  },
  {
    id: "global-timer-resolution",
    category: "gaming",
    title: "Globale Timer-Auflösung erlauben",
    description: "Unter Windows 11 wirken hohe Timer-Auflösungen nur noch pro Prozess. Damit gelten sie wieder systemweit – gleichmäßigere Frametimes, minimal höherer Verbrauch.",
    risk: "advanced", reboot: "reboot", impact: 1,
    ops: [dword(HKLM, String.raw`SYSTEM\CurrentControlSet\Control\Session Manager\kernel`, "GlobalTimerResolutionRequests", 1)],
  },

  {
    id: "gpu-msi-mode",
    category: "gaming",
    title: "MSI-Modus für die Grafikkarte",
    description: "Die GPU meldet Interrupts als Message Signaled Interrupts statt über geteilte Leitungen – geringere DPC-Latenz. Aktuelle NVIDIA/AMD-Treiber aktivieren das meist selbst; nach einer Treiber-Neuinstallation ggf. erneut anwenden.",
    risk: "advanced", reboot: "reboot", impact: 1,
    ops: [
      custom(
        MSI_PS + String.raw`
          if ($GB_MSI.Count -eq 0) { return $false }
          foreach ($k in $GB_MSI) { $v = GB-RegGet 'HKLM' $k 'MSISupported'; if (-not ($v.exists -and $v.value -eq 1)) { return $false } }
          return $true`,
        MSI_PS + String.raw`
          if ($GB_MSI.Count -eq 0) { throw 'Keine PCIe-Grafikkarte gefunden.' }
          $bk = @{}
          foreach ($k in $GB_MSI) { $bk[$k] = GB-RegGet 'HKLM' $k 'MSISupported'; GB-RegSet 'HKLM' $k 'MSISupported' 'DWord' 1 }
          return $bk`,
        MSI_PS + String.raw`
          foreach ($k in $GB_MSI) {
            $orig = if ($backup) { $backup.$k } else { $null }
            if ($orig -and $orig.exists) { GB-RegSet 'HKLM' $k 'MSISupported' $orig.kind $orig.value } else { GB-RegDel 'HKLM' $k 'MSISupported' }
          }`,
      ),
    ],
  },

  // ───────────────────────────── CPU & Energie ─────────────────────────────
  {
    id: "ultimate-power-plan",
    category: "power",
    title: "Energieplan „Ultimative Leistung“",
    description: "Erstellt und aktiviert einen eigenen Höchstleistungsplan ohne Energiespar-Latenzen. Beim Zurücksetzen wird der vorherige Plan wieder aktiv.",
    risk: "safe", reboot: "none", impact: 3,
    ops: [
      custom(
        `return (GB-ActiveScheme) -eq '${GAMEBOOST_PLAN}'`,
        ULTIMATE_PLAN_PS + String.raw`
          $prev = GB-ActiveScheme
          $guid = GB-EnsurePlan
          powercfg /setactive $guid | Out-Null
          if ($prev -eq $guid) { $prev = '381b4222-f694-41f0-9685-ff5bb260df2e' }
          return @{ previous = $prev }`,
        String.raw`
          $target = if ($backup -and $backup.previous) { $backup.previous } else { '381b4222-f694-41f0-9685-ff5bb260df2e' }
          powercfg /setactive $target | Out-Null
          if ($LASTEXITCODE -ne 0) { powercfg /setactive 381b4222-f694-41f0-9685-ff5bb260df2e | Out-Null }
          GB-Run "$env:SystemRoot\System32\powercfg.exe" @('/delete', '${GAMEBOOST_PLAN}') | Out-Null`,
      ),
    ],
  },
  {
    id: "disable-core-parking",
    category: "power",
    title: "Core Parking deaktivieren",
    description: "Hält alle CPU-Kerne aktiv, damit sie bei Lastspitzen nicht erst „aufwachen“ müssen. Gilt für den aktiven Energieplan (Netzbetrieb).",
    risk: "safe", reboot: "none", impact: 2,
    ops: [power(SUB_PROCESSOR, "0cc5b647-c1df-4637-891a-dec35c318583", 100)],
  },
  {
    id: "min-processor-state",
    category: "power",
    title: "Minimaler Prozessorzustand 100 %",
    description: "Die CPU taktet nie herunter. Maximale Reaktionszeit, aber mehr Abwärme und Stromverbrauch im Leerlauf.",
    risk: "advanced", reboot: "none", impact: 1,
    ops: [power(SUB_PROCESSOR, "893dee8e-2bef-41e0-89c6-b55d0929964c", 100)],
  },
  {
    id: "disable-power-throttling",
    category: "power",
    title: "Power Throttling deaktivieren",
    description: "Verhindert, dass Windows Hintergrundprozesse (z. B. Spiele-Launcher, Voice-Chat) auf Effizienzkerne drosselt. Auf Laptops sinkt die Akkulaufzeit.",
    risk: "moderate", reboot: "reboot", impact: 2,
    ops: [dword(HKLM, String.raw`SYSTEM\CurrentControlSet\Control\Power\PowerThrottling`, "PowerThrottlingOff", 1)],
  },
  {
    id: "disable-usb-suspend",
    category: "power",
    title: "Selektives USB-Energiesparen deaktivieren",
    description: "Verhindert, dass Maus, Tastatur oder Headset kurzzeitig in den Ruhezustand gehen (Aussetzer, Eingabeverzögerung).",
    risk: "safe", reboot: "none", impact: 1,
    ops: [power(SUB_USB, "48e6b7a6-50f5-4782-a5d4-53bb8f07e226", 0)],
  },
  {
    id: "disable-pcie-aspm",
    category: "power",
    title: "PCI-Express-Energiesparmodus aus",
    description: "Deaktiviert Link State Power Management, damit GPU und NVMe-SSD ohne Aufwach-Latenz angebunden bleiben.",
    risk: "safe", reboot: "none", impact: 1,
    ops: [power(SUB_PCIE, "ee12f906-d277-404b-b6da-e5fa1a576df5", 0)],
  },
  {
    id: "disable-fast-startup",
    category: "power",
    title: "Schnellstart deaktivieren",
    description: "Der Schnellstart ist ein Halb-Ruhezustand: Treiber werden nie frisch geladen. Ohne ihn startet Windows sauber (wichtig nach GPU-Treiber-Updates).",
    risk: "safe", reboot: "none", impact: 1,
    ops: [dword(HKLM, String.raw`SYSTEM\CurrentControlSet\Control\Session Manager\Power`, "HiberbootEnabled", 0, 1)],
  },
  {
    id: "disable-hibernation",
    category: "power",
    title: "Ruhezustand deaktivieren",
    description: "Löscht die hiberfil.sys (oft 10–30 GB) und gibt Speicherplatz frei. Auf Laptops geht dabei der Ruhezustand verloren.",
    risk: "moderate", reboot: "none", impact: 1,
    ops: [
      custom(
        String.raw`$v = GB-RegGet 'HKLM' 'SYSTEM\CurrentControlSet\Control\Power' 'HibernateEnabled'; return ($v.exists -and $v.value -eq 0)`,
        `powercfg /hibernate off | Out-Null; return @{}`,
        `powercfg /hibernate on | Out-Null`,
      ),
    ],
  },

  // ───────────────────────────── Netzwerk ─────────────────────────────
  {
    id: "network-throttling",
    category: "network",
    title: "Netzwerk-Drosselung abschalten",
    description: "Windows drosselt Netzwerkpakete, während Multimedia läuft. Abschalten verhindert Ping-Spitzen bei gleichzeitiger Musik oder Voice-Chat.",
    risk: "safe", reboot: "reboot", impact: 2,
    ops: [dword(HKLM, MMCSS, "NetworkThrottlingIndex", 0xffffffff, 10)],
  },
  {
    id: "disable-nagle",
    category: "network",
    title: "Nagle-Algorithmus deaktivieren",
    description: "Sendet kleine TCP-Pakete sofort statt sie zu bündeln (TcpAckFrequency/TCPNoDelay) – bringt geringeren Ping in TCP-basierten Spielen (z. B. MMOs).",
    risk: "moderate", reboot: "reboot", impact: 2,
    ops: [
      custom(
        String.raw`
          $base = 'SYSTEM\CurrentControlSet\Services\Tcpip\Parameters\Interfaces'
          $k = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey($base)
          $ifs = @($k.GetSubKeyNames() | Where-Object { $s = $k.OpenSubKey($_); $ip = $s.GetValue('DhcpIPAddress'); $st = $s.GetValue('IPAddress'); $s.Close(); ($ip -and $ip -ne '0.0.0.0') -or ($st -and "$st" -ne '0.0.0.0' -and "$st" -ne '') })
          $k.Close()
          if ($ifs.Count -eq 0) { return $false }
          foreach ($i in $ifs) {
            $a = GB-RegGet 'HKLM' "$base\$i" 'TcpAckFrequency'; $b = GB-RegGet 'HKLM' "$base\$i" 'TCPNoDelay'
            if (-not ($a.exists -and $a.value -eq 1 -and $b.exists -and $b.value -eq 1)) { return $false }
          }
          return $true`,
        String.raw`
          $base = 'SYSTEM\CurrentControlSet\Services\Tcpip\Parameters\Interfaces'
          $k = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey($base)
          $names = $k.GetSubKeyNames(); $k.Close()
          $bk = @{}
          foreach ($i in $names) {
            $p = "$base\$i"
            $bk[$i] = @{ TcpAckFrequency = (GB-RegGet 'HKLM' $p 'TcpAckFrequency'); TCPNoDelay = (GB-RegGet 'HKLM' $p 'TCPNoDelay'); TcpDelAckTicks = (GB-RegGet 'HKLM' $p 'TcpDelAckTicks') }
            GB-RegSet 'HKLM' $p 'TcpAckFrequency' 'DWord' 1
            GB-RegSet 'HKLM' $p 'TCPNoDelay' 'DWord' 1
            GB-RegSet 'HKLM' $p 'TcpDelAckTicks' 'DWord' 0
          }
          return $bk`,
        String.raw`
          $base = 'SYSTEM\CurrentControlSet\Services\Tcpip\Parameters\Interfaces'
          $k = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey($base)
          $names = $k.GetSubKeyNames(); $k.Close()
          foreach ($i in $names) {
            $p = "$base\$i"
            foreach ($n in 'TcpAckFrequency', 'TCPNoDelay', 'TcpDelAckTicks') {
              $orig = if ($backup) { $backup.$i.$n } else { $null }
              if ($orig -and $orig.exists) { GB-RegSet 'HKLM' $p $n $orig.kind $orig.value } else { GB-RegDel 'HKLM' $p $n }
            }
          }`,
      ),
    ],
  },
  {
    id: "disable-delivery-optimization",
    category: "network",
    title: "Update-Verteilung (P2P) deaktivieren",
    description: "Verhindert, dass dein PC Windows-Updates im Hintergrund an andere Rechner hochlädt und so Bandbreite und Ping kostet.",
    risk: "safe", reboot: "none", impact: 2,
    ops: [dword(HKLM, String.raw`SOFTWARE\Policies\Microsoft\Windows\DeliveryOptimization`, "DODownloadMode", 0)],
  },
  {
    id: "disable-bandwidth-reserve",
    category: "network",
    title: "QoS-Bandbreitenreservierung aufheben",
    description: "Stellt sicher, dass der QoS-Paketplaner keine Bandbreite für System-Traffic zurückhält.",
    risk: "safe", reboot: "reboot", impact: 1,
    ops: [dword(HKLM, String.raw`SOFTWARE\Policies\Microsoft\Windows\Psched`, "NonBestEffortLimit", 0)],
  },

  // ───────────────────────────── Eingabe ─────────────────────────────
  {
    id: "disable-mouse-acceleration",
    category: "input",
    title: "Mausbeschleunigung deaktivieren",
    description: "Schaltet „Zeigerpräzision verbessern“ ab: 1:1-Mausbewegung für konstantes Aiming. Wirkt nach Neuanmeldung.",
    risk: "safe", reboot: "logoff", impact: 2,
    ops: [
      str(HKCU, String.raw`Control Panel\Mouse`, "MouseSpeed", "0", "1"),
      str(HKCU, String.raw`Control Panel\Mouse`, "MouseThreshold1", "0", "6"),
      str(HKCU, String.raw`Control Panel\Mouse`, "MouseThreshold2", "0", "10"),
    ],
  },
  {
    id: "disable-sticky-keys",
    category: "input",
    title: "Einrastfunktion-Tastenkürzel deaktivieren",
    description: "Verhindert, dass 5× Shift, langes Shift-Halten oder Num-Lock-Halten mitten im Spiel einen Dialog öffnet.",
    risk: "safe", reboot: "logoff", impact: 1,
    ops: [
      str(HKCU, String.raw`Control Panel\Accessibility\StickyKeys`, "Flags", "506", "510"),
      str(HKCU, String.raw`Control Panel\Accessibility\Keyboard Response`, "Flags", "122", "126"),
      str(HKCU, String.raw`Control Panel\Accessibility\ToggleKeys`, "Flags", "58", "62"),
    ],
  },
  {
    id: "keyboard-repeat",
    category: "input",
    title: "Schnellste Tastatur-Wiederholrate",
    description: "Minimale Verzögerung und maximale Wiederholrate bei gehaltenen Tasten.",
    risk: "safe", reboot: "logoff", impact: 1,
    ops: [
      str(HKCU, String.raw`Control Panel\Keyboard`, "KeyboardDelay", "0", "1"),
      str(HKCU, String.raw`Control Panel\Keyboard`, "KeyboardSpeed", "31", "31"),
    ],
  },

  // ───────────────────────────── Dienste ─────────────────────────────
  {
    id: "svc-telemetry",
    category: "services",
    title: "Telemetrie-Dienste deaktivieren",
    description: "„Benutzererfahrung und Telemetrie im verbundenen Modus“ (DiagTrack) und WAP-Push-Dienst sammeln und senden im Hintergrund Diagnosedaten.",
    risk: "safe", reboot: "none", impact: 1,
    ops: [svc("DiagTrack", "Disabled"), svc("dmwappushservice", "Disabled")],
  },
  {
    id: "svc-sysmain",
    category: "services",
    title: "SysMain (Superfetch) deaktivieren",
    description: "Lädt Programme vorab in den RAM und erzeugt dabei Datenträgerlast – auf SSDs kaum Nutzen, kann Ruckler beim Nachladen verursachen.",
    risk: "moderate", reboot: "none", impact: 2,
    ops: [svc("SysMain", "Disabled")],
  },
  {
    id: "svc-search",
    category: "services",
    title: "Windows-Suchindex auf manuell",
    description: "Der Indexdienst durchsucht ständig Dateien. Die Startmenü-Suche funktioniert weiter, Dateiinhalte werden aber langsamer gefunden.",
    risk: "advanced", reboot: "none", impact: 1,
    ops: [svc("WSearch", "Manual")],
  },
  {
    id: "svc-misc",
    category: "services",
    title: "Selten genutzte Dienste deaktivieren",
    description: "Fax, Karten-Downloads, Fehlerberichterstattung, Einzelhandelsdemo und Remote-Registrierung.",
    risk: "safe", reboot: "none", impact: 1,
    ops: [svc("Fax", "Disabled"), svc("MapsBroker", "Disabled"), svc("WerSvc", "Disabled"), svc("RetailDemo", "Disabled"), svc("RemoteRegistry", "Disabled")],
  },
  {
    id: "svc-print",
    category: "services",
    title: "Druckwarteschlange deaktivieren",
    description: "Nur wenn du keinen Drucker (auch kein „Drucken als PDF“) nutzt.",
    risk: "advanced", reboot: "none", impact: 1,
    ops: [svc("Spooler", "Disabled")],
  },

  // ───────────────────────────── Hintergrund & Telemetrie ─────────────────────────────
  {
    id: "disable-telemetry",
    category: "privacy",
    title: "Telemetrie auf Minimum",
    description: "Setzt die Diagnosedaten-Richtlinie auf das niedrigste Level und deaktiviert maßgeschneiderte Erfahrungen.",
    risk: "safe", reboot: "none", impact: 1,
    ops: [
      dword(HKLM, String.raw`SOFTWARE\Policies\Microsoft\Windows\DataCollection`, "AllowTelemetry", 0),
      dword(HKCU, String.raw`Software\Microsoft\Windows\CurrentVersion\Privacy`, "TailoredExperiencesWithDiagnosticDataEnabled", 0, 1),
    ],
  },
  {
    id: "disable-background-apps",
    category: "privacy",
    title: "Hintergrund-Apps deaktivieren",
    description: "Store-Apps dürfen nicht mehr im Hintergrund laufen und Benachrichtigungen/Daten abrufen.",
    risk: "moderate", reboot: "none", impact: 2,
    ops: [
      dword(HKCU, String.raw`Software\Microsoft\Windows\CurrentVersion\BackgroundAccessApplications`, "GlobalUserDisabled", 1, 0),
      dword(HKCU, String.raw`Software\Microsoft\Windows\CurrentVersion\Search`, "BackgroundAppGlobalToggle", 0, 1),
    ],
  },
  {
    id: "disable-ads",
    category: "privacy",
    title: "Werbung, Tipps & App-Vorschläge abschalten",
    description: "Werbe-ID, Startmenü-Vorschläge, „Tipps und Tricks“ und automatische Installation gesponserter Apps.",
    risk: "safe", reboot: "none", impact: 1,
    ops: [
      dword(HKCU, String.raw`Software\Microsoft\Windows\CurrentVersion\AdvertisingInfo`, "Enabled", 0, 1),
      ...["SubscribedContent-338388Enabled", "SubscribedContent-338389Enabled", "SubscribedContent-353694Enabled", "SubscribedContent-353696Enabled", "SystemPaneSuggestionsEnabled", "SoftLandingEnabled", "SilentInstalledAppsEnabled"].map((n) =>
        dword(HKCU, String.raw`Software\Microsoft\Windows\CurrentVersion\ContentDeliveryManager`, n, 0, 1)),
    ],
  },
  {
    id: "disable-copilot-recall",
    category: "privacy",
    title: "Copilot & Recall deaktivieren",
    description: "Schaltet Windows Copilot und die KI-Funktion Recall (regelmäßige Bildschirm-Snapshots) per Richtlinie ab.",
    risk: "safe", reboot: "logoff", impact: 1,
    ops: [
      dword(HKCU, String.raw`Software\Policies\Microsoft\Windows\WindowsCopilot`, "TurnOffWindowsCopilot", 1),
      dword(HKCU, String.raw`Software\Policies\Microsoft\Windows\WindowsAI`, "DisableAIDataAnalysis", 1),
      dword(HKLM, String.raw`SOFTWARE\Policies\Microsoft\Windows\WindowsAI`, "DisableAIDataAnalysis", 1),
    ],
  },
  {
    id: "disable-widgets",
    category: "privacy",
    title: "Widgets / News deaktivieren",
    description: "Beendet die Widgets-Leiste samt Hintergrundprozess, der Nachrichten und Wetter lädt.",
    risk: "safe", reboot: "logoff", impact: 1,
    ops: [dword(HKLM, String.raw`SOFTWARE\Policies\Microsoft\Dsh`, "AllowNewsAndInterests", 0)],
  },
  {
    id: "disable-web-search",
    category: "privacy",
    title: "Bing-Websuche im Startmenü deaktivieren",
    description: "Die Startmenü-Suche durchsucht nur noch den PC – schneller und ohne Online-Anfragen.",
    risk: "safe", reboot: "logoff", impact: 1,
    ops: [
      dword(HKCU, String.raw`Software\Policies\Microsoft\Windows\Explorer`, "DisableSearchBoxSuggestions", 1),
      dword(HKCU, String.raw`Software\Microsoft\Windows\CurrentVersion\Search`, "BingSearchEnabled", 0, 1),
    ],
  },
  {
    id: "disable-activity-history",
    category: "privacy",
    title: "Aktivitätsverlauf deaktivieren",
    description: "Windows protokolliert nicht mehr, welche Apps und Dateien du nutzt.",
    risk: "safe", reboot: "none", impact: 1,
    ops: [
      dword(HKLM, String.raw`SOFTWARE\Policies\Microsoft\Windows\System`, "EnableActivityFeed", 0),
      dword(HKLM, String.raw`SOFTWARE\Policies\Microsoft\Windows\System`, "PublishUserActivities", 0),
      dword(HKLM, String.raw`SOFTWARE\Policies\Microsoft\Windows\System`, "UploadUserActivities", 0),
    ],
  },

  {
    id: "disable-telemetry-tasks",
    category: "privacy",
    title: "Telemetrie-Aufgaben deaktivieren",
    description: "Schaltet geplante Aufgaben ab, die Kompatibilitäts-, Nutzungs- und Datenträgerdaten sammeln (Compatibility Appraiser, CEIP, DiskDiagnostic, Feedback). Sie starten sonst unvorhersehbar und erzeugen CPU- und Datenträgerlast.",
    risk: "safe", reboot: "none", impact: 1,
    ops: [
      custom(
        TASKS_PS + String.raw`
          $found = 0
          foreach ($e in $GB_TASKS) {
            $p, $n = $e.Split('|')
            $t = Get-ScheduledTask -TaskPath $p -TaskName $n -ErrorAction SilentlyContinue
            if (-not $t) { continue }
            $found++
            if ($t.State -ne 'Disabled') { return $false }
          }
          return $found -gt 0`,
        TASKS_PS + String.raw`
          $changed = @()
          foreach ($e in $GB_TASKS) {
            $p, $n = $e.Split('|')
            $t = Get-ScheduledTask -TaskPath $p -TaskName $n -ErrorAction SilentlyContinue
            if (-not $t -or $t.State -eq 'Disabled') { continue }
            try { Disable-ScheduledTask -TaskPath $p -TaskName $n -ErrorAction Stop | Out-Null; $changed += $e } catch {}
          }
          return @{ tasks = $changed }`,
        TASKS_PS + String.raw`
          $list = if ($backup -and $backup.tasks) { @($backup.tasks) } else { $GB_TASKS }
          foreach ($e in $list) {
            $p, $n = $e.Split('|')
            try { Enable-ScheduledTask -TaskPath $p -TaskName $n -ErrorAction Stop | Out-Null } catch {}
          }`,
      ),
    ],
  },

  // ───────────────────────────── Darstellung ─────────────────────────────
  {
    id: "disable-transparency",
    category: "visual",
    title: "Transparenzeffekte deaktivieren",
    description: "Spart GPU-Zeit des Desktop-Fenster-Managers (Acryl/Mica-Unschärfe).",
    risk: "safe", reboot: "none", impact: 1,
    ops: [dword(HKCU, String.raw`Software\Microsoft\Windows\CurrentVersion\Themes\Personalize`, "EnableTransparency", 0, 1)],
  },
  {
    id: "reduce-animations",
    category: "visual",
    title: "Fenster- und Taskleisten-Animationen reduzieren",
    description: "Minimieren/Maximieren ohne Animation, keine Taskleisten-Animationen und keine Aero-Peek-Vorschau.",
    risk: "safe", reboot: "logoff", impact: 1,
    ops: [
      str(HKCU, String.raw`Control Panel\Desktop\WindowMetrics`, "MinAnimate", "0", "1"),
      dword(HKCU, String.raw`Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced`, "TaskbarAnimations", 0, 1),
      dword(HKCU, String.raw`Software\Microsoft\Windows\DWM`, "EnableAeroPeek", 0, 1),
    ],
  },
  {
    id: "menu-show-delay",
    category: "visual",
    title: "Menü-Verzögerung entfernen",
    description: "Untermenüs öffnen sich sofort statt nach 400 ms.",
    risk: "safe", reboot: "logoff", impact: 1,
    ops: [str(HKCU, String.raw`Control Panel\Desktop`, "MenuShowDelay", "0", "400")],
  },
  {
    id: "startup-delay",
    category: "visual",
    title: "Autostart-Verzögerung entfernen",
    description: "Windows wartet nach der Anmeldung nicht mehr künstlich, bevor Autostart-Programme geladen werden.",
    risk: "safe", reboot: "none", impact: 1,
    ops: [dword(HKCU, String.raw`Software\Microsoft\Windows\CurrentVersion\Explorer\Serialize`, "StartupDelayInMSec", 0)],
  },

  // ───────────────────────────── System ─────────────────────────────
  {
    id: "exclude-driver-updates",
    category: "system",
    title: "Keine Treiber über Windows Update",
    description: "Verhindert, dass Windows Update deinen manuell installierten GPU-Treiber durch eine ältere Version ersetzt.",
    risk: "safe", reboot: "none", impact: 2,
    ops: [dword(HKLM, String.raw`SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate`, "ExcludeWUDriversInQualityUpdate", 1)],
  },
  {
    id: "disable-auto-maintenance",
    category: "system",
    title: "Automatische Wartung deaktivieren",
    description: "Verhindert, dass Defragmentierung, Scans und Updates im Leerlauf starten – und dann mitten im Spiel weiterlaufen. Wartung über GameBoost erledigen.",
    risk: "moderate", reboot: "none", impact: 1,
    ops: [dword(HKLM, String.raw`SOFTWARE\Microsoft\Windows NT\CurrentVersion\Schedule\Maintenance`, "MaintenanceDisabled", 1)],
  },
  {
    id: "ntfs-last-access",
    category: "system",
    title: "NTFS-Zugriffszeitstempel deaktivieren",
    description: "Spart einen Schreibvorgang bei jedem Lesezugriff auf Dateien (z. B. beim Laden von Spieldaten).",
    risk: "safe", reboot: "none", impact: 1,
    ops: [
      custom(
        String.raw`$o = fsutil behavior query disablelastaccess; if ("$o" -match '=\s*(\d)') { return @(1, 3) -contains [int]$Matches[1] }; return $false`,
        String.raw`$o = fsutil behavior query disablelastaccess; $prev = if ("$o" -match '=\s*(\d)') { [int]$Matches[1] } else { 2 }; fsutil behavior set disablelastaccess 1 | Out-Null; return @{ previous = $prev }`,
        String.raw`$v = if ($backup -and $null -ne $backup.previous) { $backup.previous } else { 2 }; fsutil behavior set disablelastaccess $v | Out-Null`,
      ),
    ],
  },
  {
    id: "disable-memory-compression",
    category: "system",
    title: "Speicherkomprimierung deaktivieren",
    description: "Spart CPU-Zeit für das Komprimieren von RAM-Seiten. Nur sinnvoll ab 32 GB RAM. Benötigt den Dienst SysMain.",
    risk: "advanced", reboot: "reboot", impact: 1,
    ops: [
      custom(
        `return -not (Get-MMAgent).MemoryCompression`,
        `Disable-MMAgent -MemoryCompression; return @{}`,
        `Enable-MMAgent -MemoryCompression`,
      ),
    ],
  },
  {
    id: "disable-hvci",
    category: "system",
    title: "Speicherintegrität (HVCI) deaktivieren",
    description: "Kernisolierung kostet je nach CPU 5–15 % FPS. ⚠ Senkt die Sicherheit gegen Kernel-Malware. Einige Anti-Cheats (z. B. Valorant/FACEIT) können HVCI voraussetzen.",
    risk: "advanced", reboot: "reboot", impact: 3,
    ops: [dword(HKLM, String.raw`SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\HypervisorEnforcedCodeIntegrity`, "Enabled", 0, 1)],
  },

  // ───────────────────────────── Kontextmenü ─────────────────────────────
  {
    id: "ctx-classic-menu",
    category: "contextmenu",
    title: "Klassisches Kontextmenü (Windows 11)",
    description: "Zeigt beim Rechtsklick sofort das vollständige Menü – ohne Umweg über „Weitere Optionen anzeigen“.",
    risk: "safe", reboot: "explorer", impact: 1,
    ops: [
      custom(
        String.raw`$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('${CLASSIC_MENU}\InprocServer32'); if ($k) { $k.Close(); return $true }; return $false`,
        String.raw`GB-RegSet 'HKCU' '${CLASSIC_MENU}\InprocServer32' '' 'String' ''; return @{}`,
        String.raw`[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree('${CLASSIC_MENU}', $false)`,
        { admin: false },
      ),
    ],
  },
  {
    id: "ctx-hide-share",
    category: "contextmenu",
    title: "„Teilen“ ausblenden",
    description: "Entfernt den Eintrag „Teilen“ (Windows-Freigabedialog) aus dem Rechtsklick-Menü.",
    risk: "safe", reboot: "explorer", impact: 1,
    ops: [block("{e2bf9676-5f8f-435c-97eb-11607a5bedf7}")],
  },
  {
    id: "ctx-hide-give-access",
    category: "contextmenu",
    title: "„Zugriff gewähren auf“ ausblenden",
    description: "Entfernt das Netzwerkfreigabe-Untermenü bei Dateien und Ordnern.",
    risk: "safe", reboot: "explorer", impact: 1,
    ops: [block("{f81e9010-6ea4-11ce-a7ff-00aa003ca9f6}")],
  },
  {
    id: "ctx-hide-previous-versions",
    category: "contextmenu",
    title: "„Vorherige Versionen wiederherstellen“ ausblenden",
    description: "Der Eintrag ist nur mit Dateiversionsverlauf oder Schattenkopien nützlich. Die Registerkarte in den Eigenschaften bleibt erhalten.",
    risk: "safe", reboot: "explorer", impact: 1,
    ops: [block("{596AB062-B4D2-4215-9F74-E9109B0A8153}")],
  },
  {
    id: "ctx-hide-defender",
    category: "contextmenu",
    title: "„Mit Microsoft Defender überprüfen“ ausblenden",
    description: "Entfernt nur den Menüeintrag – der Echtzeitschutz von Defender bleibt unverändert aktiv.",
    risk: "safe", reboot: "explorer", impact: 1,
    ops: [block("{09A47860-11B0-4DA5-AFA5-26D86198A780}")],
  },
  {
    id: "ctx-hide-app-edit",
    category: "contextmenu",
    title: "„Mit Clipchamp/Fotos/Paint/Editor bearbeiten“ ausblenden",
    description: "Entfernt die Bearbeiten-Einträge der vorinstallierten Store-Apps aus dem Windows-11-Menü.",
    risk: "safe", reboot: "explorer", impact: 1,
    ops: [
      block("{8AB635F8-9A67-4698-AB99-784AD929F493}"),
      block("{BFE0E2A4-C70C-4AD7-AC3D-10D1ECEBB5B4}"),
      block("{2430F218-B743-4FD6-97BF-5C76541B4AE9}"),
      block("{CA6CC9F1-867A-481E-951E-A28C5E4F01EA}"),
    ],
  },
  {
    id: "ctx-hide-terminal",
    category: "contextmenu",
    title: "„In Terminal öffnen“ ausblenden",
    description: "Entfernt den Terminal-Eintrag aus dem Ordner-Kontextmenü.",
    risk: "safe", reboot: "explorer", impact: 1,
    ops: [block("{9F156763-7844-4DC4-B2B1-901F640F5155}")],
  },
  {
    id: "ctx-hide-favorites",
    category: "contextmenu",
    title: "„Zu Favoriten hinzufügen“ ausblenden",
    description: "Entfernt den Eintrag, der Dateien an die Explorer-Startseite anheftet.",
    risk: "safe", reboot: "explorer", impact: 1,
    ops: [str(HKCU, String.raw`Software\Classes\*\shell\pintohomefile`, "ProgrammaticAccessOnly", "")],
  },
  {
    id: "ctx-hide-compatibility",
    category: "contextmenu",
    title: "„Kompatibilitätsprobleme beheben“ ausblenden",
    description: "Entfernt den Problembehandlungs-Eintrag bei Programmen und Verknüpfungen.",
    risk: "safe", reboot: "explorer", impact: 1,
    ops: [block("{1d27f844-3a1f-4410-85ac-14651078412d}")],
  },
  {
    id: "ctx-play-with-boost",
    category: "contextmenu",
    title: "„Mit GameBoost spielen“ hinzufügen",
    description: "Rechtsklick auf eine .exe oder Verknüpfung startet das Spiel mit Game Boost; der Boost endet automatisch mit dem Spiel. Unter Windows 11 ohne klassisches Menü unter „Weitere Optionen“.",
    risk: "safe", reboot: "none", impact: 1,
    ops: [verb("Play", ["exefile", "lnkfile"], "Mit GameBoost spielen", cliCommand('play "%1"'), { Icon: ICON })],
  },
  {
    id: "ctx-take-ownership",
    category: "contextmenu",
    title: "„Besitz übernehmen“ hinzufügen",
    description: "Übernimmt Besitz und Vollzugriff für Dateien und Ordner, die sich sonst nicht löschen oder ändern lassen (z. B. Reste alter Treiber). Fragt per UAC nach Adminrechten.",
    risk: "moderate", reboot: "none", impact: 1,
    ops: [verb("TakeOwnership", ["*", "Directory"], "Besitz übernehmen", cliCommand('own "%1"'), { HasLUAShield: "", Position: "Bottom" })],
  },
];

// Derived fields
for (const t of TWEAKS) {
  t.admin = t.ops.some((o) => (o.type === "custom" ? o.admin : o.type !== "reg") || o.hive === HKLM);
  if (CATEGORIES.find((c) => c.id === t.category)?.optional) t.optional = true;
}

export const RISK_LABEL = { safe: "Sicher", moderate: "Moderat", advanced: "Fortgeschritten" };
export const REBOOT_LABEL = { none: "Sofort wirksam", explorer: "Explorer-Neustart", logoff: "Neuanmeldung", reboot: "Neustart" };

export const PRESETS = [
  { id: "safe", title: "Sicher & empfohlen", description: "Nur risikofreie Optimierungen – ideal für jeden Gaming-PC.", icon: "🟢", risks: ["safe"] },
  { id: "balanced", title: "Gaming-Balance", description: "Sichere und moderate Optimierungen für spürbar mehr Leistung.", icon: "🟡", risks: ["safe", "moderate"] },
  { id: "max", title: "Maximale Leistung", description: "Alles inklusive fortgeschrittener Eingriffe (u. a. Speicherintegrität aus). Nur für erfahrene Nutzer!", icon: "🔴", risks: ["safe", "moderate", "advanced"] },
];

export function presetTweaks(presetId) {
  const p = PRESETS.find((x) => x.id === presetId);
  if (!p) throw new Error(`Unbekanntes Profil: ${presetId}`);
  return TWEAKS.filter((t) => p.risks.includes(t.risk) && !t.optional).map((t) => t.id);
}

export function getTweak(id) {
  const t = TWEAKS.find((x) => x.id === id);
  if (!t) throw new Error(`Unbekannte Optimierung: ${id}`);
  return t;
}
