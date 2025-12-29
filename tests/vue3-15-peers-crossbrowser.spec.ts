import { test, expect, chromium, firefox, webkit, type Browser } from '@playwright/test';

test('Vue3 demo propagates a gossip message across engines', async ({ baseURL }, testInfo) => {
  const peersPerBrowser = 5;
  const totalPeers = peersPerBrowser * 3;

  // Cross-engine WebRTC in automation is inherently flaky.
  // This test validates that we bring up 5/5/5 peers and that a gossip message propagates.
  // With a 15s per-test timeout, keep this threshold achievable.
  const requiredReceiversOverall = 4; // excluding sender
  const requiredReceiversPerEngine = 1;

  // Keep time budgeting explicit so the test stays within the loop's --timeout.
  const budgetMs = Math.max(1_000, (testInfo?.timeout ?? 15_000) - 1_000);
  const connectWaitMs = Math.min(3_500, Math.floor(budgetMs * 0.25));
  const messageWaitMs = Math.min(10_000, Math.floor(budgetMs * 0.75));

  const sessionId = `pw-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const url = `${baseURL}/?autostart=1&maxPeers=20&minPeers=3&topology=partial&sessionId=${encodeURIComponent(sessionId)}`;

  const browsers: { name: string; browser: Browser }[] = [];

  // Launch three engines at once so all 15 peers share the same signaling session.
  // Chromium uses mDNS host candidates by default; disabling it improves cross-engine ICE on localhost.
  browsers.push({
    name: 'chromium',
    browser: await chromium.launch({
      args: ['--disable-features=WebRtcHideLocalIpsWithMdns']
    })
  });
  browsers.push({ name: 'webkit', browser: await webkit.launch() });
  browsers.push({
    name: 'firefox',
    browser: await firefox.launch({
      firefoxUserPrefs: {
        'media.peerconnection.enabled': true,
        // Make sure Firefox advertises usable host candidates for local tests.
        'media.peerconnection.ice.obfuscate_host_addresses': false,
        'media.peerconnection.ice.loopback': true,
        'media.peerconnection.ice.no_host': false,
        'media.peerconnection.ice.proxy_only': false,
        'media.peerconnection.ice.relay_only': false
      }
    })
  });

  const pages: { name: string; page: any }[] = [];

  try {
    for (const { name, browser } of browsers) {
      const context = await browser.newContext({ ignoreHTTPSErrors: true });
      const newPages = await Promise.all(
        Array.from({ length: peersPerBrowser }).map(async () => {
          const page = await context.newPage();

          page.on('console', (msg) => {
            const text = msg.text();
            // Keep output minimal: only surface console errors.
            // (ICE candidate / offer/answer logs are extremely noisy in automation.)
            if (msg.type() === 'error') {
              // eslint-disable-next-line no-console
              console.log(`[${name}] console.${msg.type()}: ${text}`);
            }
          });

          page.on('pageerror', (err) => {
            // eslint-disable-next-line no-console
            console.log(`[${name}] pageerror: ${String(err)}`);
          });

          await page.goto(url);
          return page;
        })
      );
      newPages.forEach((page) => pages.push({ name, page }));
    }

    // Confirm each peer actually applied maxPeers=20 and got a client id.
    const clientIds = await Promise.all(
      pages.map(async ({ page, name }) => {
        await expect(page.locator('[data-testid="connected-peers"]'), `${name}: maxPeers not applied`).toContainText('/ 20');
        const clientIdLoc = page.locator('[data-testid="client-id"]');
        await expect(clientIdLoc, `${name}: client id missing`).not.toHaveText('');
        const id = (await clientIdLoc.innerText()).trim();
        expect(id.length, `${name}: empty client id`).toBeGreaterThan(0);
        return id;
      })
    );

    expect(new Set(clientIds).size).toBe(totalPeers);

    const getConnectedCount = async (page: any) => {
      const text = ((await page.locator('[data-testid="connected-peers"]').innerText()) || '').trim();
      // "X / 20"
      const match = text.match(/^(\d+)\s*\//);
      return match ? Number(match[1]) : 0;
    };

    const getMessagesSeen = async (page: any) => {
      const text = ((await page.locator('[data-testid="messages-seen"]').innerText()) || '').trim();
      return Number(text) || 0;
    };

    // Pick a single sender and ensure it has at least one connection before sending.
    const sender = pages[0];
    await expect
      .poll(async () => await getConnectedCount(sender.page), { timeout: connectWaitMs, intervals: [250, 500, 1000] })
      .toBeGreaterThan(0);

    const baselines = await Promise.all(
      pages.map(async ({ page, name }) => ({ name, page, baseline: await getMessagesSeen(page) }))
    );

    const message = `pw-gossip-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    await sender.page.getByPlaceholder('Type a message...').fill(message);
    await sender.page.keyboard.press('Enter');

    // Expect the message to propagate to multiple peers across engines.
    await expect
      .poll(async () => {
        const now = await Promise.all(
          baselines.map(async (b) => ({
            name: b.name,
            delta: (await getMessagesSeen(b.page)) - b.baseline
          }))
        );

        const receivers = now.filter((e, idx) => idx !== 0 && e.delta > 0);
        const byEngine = {
          chromium: receivers.filter((e) => e.name === 'chromium').length,
          webkit: receivers.filter((e) => e.name === 'webkit').length,
          firefox: receivers.filter((e) => e.name === 'firefox').length
        };

        return (
          receivers.length >= requiredReceiversOverall &&
          byEngine.chromium >= requiredReceiversPerEngine &&
          byEngine.webkit >= requiredReceiversPerEngine &&
          byEngine.firefox >= requiredReceiversPerEngine
        );
      }, { timeout: messageWaitMs, intervals: [250, 500, 1000, 2000] })
      .toBe(true);
  } finally {
    await Promise.all(browsers.map(async ({ browser }) => browser.close()));
  }
});
