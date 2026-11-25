import { randomUUID } from 'node:crypto';
import { describe, test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { z } from 'zod';

const projectTest = test.extend<{ project: { id: string } }>({
  project: async ({ app, browser, request }, use) => {
    // Host-only cookie uses hostname; for a parent-domain cookie (`Domain=example.com`), match `.example.com`.
    const domain = new URL(app.baseUrl).hostname;
    const session = (await browser.cookies()).find((c) => c.name === 'session' && c.domain === domain);
    if (session === undefined) throw new Error('not signed in: no session cookie for the app');
    const headers = { cookie: `session=${session.value}` };
    let project: { id: string } | undefined;
    try {
      const created = await request.post(`${app.baseUrl}/api/projects`, { json: { name: `Project ${randomUUID()}` }, headers });
      expect(created.status).toBe(201);
      project = expect(await created.json()).toMatchSchema(z.object({ id: z.string() }));
      await use(project);
    } finally {
      if (project !== undefined) {
        const deleted = await request.delete(`${app.baseUrl}/api/projects/${project.id}`, { headers });
        expect([200, 204, 404]).toContain(deleted.status);
      }
    }
  },
});

describe('project settings', { session: 'admin' }, () => {
  projectTest('renames a project', async ({ app, screen, project }) => {
    const name = screen.getByLabel('Name');
    await app.open(`/projects/${project.id}/settings`); // straight to the screen under test

    await name.fill('Atlas');
    await screen.getByRole('button', 'Save').tap();
    await screen.getByRole('status').filter({ hasText: /^Saved$/ }).waitFor();
    await app.open(`/projects/${project.id}/settings`); // reopened: the promise is that it is saved

    await expect(name).toHaveValue('Atlas');
  });
});
