/** Detours in a recorded flow: a screen left and come back to with nothing typed, chosen, or set on the way. */

import { describe, expect, it } from 'vitest';
import { boundDetour, describeDetour, findDetours, findDetoursAfterReplay, findReplayedDetours, settledDetour } from '@e2e-dev/core/lib/cache/detours';
import { routeLocation } from '@e2e-dev/core/lib/cache/route';
import { SecretLedger } from '@e2e-dev/core/lib/internal/redact';
import { bound } from '@e2e-dev/core/lib/internal/text';
import type { ActionTrace, RecordedAction } from '@e2e-dev/core/lib/cache/trace';

function tap(name: string, at?: string, role = 'button'): RecordedAction {
  return { name: 'tap', summary: `tap ${role} "${name}"`, target: { role, name }, ...(at === undefined ? {} : { at }) };
}

function scroll(at?: string): RecordedAction {
  return { name: 'scroll', summary: 'scroll down', direction: 'down', ...(at === undefined ? {} : { at }) };
}

function navigate(url: string, at?: string): RecordedAction {
  return { name: 'navigate', summary: `navigate to ${url}`, url, ...(at === undefined ? {} : { at }) };
}

function back(at?: string): RecordedAction {
  return { name: 'back', summary: 'go back', ...(at === undefined ? {} : { at }) };
}

function type(name: string, value: string, at?: string): RecordedAction {
  return { name: 'type', summary: `type "${value}" into textbox "${name}"`, target: { role: 'textbox', name }, value, ...(at === undefined ? {} : { at }) };
}

function flow(actions: readonly RecordedAction[], ends: { startPath?: string; endPath?: string; truncated?: boolean } = {}): Pick<ActionTrace, 'actions' | 'startPath' | 'endPath' | 'truncated' | 'detours'> {
  return { actions, ...ends };
}

