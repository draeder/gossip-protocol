import { test, expect, chromium } from '@playwright/test';

test('Token ring (chromium only) converges to 15/15 peers with 2 neighbors', async ({ baseURL }) => {
  test.setTimeout(210_000);

  const peerCount = 15;
  const sessionId = `pw-ring-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const url = `${baseURL}/?autostart=1&topology=ring&maxPeers=2&minPeers=2&sessionId=${encodeURIComponent(sessionId)}`;

  const browser = await chromium.launch({
    args: ['--disable-features=WebRtcHideLocalIpsWithMdns']
  });

  try {
    const context = await browser.newContext();
    const pages = await Promise.all(
      Array.from({ length: peerCount }).map(async () => {
        const page = await context.newPage();
        await page.goto(url);
        return page;
      })
    );

    // Wait for all peers to show "2 / 2".
    await expect
      .poll(async () => {
        const counts = await Promise.all(
          pages.map(async (page) => {
            const text = ((await page.locator('[data-testid="connected-peers"]').innerText()) || '').trim();
            const match = text.match(/^(\d+)\s*\//);
            return match ? Number(match[1]) : 0;
          })
        );
        return counts.filter((n) => n >= 2).length;
      }, {
        timeout: 180_000,
        intervals: [500, 1000, 2000, 5000]
      })
      .toBe(peerCount);

    await context.close();
  } finally {
    await browser.close();
  }
});
