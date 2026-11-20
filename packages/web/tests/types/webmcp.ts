/** Compile-time assertions for `browser.webmcp` and the `webmcp` option. */
import type { Browser, WebMcpTool, WebOptions } from '../../src/index.ts';
import type { JsonValue } from '@e2e-dev/core';

declare const browser: Browser;
void (browser.webmcp.tools() satisfies Promise<readonly WebMcpTool[]>);
void (browser.webmcp.callTool('add', { a: 2, b: 40 }) satisfies Promise<JsonValue>);
void (browser.webmcp.callTool('refresh') satisfies Promise<JsonValue>);
// @ts-expect-error a tool name is a string
void browser.webmcp.callTool(42);
// @ts-expect-error input is JSON, so it holds no function
void browser.webmcp.callTool('add', { a: () => 2 });

void ({ webmcp: true } satisfies WebOptions);
// @ts-expect-error webmcp is a boolean
void ({ webmcp: 'on' } satisfies WebOptions);