describe('findDetours by recorded locations', () => {
  it('finds the wrong settings page that was scrolled and backed out of', () => {
    // The iOS case: Settings, the wrong page, back, then the right page.
    const detours = findDetours(
      flow(
        [
          tap('Notifications', 'com.example / Settings'),
          scroll('com.example / Notifications'),
          back('com.example / Notifications'),
          tap('Privacy', 'com.example / Settings'),
          tap('Clear history', 'com.example / Privacy'),
        ],
        { endPath: 'com.example / Privacy' },
      ),
    );
    expect(detours).toEqual([{ from: 0, to: 3, at: 'com.example / Settings', via: 'com.example / Notifications', evidence: 'locations' }]);
    expect(describeDetour(detours[0]!)).toBe('actions 1-3 left com.example / Settings for com.example / Notifications and came back with nothing typed, chosen, or set');
  });

  it('finds a return at the end of the step, against the end location', () => {
    const detours = findDetours(flow([tap('Reports', '/home'), back('/reports')], { startPath: '/home', endPath: '/home' }));
    expect(detours).toEqual([{ from: 0, to: 2, at: '/home', via: '/reports', evidence: 'locations' }]);
  });

  it('reads each wrong turn from one menu as a detour of its own', () => {
    const detours = findDetours(
      flow([tap('A', '/menu'), back('/a'), tap('B', '/menu'), back('/b'), tap('C', '/menu')], { endPath: '/c' }),
    );
    expect(detours).toEqual([
      { from: 0, to: 2, at: '/menu', via: '/a', evidence: 'locations' },
      { from: 2, to: 4, at: '/menu', via: '/b', evidence: 'locations' },
    ]);
  });

  it('is no detour when something was typed or set before going back', () => {
    expect(findDetours(flow([tap('Edit', '/items'), type('Name', 'Ada', '/items/42/edit'), back('/items/42/edit')], { endPath: '/items' }))).toEqual([]);
    expect(findDetours(flow([tap('Display', '/settings'), tap('Dark mode', '/settings/display', 'switch'), back('/settings/display')], { endPath: '/settings' }))).toEqual([]);
  });

  it('counts a tap on or inside a switch or checkbox as a change, and a hover over one as none', () => {
    const toggled: RecordedAction = {
      name: 'tapAt',
      summary: 'tap the point (40, 80)',
      point: { x: 40, y: 80 },
      viewport: { width: 390, height: 844 },
      within: { target: { role: 'switch', name: 'Dark mode' }, fx: 0.5, fy: 0.5 },
      at: '/settings/display',
    };
    expect(findDetours(flow([tap('Display', '/settings'), toggled, back('/settings/display')], { endPath: '/settings' }))).toEqual([]);
    // A node tap on the icon inside the switch sets the switch too.
    const iconTap: RecordedAction = { ...tap('Moon', '/settings/display', 'img'), controlRole: 'switch' } as RecordedAction;
    expect(findDetours(flow([tap('Display', '/settings'), iconTap, back('/settings/display')], { endPath: '/settings' }))).toEqual([]);
    // The icon inside the switch held the point; the switch is the control it set.
    const onIcon: RecordedAction = { ...toggled, within: { target: { role: 'img', name: 'Moon' }, fx: 0.5, fy: 0.5 }, controlRole: 'switch' } as RecordedAction;
    expect(findDetours(flow([tap('Display', '/settings'), onIcon, back('/settings/display')], { endPath: '/settings' }))).toEqual([]);
    // A checkbox whose label holds a link reaches the link at its centre and still sets the checkbox.
    const labelLink: RecordedAction = { ...tap('I agree to the Terms', '/signup/terms', 'checkbox'), controlRole: 'link' } as RecordedAction;
    expect(findDetours(flow([tap('Terms', '/signup'), labelLink, back('/signup/terms')], { endPath: '/signup' }))).toEqual([]);
    const pointOnLabelLink: RecordedAction = { ...toggled, within: { target: { role: 'checkbox', name: 'I agree' }, fx: 0.5, fy: 0.5 }, controlRole: 'link' } as RecordedAction;
    expect(findDetours(flow([tap('Terms', '/signup'), pointOnLabelLink, back('/settings/display')], { endPath: '/signup' }))).toEqual([]);
    const hovered: RecordedAction = { name: 'hover', summary: 'hover checkbox "Beta"', target: { role: 'checkbox', name: 'Beta' }, at: '/settings/labs' };
    expect(findDetours(flow([tap('Labs', '/settings'), hovered, back('/settings/labs')], { endPath: '/settings' }))).toEqual([
      { from: 0, to: 3, at: '/settings', via: '/settings/labs', evidence: 'locations' },
    ]);
  });

  it('is no detour for a flow that stays on one screen or only moves forward', () => {
    expect(findDetours(flow([tap('Open', '/'), tap('Close', '/'), tap('Open', '/')], { endPath: '/' }))).toEqual([]);
    expect(findDetours(flow([tap('Next', '/one'), tap('Next', '/two'), tap('Done', '/three')], { endPath: '/done' }))).toEqual([]);
  });

  it('finds the trip before a fill recorded as a gap, from where the gap ran', () => {
    const gap: RecordedAction = { name: 'tool', summary: 'tool type (run-time value)', derived: 'minted-token', at: '/' };
    expect(findDetours(flow([tap('About', '/'), back('/about'), gap, tap('Increment', '/')], { endPath: '/' }))).toEqual([
      { from: 0, to: 2, at: '/', via: '/about', evidence: 'locations' },
    ]);
  });

  it('finds the trip that ended before a project tool ran, from where the tool ran', () => {
    const tool: RecordedAction = { name: 'tool', summary: 'tool open_billing', at: '/settings' };
    expect(findDetours(flow([tap('Privacy', '/settings'), back('/privacy'), tool], { endPath: '/billing' }))).toEqual([
      { from: 0, to: 2, at: '/settings', via: '/privacy', evidence: 'locations' },
    ]);
  });

  it('names the screen the leaving action stood on, as a stored span does', () => {
    const trip = flow([tap('Top', '/a'), tap('Leave', '/a#top'), back('/b'), tap('Stay', '/a')], { endPath: '/a' });
    const fresh = findDetours(trip);
    expect(fresh).toEqual([{ from: 1, to: 3, at: '/a', via: '/b', evidence: 'locations' }]);
    // The entry stores each location as its route, as the step stages it.
    const stored = flow([tap('Top', '/a'), tap('Leave', '/a'), back('/b'), tap('Stay', '/a')], { endPath: '/a' });
    expect(findDetours({ ...stored, detours: fresh.map(({ from, to }) => ({ from, to })) })).toEqual(fresh);
  });

  it('starts at the action that left, not at the looking around before it', () => {
    const detours = findDetours(flow([scroll('/home'), tap('Reports', '/home'), back('/reports'), tap('Billing', '/home')], { endPath: '/billing' }));
    expect(detours).toEqual([{ from: 1, to: 3, at: '/home', via: '/reports', evidence: 'locations' }]);
  });

  it('names the places as an entry keeps them, a record id and every query value as :id', () => {
    const detours = findDetours(
      flow([tap('Order', '/orders/123'), back('/login/callback?code=482913&state=eyJhbGciOi.x1.y2'), tap('Ship', '/orders/123')], { endPath: '/orders/123' }),
    );
    expect(detours).toEqual([{ from: 0, to: 2, at: '/orders/:id', via: '/login/callback?code=:id&state=:id', evidence: 'locations' }]);
    // A code of letters only reads as a word to the route rule, and is still not named.
    const lettersOnly = findDetours(flow([tap('Order', '/orders/123?tab=notes'), back('/callback?code=SplxlOBeZQQYbYSWxSbIAqrTuvXyz'), tap('Ship', '/orders/123?tab=notes')]));
    expect(lettersOnly).toEqual([{ from: 0, to: 2, at: '/orders/:id?tab=:id', via: '/callback?code=:id', evidence: 'locations' }]);
  });

  it('compares a stored location by its spelling, since its record ids are gone', () => {
    // After a hand-off, an action the replay ran without looking keeps the recording's location, spelled as a route.
    const stayed = flow([tap('Details', '/orders/789'), { name: 'back', summary: 'go back', at: '/orders/:id' }, tap('Notes', '/orders/789'), type('Note', 'hi', '/orders/789')], { endPath: '/orders/789' });
    expect(findDetours({ ...stayed, stored: new Set([1]) })).toEqual([]);
    const trip = flow([tap('Invoices', '/orders/:id'), back('/invoices'), tap('Ship', '/orders/789')], { endPath: '/orders/789' });
    expect(findDetours({ ...trip, stored: new Set([0]) })).toEqual([{ from: 0, to: 2, at: '/orders/:id', via: '/invoices', evidence: 'locations' }]);
    // A kept query value reads :id too, so the live one compares by that spelling.
    const query = flow([tap('Invoices', '/orders/:id?tab=:id'), back('/invoices'), tap('Ship', '/orders/789?tab=notes')], { endPath: '/orders/789?tab=notes' });
    expect(findDetours({ ...query, stored: new Set([0]) })).toEqual([{ from: 0, to: 2, at: '/orders/:id?tab=:id', via: '/invoices', evidence: 'locations' }]);
  });

  it('compares a live address that holds a literal :id by its address', () => {
    // A view whose own value is `:id` (an unfilled route parameter, say) is no stored location.
    expect(findDetours(flow([tap('Privacy', '/?view=:id', 'link'), back('/?view=privacy')], { endPath: '/?view=%3Aid' }))).toEqual([
      { from: 0, to: 2, at: '/?view=:id', via: '/?view=:id', evidence: 'locations' },
    ]);
  });

  it('is no return to another record on the same route', () => {
    // One order's edit page, the list, then another order's: the flow moved on, it did not come back.
    expect(findDetours(flow([tap('Orders', '/orders/123/edit'), tap('Order 456', '/orders'), tap('Ship', '/orders/456/edit')], { endPath: '/orders/456/edit' }))).toEqual([]);
    // Back to the first order is a return.
    expect(findDetours(flow([tap('Orders', '/orders/123/edit'), tap('Order 456', '/orders'), back('/orders/456/edit')], { endPath: '/orders/123/edit' }))).toEqual([
      { from: 0, to: 3, at: '/orders/:id/edit', via: '/orders', evidence: 'locations' },
    ]);
  });

  it('uses the detours the recording run found, since stored placeholders no longer compare like their values', () => {
    // Recorded as /items/456 -> /items/123 -> /items/456 with 123 a unique() id: one route to the run, no detour.
    const stored = flow([tap('Next', '/items/456'), tap('Back', '/items/{{param:/id}}'), tap('Save', '/items/456')], { endPath: '/items/456' });
    expect(findDetours({ ...stored, detours: [] })).toEqual([]);
    // A slug and a record id: two routes to the run, a detour it kept.
    const kept = flow([tap('Open', '/records/{{param:/slug}}'), back('/records/123'), tap('Save', '/records/{{param:/slug}}')], { endPath: '/done' });
    expect(findDetours({ ...kept, detours: [{ from: 0, to: 2 }] })).toEqual([
      { from: 0, to: 2, at: '/records/{{param:/slug}}', via: '/records/123', evidence: 'locations' },
    ]);
  });

  it('names a trip to another record of one route alike when it records and when it replays', () => {
    const live = flow([tap('Order 456', '/orders/123', 'link'), tap('Help', '/orders/456', 'link'), tap('Order 123', '/help', 'link')], { endPath: '/orders/123' });
    const found = findDetours(live);
    expect(found).toEqual([{ from: 0, to: 3, at: '/orders/:id', via: '/orders/:id', evidence: 'locations' }]);
    expect(describeDetour(found[0]!)).toBe('actions 1-3 left /orders/:id for another /orders/:id and came back with nothing typed, chosen, or set');
    // Read back from the entry, the first stop is still the other order, not the help page after it.
    const stored = flow([tap('Order 456', '/orders/:id', 'link'), tap('Help', '/orders/:id', 'link'), tap('Order 123', '/help', 'link')], { endPath: '/orders/123' });
    expect(findDetours({ ...stored, detours: [{ from: 0, to: 3 }] })).toEqual(found);
  });

  it('reads an anchor on a file app\'s page as the same page, and another file as another', () => {
    const page = 'file:///srv/app/page.html';
    expect(findDetours(flow([tap('Details', page, 'link'), back(`${page}#details`)], { endPath: page }))).toEqual([]);
    expect(findDetours(flow([tap('About', page, 'link'), back('file:///srv/app/about.html?tab=summary')], { endPath: page }))).toEqual([
      { from: 0, to: 2, at: page, via: 'file:///srv/app/about.html?tab=:id', evidence: 'locations' },
    ]);
  });

  it('tells two documents that route the same fragment apart', () => {
    expect(findDetours(flow([tap('About', '/#/menu', 'link'), tap('Home', '/about#/menu', 'link')], { endPath: '/#/menu' }))).toEqual([
      { from: 0, to: 2, at: '/#/menu', via: '/about#/menu', evidence: 'locations' },
    ]);
    // A trailing slash on the document path is no other document, as an empty path segment is none.
    expect(findDetours(flow([tap('Menu', '/docs#/menu', 'link'), tap('Menu', '/docs/#/menu', 'link')], { endPath: '/docs#/menu' }))).toEqual([]);
  });

  it('names a stored span by the actions\' own locations, never by the start path an entry keeps raw', () => {
    // A copied entry whose first action lost its location: the start path still holds the code.
    const stored = flow([tap('About', undefined, 'link'), back('/about'), tap('Increment', '/?code=:id')], { startPath: '/?code=LoginCodeExample', endPath: '/?code=LoginCodeExample' });
    const [detour] = findDetours({ ...stored, detours: [{ from: 0, to: 2 }] });
    expect(detour).toEqual({ from: 0, to: 2, via: '/about', evidence: 'locations' });
    expect(describeDetour(detour!)).toBe('actions 1-2 left a screen for /about and came back with nothing typed, chosen, or set');
  });

  it('does not read a cut recording\'s end location as where its last kept action led', () => {
    // Actions past the cap (typing, then the way back) ran but were not kept.
    expect(findDetours(flow([tap('Edit', '/'), scroll('/edit')], { endPath: '/', truncated: true }))).toEqual([]);
    expect(findDetours(flow([tap('Edit', '/'), scroll('/edit')], { endPath: '/' }))).toHaveLength(1);
  });

  it('skips actions whose location is unknown without matching them', () => {
    const detours = findDetours(flow([tap('Help', '/settings'), scroll(), back(), tap('Privacy', '/settings')], { endPath: '/privacy' }));
    // Nothing known stood between the two visits to /settings, so nothing shows the flow left.
    expect(detours).toEqual([]);
  });
});

