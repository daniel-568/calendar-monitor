require('dotenv').config();
const { chromium } = require('playwright');
const fs = require('fs');
const https = require('https');

const APPOINTMENT_URL = process.env.APPOINTMENT_URL;
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK;
const STATE_FILE = 'last_result.json';

const FIRST_NAME = process.env.FIRST_NAME || '';
const LAST_NAME = process.env.LAST_NAME || '';
const EMAIL_ADDRESS = process.env.EMAIL_ADDRESS || '';
const PHONE_NUMBER = process.env.PHONE_NUMBER || '';
const PROPOSED_GRAFTS = process.env.PROPOSED_GRAFTS || '';
const AUTO_BOOK_DAYS = ['Thursday', 'Friday'];
const AUTO_BOOK_AFTER = { month: 9, day: 20 }; // auto-book only dates after September 20

if (!APPOINTMENT_URL) {
  console.error('APPOINTMENT_URL not set in .env');
  process.exit(1);
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return null; }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function sendDiscord(message) {
  if (!DISCORD_WEBHOOK) {
    console.log('No DISCORD_WEBHOOK set — skipping notification');
    return;
  }
  const url = new URL(DISCORD_WEBHOOK);
  const body = JSON.stringify({ content: message });
  await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => { res.resume(); res.on('end', resolve); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
  console.log('Discord notification sent.');
}

async function bookAppointment(page, dayName, monthDay, year) {
  if (!FIRST_NAME || !LAST_NAME || !EMAIL_ADDRESS || !PHONE_NUMBER) {
    throw new Error('Booking PII not configured — set FIRST_NAME/LAST_NAME/EMAIL_ADDRESS/PHONE_NUMBER env vars (secrets in CI, .env locally)');
  }

  const dateLabel = `${dayName}, ${monthDay}, ${year}`;
  console.log(`Attempting to book ${dateLabel}...`);

  const dateList = page.locator(`div[role="list"][aria-label="${dateLabel}"]`).first();
  await dateList.scrollIntoViewIfNeeded();

  const slot = dateList.locator('[role="listitem"], button').first();
  await slot.click();
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'booking-form.png' }).catch(() => {});

  await page.getByLabel('First name').fill(FIRST_NAME);
  await page.getByLabel('Last name').fill(LAST_NAME);
  await page.getByLabel('Email address').fill(EMAIL_ADDRESS);
  await page.getByLabel('Phone number').fill(PHONE_NUMBER);
  await page.getByLabel('Proposed number of grafts').fill(PROPOSED_GRAFTS);
  await page.screenshot({ path: 'booking-form-filled.png' }).catch(() => {});

  await page.getByRole('button', { name: 'Book', exact: true }).click();
  await page.waitForTimeout(3000);
  await page.screenshot({ path: 'booking-confirmation.png' }).catch(() => {});

  console.log('Booking submitted.');
}

