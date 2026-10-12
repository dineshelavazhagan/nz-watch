@echo off
schtasks /Delete /F /TN "NZ Watch - morning (all)"
schtasks /Delete /F /TN "NZ Watch - evening (hotels)"
echo Scheduled tasks removed.
pause