describe('findDetoursAfterReplay', () => {
  it('keeps the spans the entry found for the actions a replay ran, which their kept locations no longer show', () => {
    // The replay ran a trip between two views without looking, so `back` carries the stored /?view=:id; then it handed off.
    const trace = flow(
      [tap('Privacy', '/?view=account', 'link'), back('/?view=:id'), tap('Save', '/?view=account'), tap('Help', '/?view=account', 'link'), back('/help')],
      { endPath: '/?view=account' },
    );
    expect(findDetours({ ...trace, stored: new Set([1]) })).toEqual([{ from: 3, to: 5, at: '/?view=:id', via: '/help', evidence: 'locations' }]);
    expect(findDetoursAfterReplay(trace, [{ from: 0, to: 2 }], 3, new Set([1]))).toEqual([
      { from: 0, to: 2, at: '/?view=:id', via: '/?view=:id', evidence: 'locations' },
      { from: 3, to: 5, at: '/?view=:id', via: '/help', evidence: 'locations' },
    ]);
    // A second trip from the same screen, after the replayed one, is kept beside it.
    const again = flow(
      [tap('About', '/', 'link'), back('/about'), tap('About', '/', 'link'), back('/about'), tap('Increment', '/')],
      { endPath: '/' },
    );
    expect(findDetoursAfterReplay(again, [{ from: 0, to: 2 }], 2, new Set())).toEqual([
      { from: 0, to: 2, at: '/', via: '/about', evidence: 'locations' },
      { from: 2, to: 4, at: '/', via: '/about', evidence: 'locations' },
    ]);
  });

  it('finds no return among the replayed actions the entry did not find, where a kept location matches another record', () => {
    // Order 1, the list, order 2, back to the list: the replay ran `back` on order 2 without looking, so it carries /orders/:id.
    const trace = flow(
      [tap('All orders', '/orders/1', 'link'), tap('Order 2', '/orders', 'link'), back('/orders/:id'), tap('Export', '/orders')],
      { endPath: '/exports' },
    );
    expect(findDetours({ ...trace, stored: new Set([2]) })[0]).toMatchObject({ from: 0, to: 2 });
    expect(findDetoursAfterReplay(trace, [{ from: 1, to: 3 }], 3, new Set([2]))).toEqual([{ from: 1, to: 3, at: '/orders', via: '/orders/:id', evidence: 'locations' }]);
  });

  it('finds the agent\'s own trip after a hand-off without crossing a span the entry found', () => {
    // The replay ran /p, the list, an order (`back` without looking), the list; the agent went /z, /p, /w and ended on the list.
    const trace = flow(
      [tap('List', '/p', 'link'), tap('Order', '/list', 'link'), back('/orders/:id'), tap('Z', '/list', 'link'), tap('P', '/z', 'link'), tap('W', '/p', 'link')],
      { endPath: '/list' },
    );
    expect(findDetoursAfterReplay(trace, [{ from: 1, to: 3 }], 3, new Set([2]))).toEqual([
      { from: 1, to: 3, at: '/list', via: '/orders/:id', evidence: 'locations' },
      { from: 3, to: 6, at: '/list', via: '/z', evidence: 'locations' },
    ]);
  });

  it('names a replayed span in the entry\'s spelling, the unique() value it filled in included', () => {
    const replayed = flow([tap('Record', '/records', 'link'), back('/records/80362915?code=FreshCallbackWord')], { endPath: '/records' });
    expect(findDetours({ ...replayed, detours: [{ from: 0, to: 2 }] }, routeLocation)).toEqual([
      { from: 0, to: 2, at: '/records', via: '/records/:id?code=:id', evidence: 'locations' },
    ]);
  });

  it('finds no return to a copied location that reads :id, which could be another view', () => {
    // The replay left the account view by `back`-free taps it ran without looking, so their places are the entry's `/?view=:id`; it stopped on another view.
    const trace = flow(
      [tap('Panel', '/?view=account', 'link'), tap('Help', '/?view=:id', 'link'), back('/help'), tap('Billing', '/?view=unrelated')],
      { endPath: '/?view=unrelated' },
    );
    expect(findDetoursAfterReplay(trace, [], 3, new Set([1, 2]))).toEqual([]);
  });

  it('compares a return with the place the trip left from too, so a copied :id home links no two records', () => {
    // A free scroll the replay ran on the end route carries the entry's `/?view=:id`; the agent never came back to account.
    const views = flow(
      [tap('Panel', '/?view=account', 'link'), scroll('/?view=:id'), tap('Help', '/?view=account', 'link'), back('/help'), tap('Billing', '/?view=unrelated')],
      { endPath: '/?view=unrelated' },
    );
    expect(findDetoursAfterReplay(views, [], 2, new Set([1]))).toEqual([]);
    // Two copied orders, then the agent's order 456, the cart, and order 789: no return.
    const orders = flow([scroll('/orders/:id'), scroll('/orders/:id'), tap('Cart', '/orders/456', 'link'), tap('Order 789', '/cart', 'link')], { endPath: '/orders/789' });
    expect(findDetoursAfterReplay(orders, [], 2, new Set([0, 1]))).toEqual([]);
  });

  it('still finds the agent\'s trip inside one it does not count', () => {
    // From a copied `/?view=:id`: About, Storage, back to About, then another view, which spells like the copied one.
    const trace = flow(
      [tap('About', '/?view=:id', 'link'), tap('Storage', '/about', 'link'), back('/storage'), tap('View', '/about', 'link')],
      { endPath: '/?view=second' },
    );
    expect(findDetoursAfterReplay(trace, [], 1, new Set([0]))).toEqual([{ from: 1, to: 3, at: '/about', via: '/storage', evidence: 'locations' }]);
  });

  it('adds no span that crosses one the entry found, which would claim a return that never happened', () => {
    // The replay ran order 1, the list, order 2 (`back` without looking), the list; the agent then opened order 2 again and ended there.
    const trace = flow(
      [tap('All orders', '/orders/1', 'link'), tap('Order 2', '/orders', 'link'), back('/orders/:id'), tap('Order 2', '/orders', 'link')],
      { endPath: '/orders/2' },
    );
    expect(findDetoursAfterReplay(trace, [{ from: 1, to: 3 }], 3, new Set([2]))).toEqual([{ from: 1, to: 3, at: '/orders', via: '/orders/:id', evidence: 'locations' }]);
  });
});

