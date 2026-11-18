; Harbor's additions to electron-builder's NSIS installer (included automatically from build/).
;
; In-app updates start this installer silently (--updated /S --force-run). Silent means no
; window at all: for the ~30 s it takes to swap the files Harbor seemed to be gone, and the
; desktop shortcut pointed at a missing exe. So an update now:
;   - turns the installer's UI back on (SetSilent normal) and shows only the progress page,
;     titled "Updating Harbor", with the real progress bar,
;   - skips the install-mode, folder and finish pages and closes by itself,
;   - rewrites the shortcuts (so Explorer redraws their icons) and starts Harbor right away.
; A normal first install looks exactly as before.

; $R9 = "1" for Turkish text. Harbor passes its own UI language in HARBOR_LANG; older versions
; (updating to this one) don't, then the app's config.json decides, then Windows' language.
!macro harborPickLanguage
  StrCpy $R9 ""
  ReadEnvStr $R8 HARBOR_LANG
  ${if} $R8 == "tr"
    StrCpy $R9 "1"
  ${elseif} $R8 == "en"
    StrCpy $R9 "0"
  ${endif}
  ${if} $R9 == ""
    !insertmacro harborLanguageFromConfig "$APPDATA\spotdl-ytdlp-gui\config.json"
  ${endif}
  ${if} $R9 == ""
    !insertmacro harborLanguageFromConfig "$APPDATA\Harbor\config.json"
  ${endif}
  ${if} $R9 == ""
    System::Call 'kernel32::GetUserDefaultUILanguage() i .R8'
    IntOp $R8 $R8 & 0x3FF
    ${if} $R8 == 0x1F
      StrCpy $R9 "1"
    ${else}
      StrCpy $R9 "0"
    ${endif}
  ${endif}
!macroend

; Looks for the "language" line of Harbor's config.json (written with one key per line).
!macro harborLanguageFromConfig _file
  ${if} ${FileExists} "${_file}"
    StrCpy $R9 "1" ; Harbor's default UI language is Turkish
    ClearErrors
    FileOpen $R7 "${_file}" r
    ${ifNot} ${Errors}
      ${do}
        FileRead $R7 $R6
        ${if} ${Errors}
          ${break}
        ${endif}
        ${StrContains} $R5 '"language"' $R6
        ${if} $R5 != ""
          ${StrContains} $R5 '"en"' $R6
          ${if} $R5 != ""
            StrCpy $R9 "0"
          ${endif}
          ${break}
        ${endif}
      ${loop}
      FileClose $R7
    ${endif}
    ClearErrors
  ${endif}
!macroend

!macro customInit
  ${if} ${isUpdated}
    ; Show the progress window even though the updater asked for a silent install
    SetSilent normal
    SetAutoClose true
  ${endif}
!macroend

; Updates keep the existing install mode instead of asking "only for me / all users" again
!macro customInstallMode
  ${if} ${isUpdated}
    ${if} $hasPerMachineInstallation == "1"
    ${andIf} $hasPerUserInstallation == "0"
      StrCpy $isForceMachineInstall "1"
    ${else}
      StrCpy $isForceCurrentInstall "1"
    ${endif}
  ${endif}
!macroend

; Right before the progress page: give it Harbor's own title during an update
!macro customPageAfterChangeDir
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW harborInstFilesShow
  Function harborInstFilesShow
    ${if} ${isUpdated}
      !insertmacro harborPickLanguage
      ${if} $R9 == "1"
        !insertmacro MUI_HEADER_TEXT "Harbor güncelleniyor" "Yeni sürüm kuruluyor. Bitince Harbor kendiliğinden açılacak."
      ${else}
        !insertmacro MUI_HEADER_TEXT "Updating Harbor" "Installing the new version. Harbor opens again when it's done."
      ${endif}
      SendMessage $HWNDPARENT ${WM_SETTEXT} 0 "STR:${PRODUCT_NAME}"
      ; Stopping halfway would leave Harbor half-installed: no Cancel during an update
      GetDlgItem $R8 $HWNDPARENT 2
      EnableWindow $R8 0
    ${endif}
  FunctionEnd
!macroend

; The usual finish page (with "Run Harbor"), skipped during an update
!macro customFinishPage
  Function harborStartApp
    ${if} ${isUpdated}
      StrCpy $1 "--updated"
    ${else}
      StrCpy $1 ""
    ${endif}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  FunctionEnd
  Function harborFinishPre
    ${if} ${isUpdated}
      Abort
    ${endif}
  FunctionEnd
  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_FUNCTION "harborStartApp"
  !define MUI_PAGE_CUSTOMFUNCTION_PRE harborFinishPre
  !insertmacro MUI_PAGE_FINISH
!macroend

!macro customInstall
  ${if} ${isUpdated}
    ; Shortcuts are kept during an update; write them again so their icon is redrawn
    ${if} ${FileExists} "$newDesktopLink"
      CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
      WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
    ${endif}
    ${if} ${FileExists} "$newStartMenuLink"
      CreateShortCut "$newStartMenuLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
      WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
    ${endif}
    ClearErrors
    ; SHCNE_ASSOCCHANGED: Explorer redraws icons
    System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
    ; The installer is no longer silent, so electron-builder won't start the app: do it here
    ${if} ${isForceRun}
      HideWindow
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "--updated"
    ${endif}
  ${endif}
!macroend
