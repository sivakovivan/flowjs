import { expect, test } from '@playwright/test';

test('corner controls mount glass and keep submenus inside the viewport', async ({
    page,
}) => {
    await page.goto('/');
    const launcher = page.getByRole('button', {
        name: 'flow.js controls',
        exact: true,
    });
    await launcher.click();
    const dialog = page.getByRole('dialog', {
        name: 'flow.js dashboard controls',
    });
    await expect(dialog.locator('.flow-menu__lens')).toBeVisible();
    await page.getByRole('button', { name: 'Version history' }).click();
    await page.mouse.click(5, 5);
    await expect(dialog).toBeHidden();
    await page.setViewportSize({ width: 390, height: 700 });
    await launcher.click();
    await page.getByRole('button', { name: 'Customize', exact: true }).click();
    await expect(page.getByRole('textbox')).toBeVisible();
    const bounds = await dialog.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(launcher).toBeFocused();
});

test('high contrast uses an opaque, non-refracting material', async ({
    page,
}) => {
    await page.emulateMedia({ forcedColors: 'active' });
    await page.goto('/');
    await page
        .getByRole('button', { name: 'flow.js controls', exact: true })
        .click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.locator('.flow-menu__lens')).toHaveCount(0);
});

test('streams semantic menu activity without transmitting typed search text', async ({
    page,
}) => {
    const events: Array<{
        eventType: string;
        eventId: string;
        metadata: { path?: string[]; activeMs?: number };
    }> = [];
    page.on('request', (request) => {
        if (
            request.url().endsWith('/api/flow/telemetry') &&
            request.method() === 'POST'
        )
            events.push(...request.postDataJSON().events);
    });
    await page.goto('/');
    await page.bringToFront();
    await page
        .getByRole('button', { name: 'flow.js controls', exact: true })
        .click();
    await page.getByRole('button', { name: 'Version history' }).click();
    await expect
        .poll(() =>
            events.some(
                (event) =>
                    event.eventType === 'active_time' &&
                    event.metadata.path?.join('/') === 'controls/history' &&
                    (event.metadata.activeMs ?? 0) > 0
            )
        )
        .toBe(true);
    await page.getByRole('button', { name: 'Back to controls' }).click();
    await expect
        .poll(() =>
            events.some(
                (event) =>
                    event.eventType === 'menu_close' &&
                    event.metadata.path?.join('/') === 'controls/history'
            )
        )
        .toBe(true);
    expect(
        events.some(
            (event) =>
                event.eventType === 'menu_select' &&
                event.metadata.path?.join('/') === 'controls/history'
        )
    ).toBe(false);
    await page.keyboard.press('Escape');
    await page
        .getByRole('searchbox', { name: 'Customer search' })
        .fill('do-not-export@example.test');
    await expect
        .poll(() => events.some((event) => event.eventType === 'value_change'))
        .toBe(true);
    expect(
        events.some(
            (event) =>
                event.eventType === 'menu_open' &&
                event.metadata.path?.join('/') === 'controls/history'
        )
    ).toBe(true);
    expect(events.every((event) => /^[a-f0-9-]{36}$/.test(event.eventId))).toBe(
        true
    );
    expect(JSON.stringify(events)).not.toContain('do-not-export@example.test');
});