describe('findReplayedDetours', () => {
  it('reads each span a hand-off cut on its own, so a match outside it takes none of its trips', () => {
    // Order 1, Settings, Reports, Details, back to Reports, order 2, then Settings again; the replay stopped at the last action.
    const stored = flow(
      [tap('Settings', '/orders/:id', 'link'), tap('Reports', '/settings', 'link'), tap('Details', '/reports', 'link'), back('/details'), tap('Order 2', '/reports', 'link'), tap('Settings', '/orders/:id', 'link')],
      { endPath: '/settings' },
    );
    expect(findReplayedDetours({ ...stored, detours: [{ from: 1, to: 6 }] }, 5)).toEqual([{ from: 2, to: 4, at: '/reports', via: '/details', evidence: 'locations' }]);
  });

  it('counts a return where the replay stopped only when the screen it saw there is the recorded one, and only where the recording can tell', () => {
    const views = flow([tap('Privacy', '/?view=:id', 'link'), back('/?view=:id'), tap('Increment', '/?view=:id')], { endPath: '/?view=:id' });
    const kept = [{ from: 0, to: 2, at: '/?view=:id', via: '/?view=:id', evidence: 'locations' as const }];
    // Not seen: the stored span stands.
    expect(findReplayedDetours({ ...views, detours: [{ from: 0, to: 2 }] }, 2)).toEqual(kept);
    // Seen: compared with the address the replay saw where the trip left.
    expect(findReplayedDetours({ ...views, detours: [{ from: 0, to: 2 }] }, 2, { stop: '/?view=account', places: ['/?view=account'] })).toEqual(kept);
    expect(findReplayedDetours({ ...views, detours: [{ from: 0, to: 2 }] }, 2, { stop: '/?view=unrelated', places: ['/?view=account'] })).toEqual([]);
    // With no address seen there, `/?view=:id` cannot tell the recorded view from the one the replay landed on; a literal route can.
    expect(findReplayedDetours({ ...views, detours: [{ from: 0, to: 2 }] }, 2, { stop: '/?view=account', places: [] })).toEqual([]);
    const pages = flow([tap('About', '/', 'link'), back('/about'), tap('Increment', '/')], { endPath: '/' });
    expect(findReplayedDetours({ ...pages, detours: [{ from: 0, to: 2 }] }, 2, { stop: '/', places: [] })).toHaveLength(1);
    expect(findReplayedDetours({ ...pages, detours: [{ from: 0, to: 2 }] }, 2, { stop: '/diverted', places: [] })).toEqual([]);
  });

  it('reads a span again inside when the replay saw that its return at the stop did not happen', () => {
    // Home, About, Echo, back to About, then Home: the way Home now leads to Storage, where the replay stopped.
    const stored = flow(
      [tap('About', '/', 'link'), navigate('/echo', '/about'), back('/echo'), tap('Home', '/about', 'link'), tap('Increment', '/')],
      { endPath: '/' },
    );
    expect(findReplayedDetours({ ...stored, detours: [{ from: 0, to: 4 }] }, 4, { stop: '/storage', places: ['/', '/about', '/echo', '/about'] })).toEqual([
      { from: 1, to: 3, at: '/about', via: '/echo', evidence: 'locations' },
    ]);
  });

  it('counts no return at an end the replay saw stay off the recorded route', () => {
    const trip = flow([tap('About', '/settings?tab=:id', 'link'), back('/about')], { endPath: '/settings?tab=privacy' });
    expect(findReplayedDetours({ ...trip, detours: [{ from: 0, to: 2 }] }, 2)).toHaveLength(1);
    expect(findReplayedDetours({ ...trip, detours: [{ from: 0, to: 2 }] }, 2, { stop: '/settings?tab=billing', places: ['/settings?tab=privacy'] })).toEqual([]);
    // An end on the recorded route whose delta did not match: compared with where the trip left, query value included.
    const storage = flow([tap('Save', '/storage?view=:id'), tap('About', '/storage?view=:id', 'link'), back('/about')], { endPath: '/storage?view=123' });
    const places = ['/storage?view=123', '/storage?view=123', '/about'];
    expect(findReplayedDetours({ ...storage, detours: [{ from: 1, to: 3 }] }, 3, { stop: '/storage?view=456', places })).toEqual([]);
    expect(findReplayedDetours({ ...storage, detours: [{ from: 1, to: 3 }] }, 3, { stop: '/storage?view=123', places })).toHaveLength(1);
  });
});

