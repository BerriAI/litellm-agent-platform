import { chromium } from 'playwright';

const SESSION_ID = '50884e9b-aa97-4f5e-bad6-d145b4fbdabc';
const MASTER_KEY = 'sk-dev-master-key-change-me';
const BASE = 'http://localhost:3004';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.setDefaultTimeout(120000);

const shot = async (name) => { const p = `/tmp/diag-${name}.png`; await page.screenshot({ path: p, fullPage: true }); console.log(`screenshot: ${p}`); };

const sseEvents = [];
page.on('response', async (res) => {
  const url = res.url();
  if (url.includes('message_stream')) {
    console.log(`SSE: ${res.status()} ${url}`);
    try {
      const body = await res.text().catch(() => '');
      body.split('\n').filter(l => l.startsWith('data:')).forEach(l => { sseEvents.push(l); console.log('  SSE:', l.slice(0,150)); });
    } catch(e) { console.log('SSE read err:', e.message); }
  }
  if (res.status() >= 400 && url.includes('managed_agents')) console.log(`ERR ${res.status()} ${url}`);
});

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.locator('input').first().fill(MASTER_KEY);
await page.locator('input').first().press('Enter');
await page.waitForTimeout(1500);

await page.goto(`${BASE}/sessions/${SESSION_ID}`, { waitUntil: 'load' });
await page.waitForTimeout(1500);
await shot('1-initial');

const ta = page.locator('textarea[placeholder="Add a follow up"]');
await ta.click();
await ta.fill('summarize https://github.com/BerriAI/litellm/issues/28283');
await page.waitForFunction(() => !document.querySelector('button[aria-label="Send"]')?.disabled, { timeout: 5000 });
await page.locator('button[aria-label="Send"]').click();
console.log('sent');
await shot('2-sent');

for (let i = 0; i < 20; i++) {
  await page.waitForTimeout(3000);
  const t = await page.locator('body').innerText();
  const thinking = (t.match(/thinking/gi)||[]).length;
  const hasResponse = t.includes('28283') || t.includes('regression');
  console.log(`t=${i*3+3}s thinking_count=${thinking} hasResponse=${hasResponse}`);
  if (i === 3 || i === 9 || i === 15) await shot(`poll-${i*3+3}s`);
  if (hasResponse) { console.log('GOT RESPONSE'); break; }
}

await shot('3-final');
console.log('\nSSE total events:', sseEvents.length);
await browser.close();
