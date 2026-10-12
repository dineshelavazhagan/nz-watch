NZ TRIP WATCH - runs on your own Windows computer, uses NO Claude tokens
======================================================================

WHAT IT CHECKS
 Every morning 8:50am (node nz-watch.js all):
  - Omega & GO Rentals prices: Nelson -> Christchurch 17-28 Nov, Auckland 13-17 Nov
  - Deals pages: Omega, GO, Ezi, Snap, Apex  (alerts on ANY new promo line)
  - Relocations: Transfercar, Imoova (Nelson/Christchurch/Auckland, November)
  - Hermitage Premium Plus (22 & 23 Nov) and Milford Sound Lodge chalets (19 & 20 Nov)
 Every evening 9:05pm (node nz-watch.js hotels):
  - Hermitage + Milford Lodge only

ALERTS go to your phone with the free "ntfy" app:
  1. Install "ntfy" from the Play Store / App Store.
  2. Tap +  -> Subscribe to topic -> enter your topic from config.json
     (nzwatch-dinesh-804c8616ff96)  -> server: ntfy.sh (default).
  High-priority "NZ WATCH ALERT" = something worth acting on.
  Low-priority daily one-liner = nothing changed (set "dailySummary": false
  in config.json to stop those).

ONE-TIME SETUP (about 5 minutes)
  1. Install Node.js LTS from https://nodejs.org (default options).
  2. Unzip this folder somewhere permanent, e.g. C:\nz-watch
  3. Double-click setup.bat
     - installs everything, sends a TEST alert to your phone,
       creates the 2 daily Windows scheduled tasks, and runs one full check.
  4. Check your phone got the test alert, and open nz-watch.log to see results.

DAILY USE
  - Nothing to do. The computer must be ON at 8:50am and 9:05pm (it can be
    locked). Chrome and the Claude app do NOT need to be open.
  - Optional: Task Scheduler -> each "NZ Watch" task -> Conditions ->
    tick "Wake the computer to run this task".
  - run-now.bat = run a full check immediately.
  - remove-tasks.bat = stop everything.

IF YOU CHANGE BOOKINGS
  Edit config.json: omegaBookedDaily (your Omega $/day), southBaseline
  (your South Island all-in NZ$), northBaseline (Auckland car NZ$).

It never books, pays or signs in anywhere - it only reads public prices.
It stops by itself after 20 Nov 2026.
