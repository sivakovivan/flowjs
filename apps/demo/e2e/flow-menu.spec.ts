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
    await expect(dialog.locator('.glass__warp')).toBeVisible();
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
