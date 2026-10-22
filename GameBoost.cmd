@echo off
rem Startet die GameBoost-Oberflaeche mit Administratorrechten (ohne Konsolenfenster).
powershell -NoProfile -WindowStyle Hidden -Command "Start-Process -FilePath 'conhost.exe' -ArgumentList '--headless','node','\"%~dp0bin\gameboost.js\"','ui' -Verb RunAs -WindowStyle Hidden"
