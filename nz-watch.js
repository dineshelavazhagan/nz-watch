// NZ trip watcher — runs on your own computer, no Claude needed.
// Usage:  node nz-watch.js all      (cars + deals + relocations + hotels)
//         node nz-watch.js hotels   (Hermitage + Milford Lodge only)
//         node nz-watch.js test     (sends a test notification and exits)
// Alerts go to your phone through the free ntfy app (topic set in config.json).

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const DIR = __dirname;
const CONFIG = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8'));
const STATE_FILE = path.join(DIR, 'state.json');
const LOG_FILE = path.join(DIR, 'nz-watch.log');
const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : { seen: {} };
const MODE = (process.argv[2] || 'all').toLowerCase();
const INR = 54.5;
const inr = nzd => '₹' + Math.round(nzd * INR).toLocaleString('en-IN');

const log = (...a) => { const line = `[${new Date().toISOString()}] ${a.join(' ')}`; console.log(line); fs.appendFileSync(LOG_FILE, line + '\n'); };

async function notify(title, body, priority = 'default', tags = '') {
  if (!CONFIG.ntfyTopic || CONFIG.ntfyTopic.includes('CHANGE')) { log('ntfy topic not set — skipping notification'); return; }
  try {
    await fetch(`https://ntfy.sh/${encodeURIComponent(CONFIG.ntfyTopic)}`, {
      method: 'POST', body,
      headers: { Title: title.replace(/[^\x20-\x7E]/g, ''), Priority: priority, Tags: tags },
    });
  } catch (e) { log('notify failed:', e.message); }
}

// Price alert only when it's below the threshold AND a new low vs what we already alerted on
// alert only when the set of hits changes (so hourly runs don't repeat the same alert)
function changed(key, hits) {
  state.seenHits = state.seenHits || {};
  const v = hits.slice().sort().join('|');
  const was = state.seenHits[key] || '';
  state.seenHits[key] = v;
  return v !== '' && v !== was;
}
function newLow(key, price, threshold) {
  state.lows = state.lows || {};
  const prev = state.lows[key];
  if (price > threshold) return false;
  if (prev !== undefined && price >= prev - 10) return false;
  state.lows[key] = price; return true;
}
// Returns only lines we have not seen before for this key (and remembers them).
function newLines(key, lines) {
  const prev = new Set(state.seen[key] || []);
  const fresh = lines.filter(l => !prev.has(l));
  const firstRun = !state.seen[key];
  state.seen[key] = [...new Set([...(state.seen[key] || []), ...lines])].slice(-200);
  return firstRun ? [] : fresh; // first run just records a baseline
}

async function safe(name, fn) {
  try { return await fn(); } catch (e) { log(`${name} failed: ${e.message.split('\n')[0]}`); return { failed: true, err: e.message.split('\n')[0] }; }
}

// ---------- CARS ----------
async function omega(page) {
  await page.goto('https://www.omegarentalcars.com/book/stepone/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  return page.evaluate(async () => {
    const om = async (pf, dt, pd, dd, pt, dtm) => {
      const fd = new FormData();
      Object.entries({ PickupFrom: pf, DropoffTo: dt, PickupDate: pd, DropoffDate: dd, PickupTime: pt, DropoffTime: dtm, Age: '30', PromoCode: '', SpecialText: '', Iframe: '0', ATA: 'no', action_SubmitQuoteForm: 'Search' }).forEach(([k, v]) => fd.set(k, v));
      const h = await (await fetch('/book/QuoteForm/', { method: 'POST', body: fd })).text();
      const m = [...h.matchAll(/'name':\s*'([^']+)'[\s\S]{0,80}?'price':\s*'([\d.]+)'[\s\S]{0,200}?'variant':\s*'([^']*)'/g)];
      const s = new Set();
      return m.map(x => ({ n: x[1].replace(/\s*\(\d+cc\)/, '').trim(), p: +x[2], v: x[3] }))
        .filter(x => x.p > 0 && x.v !== 'Closed' && !s.has(x.n) && s.add(x.n)).sort((a, b) => a.p - b.p);
    };
    return { si: await om('8', '9', '17/11/2026', '28/11/2026', '1630', '0930'), ni: await om('2', '2', '13/11/2026', '17/11/2026', '1000', '1000') };
  });
}

