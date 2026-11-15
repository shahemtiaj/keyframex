@echo off
rem KeyframeX - install for After Effects on Windows (unsigned install).
rem Copies the extension into the per-user CEP folder, removes other KeyframeX copies
rem that After Effects could load instead, and enables unsigned extensions for CEP 9-13.
setlocal enabledelayedexpansion
set "SRC=%~dp0.."
set "EXT=%APPDATA%\Adobe\CEP\extensions"
set "DEST=%EXT%\KeyframeX"
echo Installing KeyframeX from: %SRC%
if not exist "%EXT%" mkdir "%EXT%"

rem After Effects loads every folder in the extensions folder: remove other KeyframeX copies.
for /d %%D in ("%EXT%\*") do (
  if /i not "%%~fD"=="%DEST%" (
    if exist "%%~fD\CSXS\manifest.xml" (
      findstr /i /c:"KeyframeX" "%%~fD\CSXS\manifest.xml" >nul && (
        echo Removing another KeyframeX copy: %%~fD
        rmdir /s /q "%%~fD"
      )
    )
  )
)

if exist "%DEST%" (
  echo Replacing the previous install at %DEST%
  rmdir /s /q "%DEST%"
)
robocopy "%SRC%" "%DEST%" /E /NFL /NDL /NJH /NJS /XD "%SRC%\tests\fixtures" >nul
if %ERRORLEVEL% GEQ 8 (
  echo Copy failed.
  exit /b 1
)
for %%v in (9 10 11 12 13) do reg add "HKCU\Software\Adobe\CSXS.%%v" /v PlayerDebugMode /t REG_SZ /d 1 /f >nul
echo Enabled unsigned extensions (PlayerDebugMode) for CSXS 9-13.
echo Done. Restart After Effects, then open Window ^> Extensions ^> KeyframeX.
endlocal
