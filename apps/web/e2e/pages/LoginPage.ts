import { expect, Locator, Page } from '@playwright/test';

export class LoginPage {
  readonly page: Page;
  readonly username: Locator;
  readonly password: Locator;
  readonly submit: Locator;

  constructor(page: Page) {
    this.page = page;
    // Selectores por ID estable (sobreviven a cambios de copy/placeholder del rediseño FLIT).
    this.username = page.locator('#login-username');
    this.password = page.locator('#login-password');
    this.submit = page.getByRole('button', { name: /ingresar/i });
  }

  async goto() {
    await this.page.goto('/login');
    await expect(this.username).toBeVisible();
  }

  async fillCredentials(username: string, password: string) {
    await this.username.fill(username);
    await this.password.fill(password);
  }

  async submitForm() {
    await this.submit.click();
  }

  async login(username: string, password: string) {
    await this.fillCredentials(username, password);
    await this.submitForm();
  }

  async expectErrorToast(text: string | RegExp) {
    await expect(this.page.locator('[role="status"]', { hasText: text })).toBeVisible();
  }
}
