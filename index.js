const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const SHEET_ID = '1WkBYGnUO4Iq1wi15bpPm0IduzRadyHA51TVLTKLA-nI';
const BOOST_URL = 'https://www.ninjacasino.se/betting';

async function scrapeNinjaBoosts() {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    
    console.log('Navigerar till Ninja Casino...');
    await page.goto(BOOST_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

    console.log('Väntar 15 sekunder...');
    await new Promise(r => setTimeout(r, 15000));

    const boosts = await page.evaluate(() => {
      const host = document.querySelector('#altenarsportsbook div');
      if (!host || !host.shadowRoot) return [];
      const shadow = host.shadowRoot;
      const boxes = shadow.querySelectorAll('[class*="BoostedOddsBox-"]');
      
      const results = [];
      boxes.forEach(box => {
        const event = box.querySelector('[class*="BoostedOddsBoxEvent-"]')?.textContent?.trim() || '';
        const championship = box.querySelector('[class*="BoostedOddsBoxChampionship-"]')?.textContent?.trim() || '';
        const time = box.querySelector('[class*="BoostedOddsBoxTime-"]')?.textContent?.trim() || '';
        const market = box.querySelector('[class*="BoostedOddsBoxMarket-"]')?.textContent?.trim() || '';
        const selection = box.querySelector('[class*="BoostedOddsBoxSelection-"]')?.textContent?.trim() || '';
        const oddsBefore = box.querySelector('[class*="OddValuePreBoosted-"]')?.textContent?.trim() || '';
        const oddsAfter = box.querySelector('[class*="OddValue-"]:not([class*="PreBoosted"])')?.textContent?.trim() || '';

        if (event) {
          results.push({ event, championship, time, market, selection, oddsBefore, oddsAfter });
        }
      });
      return results;
    });

    console.log(`Hittade ${boosts.length} boostar`);
    boosts.forEach(b => console.log(`  ${b.event} | ${b.market} | ${b.selection} | ${b.oddsBefore} → ${b.oddsAfter}`));

    if (boosts.length > 0) {
      await writeToSheet(boosts);
    }

  } catch (err) {
    console.error('Fel:', err.message);
  } finally {
    await browser.close();
  }
}

function formatStop(timeStr) {
  // timeStr är t.ex. "29/06 • 19:00"
  try {
    const clean = timeStr.replace('•', '').trim();
    const [datePart, timePart] = clean.split(/\s+/);
    const [d, m] = datePart.split('/').map(Number);
    const y = new Date().getFullYear().toString().slice(-2);
    return `${d}/${m}/${y} ${timePart}`;
  } catch(e) {
    return '';
  }
}

function detectSport(championship) {
  const c = (championship || '').toLowerCase();
  if (c.includes('hockey') || c.includes('nhl') || c.includes('shl')) return 'hockey';
  if (c.includes('tennis')) return 'tennis';
  if (c.includes('basket') || c.includes('nba')) return 'basket';
  return 'fotboll';
}

async function writeToSheet(boosts) {
  const token = await getGoogleToken();
  
  const existing = await getSheetRows(token);
  const now = new Date();
  
  const scraperBrands = new Set(['betmgm','expekt','leovegas','gogo','luckysports','happy','flax','ettkrysstva','ninja']);
  const manualRows = existing.filter(row => !scraperBrands.has(row[0]));
  const scraperRows = existing.filter(row => scraperBrands.has(row[0]));
  
  const validScraperRows = scraperRows.filter(row => {
    const stop = parseStop(row[6]);
    return stop && stop > now;
  });

  const existingKeys = new Set(validScraperRows.map(r => `${r[0]}|${r[2]}|${r[3]}`));

  const newRows = boosts
    .map(b => ({
      x: 'ninja',
      enable: 'TRUE',
      match: b.event,
      outcome: `${b.selection} ${b.market}`.trim(),
      old: parseFloat(b.oddsBefore) || 0,
      new: parseFloat(b.oddsAfter) || 0,
      stop: formatStop(b.time),
      sport: detectSport(b.championship),
      vmboost: ''
    }))
    .filter(b => !existingKeys.has(`${b.x}|${b.match}|${b.outcome}`));

  console.log(`${newRows.length} nya boostar att lägga till`);

  const allScraperRows = [
    ...validScraperRows,
    ...newRows.map(r => [r.x, r.enable, r.match, r.outcome, r.old, r.new, r.stop, r.sport, r.vmboost])
  ];

  allScraperRows.sort((a, b) => {
    const stopA = parseStop(a[6]);
    const stopB = parseStop(b[6]);
    if (!stopA || !stopB) return 0;
    return stopA - stopB;
  });

  const allRows = [...allScraperRows, ...manualRows];
  await clearAndWrite(token, allRows);
  console.log('Klart! Sheet uppdaterat.');
}

function parseStop(stopStr) {
  try {
    const [datePart, timePart] = stopStr.trim().split(' ');
    const [d, m, y] = datePart.split('/').map(Number);
    const [h, min] = timePart.split(':').map(Number);
    return new Date(y < 100 ? 2000 + y : y, m - 1, d, h, min);
  } catch(e) { return null; }
}

async function getSheetRows(token) {
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/A2:I1000`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );
  const data = await res.json();
  return data.values || [];
}

async function clearAndWrite(token, rows) {
  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/A2:I1000:clear`,
    { method: 'POST', headers: { 'Authorization': `Bearer ${token}` } }
  );
  if (rows.length === 0) return;
  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/A2:I${rows.length + 1}?valueInputOption=RAW`,
    {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: rows })
    }
  );
}

async function getGoogleToken() {
  const now = Math.floor(Date.now() / 1000);
  const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');

  const header = btoa(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  const payload = btoa(JSON.stringify({
    iss: clientEmail,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  })).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');

  const signingInput = `${header}.${payload}`;

  const crypto = require('crypto');
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(signingInput);
  const signature = sign.sign(privateKey, 'base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');

  const jwt = `${signingInput}.${signature}`;

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
  });
  const tokenData = await tokenRes.json();
  return tokenData.access_token;
}

scrapeNinjaBoosts();