describe('findDetours on an entry recorded without locations', () => {
  it('reads a tap, looking around, then back as a detour', () => {
    const detours = findDetours(flow([tap('Notifications'), scroll(), scroll(), back(), tap('Privacy')]));
    expect(detours).toEqual([{ from: 0, to: 4, evidence: 'actions' }]);
    expect(describeDetour(detours[0]!)).toBe('actions 1-4 left a screen, only looked around, and went back (recorded without locations: a hint only)');
  });

  it('reads a point tap on a link as leaving, and one on a switch as setting it', () => {
    const pointOn = (role: string, name: string): RecordedAction => ({
      name: 'tapAt',
      summary: `tap the point (10, 10) on ${role} "${name}"`,
      point: { x: 10, y: 10 },
      viewport: { width: 1280, height: 720 },
      within: { target: { role, name }, fx: 0.5, fy: 0.5 },
    });
    expect(findDetours(flow([pointOn('link', 'Reports'), scroll(), back()]))).toEqual([{ from: 0, to: 3, evidence: 'actions' }]);
    expect(findDetours(flow([pointOn('switch', 'Dark mode'), back()]))).toEqual([]);
  });

  it('is no detour when the step typed before going back, or never went back', () => {
    expect(findDetours(flow([tap('Edit'), type('Name', 'Ada'), back()]))).toEqual([]);
    expect(findDetours(flow([tap('Next'), scroll(), tap('Done')]))).toEqual([]);
  });

  it('reads locations once any action has one, never mixing in the action shape', () => {
    expect(findDetours(flow([tap('Help', '/settings'), back()], { endPath: '/help' }))).toEqual([]);
  });
});