async function goRentals(page) {
  await page.goto('https://www.gorentals.co.nz/deals/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => window.$nuxt && window.$nuxt.$axios, null, { timeout: 30000 });
  return page.evaluate(async () => {
    const ax = window.$nuxt.$axios;
    const go = async (p, d, a, b, days) => {
      const r = await ax.post('booking/search', { pickupLocation: p, dropOffLocation: d, pickupDateTime: a, dropOffDateTime: b, agentId: null, promotion: null, clientReferenceNumber: null, isMobile: false });
      return r.data.result.filter(x => x.carClassStatus !== 'Soldout').sort((x, y) => x.grantTotal - y.grantTotal).slice(0, 3)
        .map(x => ({ n: x.international, allin: x.grantTotal + 45 * days + 33, hot: !!x.hotDealInfo }));
    };
    return { si: await go(11, 7, '17 Nov 2026 16:30', '28 Nov 2026 09:30', 11), ni: await go(29, 29, '13 Nov 2026 10:00', '17 Nov 2026 10:00', 4) };
  });
}

// ---------- DEALS & RELOCATIONS ----------
const DEAL_PAGES = {
  'Omega deals': 'https://www.omegarentalcars.com/deals/',
  'GO deals': 'https://www.gorentals.co.nz/deals/',
  'Ezi specials': 'https://www.ezicarrental.co.nz/specials',
  'Snap deals': 'https://www.snaprentals.co.nz/deals',
  'Apex deals': 'https://www.apexrentals.co.nz/deals',
};
async function dealLines(page, url) {
  const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  if (resp && resp.status() >= 400) throw new Error('HTTP ' + resp.status());
  await page.waitForTimeout(3500);
  return page.evaluate(() => {
    const R = document.querySelector('main') || document.body;
    return [...new Set(R.innerText.split('\n').map(s => s.replace(/\s+/g, ' ').trim())
      .filter(s => s.length > 20 && s.length < 160 && /(\$|%|deal|relocat|code|nov|special|sale|off)/i.test(s)))].slice(0, 15);
  });
}
async function transfercar(page) {
  try { return await transfercarOnce(page); } catch (e) { log('Transfercar retry:', e.message.slice(0, 60)); return await transfercarOnce(page); }
}
async function transfercarOnce(page) {
  await page.goto('https://www.transfercar.co.nz/search?page=1&limit=100&featured=0', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => /\nFrom \d/.test(document.body.innerText), null, { timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(2000);
  const n = await page.evaluate(() => (document.body.innerText.match(/\nFrom \d/g) || []).length);
  if (!n) throw new Error('no listings loaded: ' + (await snippet(page)));
  return page.evaluate(() => {
    const L = document.body.innerText.split('\n').map(s => s.trim()).filter(Boolean); const o = [];
    for (let i = 0; i < L.length - 3; i++) if (/^From \d/.test(L[i]) && /^To \d/.test(L[i + 2]) && /nelson|christchurch|auckland|queenstown/i.test(L[i + 1] + L[i + 3]))
      o.push(`${L[i + 1]} (${L[i].slice(5)}) → ${L[i + 3]} (${L[i + 2].slice(3)})`);
    return [...new Set(o)];
  });
}
async function imoova(page) {
  await page.goto('https://www.imoova.com/deals/new-zealand', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => /→/.test(document.body.innerText), null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2000);
  const out = await page.evaluate(() => {
    const L = document.body.innerText.split('\n').map(s => s.trim()).filter(Boolean); const o = [];
    for (let i = 0; i < L.length - 5; i++) if (/^[A-Za-z .]+ → [A-Za-z .]+$/.test(L[i]) && /^\d{1,2} \w{3}$/.test(L[i + 2]) && L[i + 3] === '-')
      o.push(`${L[i]} (${L[i + 2]} – ${L[i + 4]}, ${L[i + 5]})`);
    return [...new Set(o)];
  });
  if (!out.length) throw new Error('no listings parsed: ' + (await snippet(page)));
  return out;
}
// relocation is useful only if it fits our dates/routes: Nelson -> Christchurch/Queenstown around 17-19 Nov
const usefulReloc = s => /nelson.{0,40}(→|\)).{0,20}(christchurch|queenstown)|nelson[^→]*→\s*(christchurch|queenstown)/i.test(s) && /nov/i.test(s);
async function snippet(page) {
  try { return (await page.title()) + ' :: ' + (await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 200))); } catch (e) { return 'no page'; }
}

