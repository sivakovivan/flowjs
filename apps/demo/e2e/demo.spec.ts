import { expect, test, type Page } from '@playwright/test';

/*
 * The hackathon demo, end to end: generate v1 from capabilities, use it,
 * inspect telemetry, optimize, watch the interface change, reload, inspect
 * history and undo. Runs with recorded AI responses (labelled in the UI).
 */

test.describe.configure({ mode: 'serial' });

const versionBadge = (page: Page) => page.locator('.version-badge');

async function setMutationRate(page: Page, rate: number) {
    const saved = page.waitForResponse(
        (r) => r.url().endsWith('/api/flow/settings') && r.ok()
    );
    await page.getByLabel('Mutation rate').fill(String(rate));
    await saved;
}

test('capabilities in, adaptive interface out', async ({ page }) => {
    await page.goto('/');
    await expect(
        page.getByRole('heading', { name: 'No dashboard layout was written.' })
    ).toBeVisible();
    await page.getByRole('button', { name: 'Generate dashboard' }).click();
    await expect(versionBadge(page)).toHaveText('v1');
    await expect(
        page.locator('.stage').getByText('Recorded response')
    ).toBeVisible();

    // Use it: date range → revenue chart, repeatedly, then export.
    const dateRange = page.getByRole('combobox', { name: 'Date range' });
    for (const range of ['7d', '90d', '30d']) {
        await dateRange.scrollIntoViewIfNeeded();
        await dateRange.selectOption(range);
        await page
            .locator('[data-component="revenue-chart"] .app-chart')
            .click();
    }
    const exported = page.waitForResponse(
        (response) => response.url().endsWith('/api/flow/actions/exportReport'),
        { timeout: 60_000 }
    );
    await page.getByRole('button', { name: 'Export CSV' }).click();
    expect((await exported).ok()).toBeTruthy();
    await expect(
        page.getByText(/Exported \d+ of \d+ transactions/)
    ).toBeVisible();

    // Actions still work: refund the first paid transaction.
    const table = page.locator('[data-component="transactions-table"]');
    await table
        .locator('tr', { has: page.locator('.app-pill--paid') })
        .first()
        .click();
    await page.getByRole('button', { name: /Refund transaction TX-/ }).click();
    await expect(page.getByText(/Refunded TX-\d+/)).toBeVisible();
    await expect(table.locator('.app-pill--refunded')).toHaveCount(1);

    // Real telemetry arrives, then clearly labelled seeded sessions are added.
    await expect(
        page.locator('.metrics-table tr', { hasText: 'date-range' })
    ).toContainText('3');
    await page.getByRole('button', { name: 'Add 6 seeded sessions' }).click();
    await expect(page.locator('.telemetry .seeded')).toHaveText('6 seeded');

    // Optimize: evidence before change.
    await page.getByRole('button', { name: 'Optimize now' }).click();
    const evidence = page.locator('.evidence');
    await expect(evidence.getByText('Interface friction')).toBeVisible();
    await expect(evidence.getByText('Recorded response')).toBeVisible();
    await expect(
        evidence.getByText(/Based on 7 sessions \(1 live, 6 seeded\)/)
    ).toBeVisible();
    await expect(evidence.locator('.mutations')).toContainText('MOVE');
    await expect(evidence.locator('.mutations')).toContainText('SWAP_VARIANT');

    const apply = page.getByRole('button', { name: 'Apply change' });
    if (await apply.isVisible()) await apply.click();
    await expect(versionBadge(page)).toHaveText('v2', { timeout: 10_000 });
    const segmented = page.getByRole('radiogroup', { name: 'Date range' });
    await expect(segmented).toBeVisible();
    await expect(
        page.locator('[data-component="date-range"] .change-tag')
    ).toHaveText('Moved, Resized, New control');
    // Only the promoted control is tagged as moved.
    await expect(page.locator('.change-tag')).toHaveCount(1);

    // The new control still drives the data.
    await segmented.getByRole('radio', { name: '7 days' }).click();
    await expect(
        segmented.getByRole('radio', { name: '7 days' })
    ).toHaveAttribute('aria-checked', 'true');

    // Persistence.
    await page.reload();
    await expect(versionBadge(page)).toHaveText('v2');

    // History and undo.
    await page.getByRole('button', { name: 'History' }).click();
    const history = page.getByRole('dialog', { name: 'UI history' });
    await expect(history).toContainText('Date control promoted above Revenue');
    await expect(history).toContainText('Generated dashboard');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '↶ Undo' }).click();
    await expect(versionBadge(page)).toHaveText('v1');
    await expect(
        page.getByRole('combobox', { name: 'Date range' })
    ).toBeVisible();
});

test('mutation rate 0 never applies automatically', async ({ page }) => {
    await page.goto('/');
    await expect(versionBadge(page)).toHaveText('v1');
    await setMutationRate(page, 0);
    await expect(
        page.getByText('Rate 0: never applies changes automatically')
    ).toBeVisible();
    await page.getByRole('button', { name: 'Optimize now' }).click();
    await expect(
        page.getByText('Mutation rate is 0, so nothing applies automatically.')
    ).toBeVisible();
    await expect(
        page.getByRole('button', { name: 'Apply change' })
    ).toBeVisible();
    await page.waitForTimeout(4_000);
    await expect(versionBadge(page)).toHaveText('v1');
});

test('a high mutation rate applies automatically and branches from the active version', async ({
    page,
}) => {
    await page.goto('/');
    await setMutationRate(page, 1);
    await page.getByRole('button', { name: 'Optimize now' }).click();
    await expect(page.getByText(/Applying automatically in \ds/)).toBeVisible();
    await expect(versionBadge(page)).toHaveText('v3', { timeout: 10_000 });
    await page.getByRole('button', { name: 'History' }).click();
    await expect(
        page.getByRole('dialog', { name: 'UI history' }).locator('li').first()
    ).toContainText('From v1');
});

test('retries on a slow backend are diagnosed as performance, not redesigned', async ({
    page,
}) => {
    await page.goto('/');
    await expect(versionBadge(page)).toHaveText('v3');
    const exportPdf = page.getByRole('button', { name: 'Export PDF' });
    // Impatient user: clicks again while the slow PDF export is still running.
    await exportPdf.click();
    await exportPdf.click();
    await exportPdf.click();
    await expect(
        page.getByText(/PDF report for \d+ transactions is ready/)
    ).toBeVisible({ timeout: 10_000 });

    await page.getByRole('button', { name: 'Optimize now' }).click();
    const evidence = page.locator('.evidence');
    await expect(evidence.getByText('Backend performance')).toBeVisible();
    await expect(evidence).toContainText(
        'No interface change. Fix the backend before redesigning this control.'
    );
    await expect(evidence.locator('.findings')).toContainText(
        'retried because the backend is slow'
    );
    await expect(evidence.locator('.findings')).toContainText(
        'in sessions that retried'
    );
    // Whatever the median, the slow tail is visible in the latency table.
    await expect(
        evidence
            .locator('.latency tr', { hasText: 'exportReport' })
            .locator('.is-slow-tail')
    ).toBeVisible();
    await expect(
        page.getByRole('button', { name: 'Apply change' })
    ).toHaveCount(0);
    await expect(versionBadge(page)).toHaveText('v3');
});