describe('settledDetour', () => {
  const ledger = () => {
    const known = new SecretLedger();
    known.register('token', 'tok-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
    return known;
  };

  it('masks a secret the report bound cut through, ending at the ellipsis', () => {
    const text = bound(`actions 1-2 left / for /${'a'.repeat(560)}?t=tok-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 and came back with nothing typed, chosen, or set`, 600);
    expect(text).toContain('tok-ABCDEFGH…');
    const settled = settledDetour(text, ledger());
    expect(settled).not.toContain('tok-ABC');
    expect(settled.length).toBeLessThanOrEqual(600);
  });

  it('cuts between words, so a secret a later step resolves is never left in part in a percent-encoded location', () => {
    const invite = new SecretLedger();
    invite.register('invite', 'Zebra/cornflakes');
    const text = `actions 1-2 left / for /records/${'a'.repeat(550)}/Zebra%2Fcornflakes and came back with nothing typed, chosen, or set`;
    // A cut through the location leaves a part the ledger cannot read in that spelling.
    expect(settledDetour(bound(text, 600), invite)).toContain('Zebra%2Fcornf');
    const cut = boundDetour(text);
    expect(cut).toBe('actions 1-2 left / for…');
    expect(settledDetour(cut, invite)).toBe('actions 1-2 left / for…');
    expect(boundDetour('actions 1-2 left / for /x and came back')).toBe('actions 1-2 left / for /x and came back');
  });

  it('masks a whole secret and keeps the text within the report bound', () => {
    const settled = settledDetour(`actions 1-2 left / for /x?t=tok-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 and came back with nothing typed, chosen, or set`, ledger());
    expect(settled).toBe('actions 1-2 left / for /x?t=<secret:token> and came back with nothing typed, chosen, or set');
    const long = settledDetour(`${'x'.repeat(590)}tok-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789`.slice(0, 600), { redact: (text) => text.replaceAll('x', 'xx'), redactCut: (text) => text });
    expect(long.length).toBe(600);
  });
});