(async () => {
  const browser = await chromium.launch({ headless: !!process.env.CI });
  const page = await (await browser.newContext()).newPage();

  console.log('Loading appointment page...');
  await page.goto(APPOINTMENT_URL, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  console.log('Clicking jump to next available date...');
  await page.getByText('Jump to the next bookable date').click({ timeout: 10000 }).catch(() => {
    console.log('Jump button not found — no available dates may exist.');
  });
  await page.waitForTimeout(4000);

  // Find available date buttons and extract date from calendar UI
  const { parsed, hasAvailability } = await page.evaluate(() => {
    // Calendar day buttons look like: "16, Tuesday, no available times" or "16, Tuesday, 1 time available"
    const datePattern = /^(\d+), (Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)/i;
    const allDateBtns = [...document.querySelectorAll('button[aria-label]')]
      .filter(el => datePattern.test(el.getAttribute('aria-label') || ''));

    const availableBtns = allDateBtns.filter(el =>
      !(el.getAttribute('aria-label') || '').toLowerCase().includes('no available times')
    );

    if (availableBtns.length === 0) return { parsed: null, hasAvailability: false };

    // Get month/year from calendar heading
    const monthYearRe = /(January|February|March|April|May|June|July|August|September|October|November|December) \d{4}/i;
    let monthYear = null;
    for (const el of document.querySelectorAll('h1, h2, h3, [role="heading"]')) {
      const m = (el.textContent || '').match(monthYearRe);
      if (m) { monthYear = m[0]; break; }
    }
    // Also scan full body text as fallback for month/year
    if (!monthYear) {
      const m = document.body.innerText.match(monthYearRe);
      if (m) monthYear = m[0];
    }

    const label = availableBtns[0].getAttribute('aria-label') || '';
    const dm = label.match(/^(\d+), (Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)/i);
    if (dm && monthYear) {
      const [month, year] = monthYear.split(' ');
      return { parsed: { dayName: dm[2], monthDay: `${month} ${dm[1]}`, year }, hasAvailability: true };
    }

    return { parsed: null, hasAvailability: true };
  });

  let date = null;
  let displayDate = null;
  let isWeekday = false;
  let dateObj = null;

  if (parsed) {
    dateObj = new Date(`${parsed.monthDay}, ${parsed.year}`);
    if (!isNaN(dateObj)) {
      const mm = String(dateObj.getMonth() + 1).padStart(2, '0');
      const dd = String(dateObj.getDate()).padStart(2, '0');
      const yy = String(dateObj.getFullYear()).slice(-2);
      date = `${mm}/${dd}/${yy}`;
      isWeekday = !['Saturday', 'Sunday'].includes(parsed.dayName);
      displayDate = `${parsed.dayName}, ${date}`;
    }
  }

  if (!date) {
    date = 'an upcoming date';
    displayDate = date;
  }

  // Auto-book only dates that are Thursday or Friday AND after Sept 20 of that year
  let shouldAutoBook = false;
  if (parsed && dateObj && !isNaN(dateObj)) {
    const threshold = new Date(dateObj.getFullYear(), AUTO_BOOK_AFTER.month - 1, AUTO_BOOK_AFTER.day);
    shouldAutoBook = dateObj > threshold && AUTO_BOOK_DAYS.includes(parsed.dayName);
  }

  const last = loadState();
  const isNew = !last?.hasAvailability;
  const dateChanged = last?.date !== date;
  const alreadyBooked = last?.bookedDate === date;

  let bookedDate = last?.bookedDate || null;
  let bookingOutcome = null; // 'booked' | 'failed' | null

  if (hasAvailability && shouldAutoBook && !alreadyBooked) {
    try {
      await bookAppointment(page, parsed.dayName, parsed.monthDay, parsed.year);
      bookedDate = date;
      bookingOutcome = 'booked';
    } catch (err) {
      console.error('Auto-booking failed:', err.message);
      bookingOutcome = 'failed';
      await page.screenshot({ path: 'booking-error.png' }).catch(() => {});
    }
  }

  const result = { hasAvailability, date, checkedAt: new Date().toISOString(), bookedDate };
  console.log(JSON.stringify(result, null, 2));

  if (bookingOutcome === 'booked') {
    const msg = `@everyone ✅ **Auto-booked ${displayDate}** at Nader Medical! (Phone: ${PHONE_NUMBER}, Grafts: ${PROPOSED_GRAFTS})\n${APPOINTMENT_URL}`;
    await sendDiscord(msg);
  } else if (bookingOutcome === 'failed') {
    const msg = `@everyone ⚠️ Found a matching date **${displayDate}** (Thu/Fri after 9/20) but auto-booking FAILED — please book it manually!\n${APPOINTMENT_URL}`;
    await sendDiscord(msg);
  } else if (hasAvailability && (isNew || dateChanged)) {
    const weekdayNote = parsed ? (isWeekday ? ' (weekday)' : ' (weekend)') : '';
    const msg = `@everyone 📅 **${displayDate}**${weekdayNote} is available at Nader Medical!\n${APPOINTMENT_URL}`;
    console.log('New availability — sending notification...');
    await sendDiscord(msg);
  } else if (hasAvailability) {
    console.log('Availability unchanged — no notification sent.');
  } else {
    console.log('No availability found.');
  }

  saveState(result);
  await browser.close();
})();