// ---------- HOTELS ----------
async function hermitage(page) {
  const base = 'https://book.hermitage.co.nz/onecart/wbe/room/20104/hermitage/';
  const nights = { '22–23 Nov': '2026-11-22/2026-11-23/DYNRO/2', '23–24 Nov': '2026-11-23/2026-11-24/DYNRO/2', '23–24 Nov (Panorama pkg)': '2026-11-23/2026-11-24/DBBSAVE20PAN/2' };
  const out = {};
  for (const [label, p] of Object.entries(nights)) {
    await page.goto(base + p, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => /AVERAGE RATE|no rooms|not available|sold out/i.test(document.body.innerText), null, { timeout: 40000 }).catch(() => {});
    await page.waitForTimeout(2500);
    out[label] = await page.evaluate(() => {
      const tx = document.body.innerText; const p = tx.split(/AVERAGE RATE\s+/);
      return p.slice(1).map((c, i) => {
        const ls = p[i].split('\n').map(s => s.trim()).filter(s => /^(Hermitage Hotel|Mt Cook Lodge)\s\S/.test(s));
        return (ls.pop() || '?').replace(/^Hermitage Hotel /, '') + ' ' + c.split('/')[0].trim();
      });
    });
  }
  return out;
}
async function milford(page) {
  await page.goto('https://milfordlodge.com/book/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  try { await page.waitForSelector('#available_from', { timeout: 60000 }); }
  catch (e) { throw new Error('booking widget did not load: ' + (await snippet(page))); }
  await page.waitForTimeout(3000);
  const run = (a, b) => page.evaluate(async ([a, b]) => {
    const q = s => document.querySelector(s), W = ms => new Promise(r => setTimeout(r, ms));
    q('#available_from').value = a; q('#available_to').value = b; q('#nights').value = '1'; q('#newbook_adults').value = '2';
    ['#available_from', '#available_to'].forEach(s => q(s).dispatchEvent(new Event('change', { bubbles: true })));
    load_availability(); await W(9000);
    const L = document.body.innerText.split('\n').map(s => s.trim()).filter(s => s && s.length < 90); const c = [];
    L.forEach((s, i) => { if (s === 'More details') { let j = i - 1; while (j > 0 && /^\d+$/.test(L[j])) j--; c.push({ n: L[j], i }); } });
    return c.map((x, k) => { const end = k + 1 < c.length ? c[k + 1].i - 8 : L.length; const p = L.slice(x.i, end).find(y => /^From \$/.test(y)); return x.n + ': ' + (p ? p.replace(' For 1 night', '') : 'none'); })
      .filter(x => !/campervan|forest|backpack|dorm|shared/i.test(x));
  }, [a, b]);
  return { '19–20 Nov': await run('19 Nov 2026', '20 Nov 2026'), '20–21 Nov': await run('20 Nov 2026', '21 Nov 2026') };
}

// Backup source for Milford Sound Lodge: its Booking.com page, one night at a time
async function milfordBooking(page) {
  const out = {};
  for (const [label, ci, co] of [['19–20 Nov', '2026-11-19', '2026-11-20'], ['20–21 Nov', '2026-11-20', '2026-11-21']]) {
    await page.goto(`https://www.booking.com/hotel/nz/milford-sound-lodge.en-gb.html?checkin=${ci}&checkout=${co}&group_adults=2&no_rooms=1&selected_currency=NZD`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000);
    out[label] = await page.evaluate(() => {
      const t = document.body.innerText;
      if (/no availability here|not available on our site for your dates/i.test(t)) return 'none';
      const rooms = [...new Set([...document.querySelectorAll('.hprt-roomtype-icon-link,[data-testid=room-name],.hprt-roomtype-link')].map(e => e.textContent.trim()).filter(Boolean))];
      const price = (t.match(/NZD\s?[\d,]+/) || [''])[0];
      if (rooms.length && !price) return 'none'; // room names without a price = listed but not bookable
      return rooms.length ? rooms.slice(0, 4).join(', ') + ' from ' + price : 'UNKNOWN: ' + document.title.slice(0, 60);
    });
  }
  if (Object.values(out).every(v => v.startsWith('UNKNOWN'))) throw new Error('Booking.com page not readable');
  return out;
}

// ---------- MAIN ----------
(async () => {
  if (MODE === 'test') { await notify('NZ watch test', 'If you can read this, alerts work.', 'high', 'white_check_mark'); log('test sent'); return; }
  if (new Date() > new Date('2026-11-20T23:59:59+13:00')) { log('Trip watch period over — remove the scheduled task.'); return; }

  const browser = await chromium.launch({ headless: true, ...(process.env.GITHUB_ACTIONS ? { channel: 'chrome' } : {}) });
  const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36', locale: 'en-NZ' });
  const page = await ctx.newPage();
  const alerts = [], summary = [];

  if (MODE === 'all') {
    // Cars
    const om = await safe('Omega', () => omega(page));
    if (!om.failed) {
      const gx = om.si.find(x => /Corolla Hatch/i.test(x.n));
      const best = om.si[0];
      const allin = x => Math.round((x.p + 14 + 275) * 1.0199);
      if (gx) {
        const pd = gx.p / 11;
        summary.push(`Omega GX $${pd.toFixed(2)}/d (≈$${allin(gx)})`);
        if (newLow('omegaGX', pd, CONFIG.omegaBookedDaily - 0.01)) alerts.push(`Omega Corolla Hatch GX dropped to NZ$${pd.toFixed(2)}/day (≈NZ$${allin(gx)} all-in, ${inr(allin(gx))}). Rebook on omegarentalcars.com, then cancel your old booking (free).`);
      }
      if (best && newLow('omegaSI', allin(best), CONFIG.southBaseline - 100)) alerts.push(`Omega ${best.n}: ≈NZ$${allin(best)} all-in (${inr(allin(best))}) — NZ$${CONFIG.southBaseline - allin(best)} cheaper than your booking.`);
      const ni = om.ni[0]; if (ni) { const t = Math.round((ni.p + 100) * 1.0199); summary.push(`Omega NI ≈$${t}`); if (newLow('omegaNI', t, CONFIG.northBaseline - 50)) alerts.push(`Omega Auckland 13–17 Nov ${ni.n}: ≈NZ$${t} with Gold cover (+airport fees) vs NZ$${CONFIG.northBaseline}.`); }
    } else summary.push('Omega failed');

    const go = await safe('GO', () => goRentals(page));
    if (!go.failed) {
      const b = go.si[0]; if (b) { summary.push(`GO ≈$${b.allin}`); if (newLow('goSI', b.allin, CONFIG.southBaseline - 100)) alerts.push(`GO Rentals ${b.n}: ≈NZ$${b.allin} all-in incl. $0-excess + windscreen/tyres (${inr(b.allin)}) — NZ$${CONFIG.southBaseline - b.allin} cheaper. Note GO charges ~12% to cancel.${b.hot ? ' HOT DEAL.' : ''}`); }
      const n = go.ni[0]; if (n) { summary.push(`GO NI ≈$${n.allin}`); if (newLow('goNI', n.allin, CONFIG.northBaseline - 50)) alerts.push(`GO Auckland 13–17 Nov ${n.n}: ≈NZ$${n.allin} all-in vs NZ$${CONFIG.northBaseline}.`); }
    } else summary.push('GO failed');

    // Deals pages — alert on any NEW promo line
    for (const [name, url] of Object.entries(DEAL_PAGES)) {
      const lines = await safe(name, () => dealLines(page, url));
      if (lines.failed) { summary.push(`${name} failed (${lines.err.slice(0,80)})`); continue; }
      const fresh = newLines(name, lines);
      if (fresh.length) alerts.push(`NEW on ${name} (${url}):\n- ${fresh.slice(0, 4).join('\n- ')}`);
    }
    // Relocations
    for (const [name, fn] of [['Transfercar', transfercar], ['Imoova', imoova]].filter(([n]) => !(process.env.GITHUB_ACTIONS && n === 'Transfercar'))) {
      const r = await safe(name, () => fn(page));
      if (r.failed) { summary.push(`${name} failed (${r.err.slice(0,120)})`); continue; }
      const fresh = newLines(name, r).filter(usefulReloc);
      if (fresh.length) alerts.push(`Relocation on ${name}:\n- ${fresh.slice(0, 4).join('\n- ')}`);
    }
  }

  // Hotels (both modes)
  const h = await safe('Hermitage', () => hermitage(page));
  if (!h.failed) {
    const hits = Object.entries(h).flatMap(([n, rs]) => rs.filter(x => /premium plus|suite/i.test(x)).map(x => `${n}: ${x}`));
    summary.push(hits.length ? 'Hermitage PREMIUM PLUS' : 'Hermitage no Premium Plus');
    if (changed('hermitage', hits)) alerts.push(`Hermitage upgrade available:\n- ${hits.join('\n- ')}\nEmail reservations@hermitage.co.nz quoting R23D18 (22 Nov) / R23731 (23 Nov).`);
  } else summary.push('Hermitage failed');

  const m = await safe('Milford', () => milford(page));
  if (!m.failed) {
    const hits = Object.entries(m).flatMap(([n, rs]) => rs.filter(x => !/: none$/.test(x)).map(x => `${n}: ${x}`));
    summary.push(hits.length ? 'Milford OPEN' : 'Milford full');
    if (changed('milford', hits)) alerts.push(`Milford Sound Lodge has a chalet:\n- ${hits.join('\n- ')}\nBook at https://milfordlodge.com/book/ then cancel that night at Fiordland Hotel (Agoda, free until 18 Nov).`);
  } else {
    const mb = await safe('Milford (Booking.com)', () => milfordBooking(page));
    if (!mb.failed) {
      const hits = Object.entries(mb).filter(([, v]) => v !== 'none' && !v.startsWith('UNKNOWN')).map(([n, v]) => `${n}: ${v}`);
      summary.push(hits.length ? 'Milford OPEN (Booking.com)' : 'Milford full (via Booking.com)');
      if (changed('milford', hits)) alerts.push(`Milford Sound Lodge available on Booking.com:\n- ${hits.join('\n- ')}\nhttps://www.booking.com/hotel/nz/milford-sound-lodge.en-gb.html — then cancel that night at Fiordland Hotel (Agoda, free until 18 Nov).`);
    } else summary.push(`Milford failed on both lodge site (bot check) and Booking.com (${mb.err.slice(0,80)})`);
  }

  await browser.close();
  // one 'all quiet' summary per day (first run after 8am IST); alerts still go out any hour
  const ist = new Date(Date.now() + 5.5 * 3600e3), day = ist.toISOString().slice(0, 10);
  const sendSummary = CONFIG.dailySummary && ist.getUTCHours() >= 8 && state.lastSummaryDay !== day;
  if (sendSummary && !alerts.length) state.lastSummaryDay = day;
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));

  const line = summary.join(' · ');
  log(MODE, '|', line, '|', alerts.length, 'alert(s)');
  if (alerts.length) await notify('NZ WATCH ALERT', alerts.join('\n\n'), 'high', 'rotating_light');
  else if (sendSummary) await notify(`NZ watch (${MODE})`, line, 'low', 'white_check_mark');
})().catch(async e => { log('FATAL', e.message); await notify('NZ watch error', e.message.slice(0, 300), 'default', 'warning'); process.exit(1); });
