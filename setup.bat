@echo off
cd /d "%~dp0"
echo === Installing (one time, about 2-3 minutes) ===
call npm install
call npx playwright install chromium
echo.
echo === Sending a test alert to your phone ===
node nz-watch.js test
echo.
echo === Creating the two daily scheduled tasks ===
schtasks /Create /F /TN "NZ Watch - morning (all)" /TR "cmd /c cd /d \"%~dp0\" && node nz-watch.js all" /SC DAILY /ST 08:50
schtasks /Create /F /TN "NZ Watch - evening (hotels)" /TR "cmd /c cd /d \"%~dp0\" && node nz-watch.js hotels" /SC DAILY /ST 21:05
echo.
echo === Running the full check once now ===
node nz-watch.js all
echo.
echo Done. Results are in nz-watch.log. Alerts go to the ntfy app on your phone.
pause
