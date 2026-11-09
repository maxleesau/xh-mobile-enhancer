import { test as base, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '..', 'xh-desktop-enhancer.user.js');

export const HOME = 'https://xhamster.com/';

// addInitScript runs before any page script, in the page world — the exact
// equivalent of @run-at document-start with @grant none. The file under test
// is byte-identical to the file a user installs.
export const test = base.extend({
  page: async ({ browser }, use) => {
    const context = await browser.newContext();
    await context.addInitScript({ path: SCRIPT });
    const page = await context.newPage();
    await use(page);
    await context.close();
  },
});

export { expect };

// Video IDs rot, so never hardcode one: land on the home page and follow the
// first watch link the site offers.
export async function gotoWatchPage(page) {
  await page.goto(HOME, { waitUntil: 'domcontentloaded' });
  const link = page.locator('a[href*="/videos/"]').first();
  await link.waitFor({ state: 'attached', timeout: 20_000 });
  const href = await link.getAttribute('href');
  await page.goto(new URL(href, HOME).href, { waitUntil: 'domcontentloaded' });
  return page.url();
}
