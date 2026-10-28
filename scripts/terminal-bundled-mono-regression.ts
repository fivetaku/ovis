/**
 * The terminal draws in the bundled JetBrains Mono on every device, and sizes its grid from it even
 * when the face arrives after the terminal opened. xterm measures its cell, and
 * lib/terminalLineHeight.ts its row, when the family is set: a terminal opened with the face still
 * loading would keep a fallback's cell and row and draw the face in them. So it opens without the
 * face (lib/fontFamily.ts, openingFontStack) and the font effect sets it once it has loaded, which
 * xterm measures and the grid fits anew. The face's download is held here until the terminal shows
 * its rows, so it always arrives late.
 */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Route } from "playwright-core";
import { createServer } from "../server/index.ts";
import { UsageService } from "../server/usage.ts";
import { herdrRpc, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { terminalLineHeight } from "../src/lib/terminalLineHeight.ts";
import { chromePath } from "./chrome-path.ts";

const ROWS = ["|abcdefghijklmn|", "|가나다라마바사|"];
const FACE = /\/JetBrainsMono-Regular[^/]*\.woff2$/;

const state = mkdtempSync(join(tmpdir(), "terminal-bundled-mono-"));
const evidence = process.env["CHECK_BROWSER_EVIDENCE_DIR"] || state;
mkdirSync(evidence, { recursive: true });
const workspaces: string[] = [];
let server: ReturnType<typeof createServer> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

try {
  // Given: a pane that prints a Latin and a Korean row, each closed by a bar.
  const program = join(state, "rows.mjs");
  writeFileSync(program, `process.stdout.write(${JSON.stringify(`\x1b[2J\x1b[H${ROWS.join("\r\n")}\r\nROWS_READY\r\n`)});
setInterval(() => {}, 1 << 30);
`);
  const made = await workspaceCreate({ cwd: state, label: "ovis-test-bundled-mono" });
  workspaces.push(made.workspace.workspace_id);
  const pane = made.root_pane.pane_id;
  const ready = herdrRpc("pane.wait_for_output", {
    pane_id: pane, source: "visible", match: { type: "substring", value: "ROWS_READY" }, timeout_ms: 10000,
  }, undefined, 12000);
  await herdrRpc("pane.send_input", { pane_id: pane, text: `exec ${quote(process.execPath)} ${quote(program)}`, keys: ["enter"] });
  await ready;

  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(state, "server"),
    tailscaleOwner: null, usage: new UsageService(undefined, []) });
  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  for (const deviceScaleFactor of [1, 2]) {
    // a service worker's fetches pass by the page's routes
    const context = await browser.newContext({ viewport: { width: 1200, height: 760 }, deviceScaleFactor, serviceWorkers: "block" });
    // no font chosen in Settings: the built-in stack
    await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", defaultView: "terminal", alertsOn: false })));
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const held: Route[] = [];
    let release = false;
    await page.route(FACE, (route) => release ? route.continue() : void held.push(route));

    await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(pane)}`);
    await page.locator(".conn-live").waitFor();
    await page.locator(".pane-terminal .xterm-rows", { hasText: "|가나다라마바사|" }).waitFor();
    // When: the terminal has drawn its rows before the face arrived
    const opened = await page.evaluate(() => getComputedStyle(document.querySelector(".pane-terminal .xterm-rows")!).fontFamily);
    assert.ok(!opened.includes("JetBrains Mono Web"), `the terminal opens without the face it has not loaded: ${opened}`);
    release = true;
    for (const route of held.splice(0)) await route.continue();
    await page.waitForFunction(() => getComputedStyle(document.querySelector(".pane-terminal .xterm-rows")!).fontFamily.includes("JetBrains Mono Web"));
    // the rows drawn again in the face, once the grid fitted
    await page.evaluate(() => document.fonts.ready.then(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))));

    // Then: the grid is measured from the face, its rows are the face's, and it fits its host
    const drawn = await page.evaluate(() => {
      const rows = document.querySelector<HTMLElement>(".pane-terminal .xterm-rows")!;
      const screen = document.querySelector<HTMLElement>(".pane-terminal .xterm-screen")!;
      const size = Number.parseFloat(getComputedStyle(rows).fontSize);
      const canvas = document.createElement("canvas").getContext("2d")!;
      canvas.font = `${size}px "JetBrains Mono Web"`;
      const metrics = canvas.measureText("W");
      // each row's bars, left to right, where the browser put them
      const bars = [...rows.children].slice(0, 2).map((row) => {
        const found: number[] = [];
        const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          for (let at = node.textContent!.indexOf("|"); at >= 0; at = node.textContent!.indexOf("|", at + 1)) {
            const range = document.createRange();
            range.setStart(node, at);
            range.setEnd(node, at + 1);
            found.push(range.getBoundingClientRect().left);
          }
        }
        return found;
      });
      return {
        size,
        width: Number.parseFloat(screen.style.width),
        rowHeight: Number.parseFloat((rows.children[0] as HTMLElement).style.height),
        hostWidth: screen.closest(".xterm")!.parentElement!.clientWidth,
        glyph: metrics.width,
        charHeight: metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent,
        bars,
        loaded: document.fonts.check(`${size}px "JetBrains Mono Web"`, "M"),
        dpr: devicePixelRatio,
      };
    });
    const [latin, korean] = drawn.bars;
    // |abcdefghijklmn|: the closing bar stands 15 cells after the opening one
    const cell = (latin!.at(-1)! - latin![0]!) / (ROWS[0]!.length - 1);
    const line = Math.ceil(drawn.charHeight * drawn.dpr);
    const row = Math.floor(line * terminalLineHeight(drawn.charHeight, drawn.size, drawn.dpr)) / drawn.dpr;
    const hangulGap = drawn.rowHeight - 0.913 * drawn.size;
    console.log(JSON.stringify({ deviceScaleFactor, cell, row, hangulGap: +hangulGap.toFixed(2), ...drawn }));
    await page.screenshot({ path: join(evidence, `terminal-bundled-mono-${deviceScaleFactor}x.png`) });
    assert.ok(drawn.loaded, "the face loaded");
    assert.ok(Math.abs(cell - drawn.glyph) < 0.05, `a cell is the face's advance: ${cell} against ${drawn.glyph}`);
    assert.ok(Math.abs(drawn.rowHeight - row) < 0.01, `a row is the face's: ${drawn.rowHeight}px against ${row}px`);
    assert.ok(hangulGap >= 4, `Korean rows keep their gap: ${hangulGap}px`);
    assert.ok(drawn.width <= drawn.hostWidth + 0.5 && drawn.hostWidth - drawn.width < cell + 16, `the grid fits its host again: ${drawn.width}px of ${drawn.hostWidth}px`);
    assert.ok(Math.abs(latin!.at(-1)! - korean!.at(-1)!) < 0.5, `the Korean row closes on the Latin row's column: ${latin!.at(-1)} / ${korean!.at(-1)}`);
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log("PASS the terminal sizes its grid from the bundled JetBrains Mono, though the face arrived after it opened");
} finally {
  await browser?.close();
  server?.stop();
  for (const workspace of workspaces) await workspaceClose(workspace);
  rmSync(state, { recursive: true, force: true });
}
