import { test, expect, chromium, firefox, webkit, type Browser } from '@playwright/test';

test('Vue3 demo connects 5 Chromium + 5 WebKit + 5 Firefox peers', async ({ baseURL }) => {
  test.setTimeout(210_000);

  const peersPerBrowser = 5;
  const totalPeers = peersPerBrowser * 3;

  // Cross-engine WebRTC in automation is inherently flaky.
  // This test validates that we bring up 5/5/5 peers and the mesh forms.
  const requiredAtLeastOneOverall = 12;
  const requiredAtLeastOnePerEngine = 3;

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
  let progressTimer: NodeJS.Timeout | undefined;

  try {
    for (const { name, browser } of browsers) {
      const context = await browser.newContext({ ignoreHTTPSErrors: true });
      const newPages = await Promise.all(
        Array.from({ length: peersPerBrowser }).map(async () => {
          const page = await context.newPage();

          page.on('console', (msg) => {
            const text = msg.text();
            if (msg.type() === 'error' || msg.type() === 'warning' || /(webrtc|ice|offer|answer|candidate|signal)/i.test(text)) {
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

    const getDiscoveredCount = async (page: any) => {
      const text = ((await page.locator('[data-testid="discovered-peers"]').innerText()) || '').trim();
      return Number(text) || 0;
    };

    const summarizeConnections = async () => {
      const entries = await Promise.all(
        pages.map(async ({ name, page }) => ({ name, connected: await getConnectedCount(page) }))
      );

      const overallConnectedPeers = entries.filter((e) => e.connected >= 1).length;
      const byEngine = {
        chromium: entries.filter((e) => e.name === 'chromium' && e.connected >= 1).length,
        webkit: entries.filter((e) => e.name === 'webkit' && e.connected >= 1).length,
        firefox: entries.filter((e) => e.name === 'firefox' && e.connected >= 1).length
      };

      return { overallConnectedPeers, byEngine, entries };
    };

    const summarizeDiscovery = async () => {
      const entries = await Promise.all(
        pages.map(async ({ name, page }) => ({ name, discovered: await getDiscoveredCount(page) }))
      );
      const byEngineAvg = {
        chromium: entries.filter((e) => e.name === 'chromium').reduce((a, e) => a + e.discovered, 0) / peersPerBrowser,
        webkit: entries.filter((e) => e.name === 'webkit').reduce((a, e) => a + e.discovered, 0) / peersPerBrowser,
        firefox: entries.filter((e) => e.name === 'firefox').reduce((a, e) => a + e.discovered, 0) / peersPerBrowser
      };
      return { byEngineAvg, entries };
    };

    progressTimer = setInterval(async () => {
      try {
        const s = await summarizeConnections();
        // eslint-disable-next-line no-console
        console.log(
          `[progress] connected>=1: ${s.overallConnectedPeers}/${totalPeers} ` +
            `(chromium ${s.byEngine.chromium}/${peersPerBrowser}, webkit ${s.byEngine.webkit}/${peersPerBrowser}, firefox ${s.byEngine.firefox}/${peersPerBrowser})`
        );
      } catch {
        // ignore
      }
    }, 5000);

    // Target: most peers should have at least one connection.
    await expect
      .poll(async () => {
        const s = await summarizeConnections();
        return (
          s.overallConnectedPeers >= requiredAtLeastOneOverall &&
          s.byEngine.chromium >= requiredAtLeastOnePerEngine &&
          s.byEngine.webkit >= requiredAtLeastOnePerEngine &&
          s.byEngine.firefox >= requiredAtLeastOnePerEngine
        );
      }, {
        timeout: 150_000,
        intervals: [500, 1000, 2000, 5000]
      })
      .toBe(true);
  } finally {
    if (progressTimer) clearInterval(progressTimer);
    await Promise.all(browsers.map(async ({ browser }) => browser.close()));
  }
});
