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
  // the face arrives once the terminal drew its rows (1x and 2x); once it is slower than the font effect's wait for it; and once
  // a font typed in Settings fails to load while the face still loads, which ends the font set's wait for the whole stack
  for (const [deviceScaleFactor, slow, typedFails] of [[1, false, false], [2, false, false], [1, true, false], [1, true, true]] as const) {
    // a service worker's fetches pass by the page's routes
    const context = await browser.newContext({ viewport: { width: 1200, height: 760 }, deviceScaleFactor, serviceWorkers: "block" });
    // no font chosen in Settings: the built-in stack
    await context.addInitScript((typed) => {
      localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", defaultView: "terminal", alertsOn: false, ...(typed ? { terminalFontFamily: "Pretendard Variable" } : {}) }));
      // the texts the page asks the font set to load for: the font effect's own wait asks for "Mg가",
      // and the wait for a face slower than that (monoFaceArrived) for "M"
      const asked: string[] = [];
      const load = FontFaceSet.prototype.load;
      FontFaceSet.prototype.load = function (this: FontFaceSet, font: string, text?: string) { asked.push(text ?? ""); return load.call(this, font, text); };
      Object.assign(window, { fontLoadsAsked: asked });
    }, typedFails);
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const held: Route[] = [];
    let release = false;
    await page.route(FACE, (route) => release ? route.continue() : void held.push(route));
    if (typedFails) await page.route(/pretendard/i, (route) => route.fulfill({ status: 404, body: "" }));

    await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(pane)}`);
    await page.locator(".conn-live").waitFor();
    await page.locator(".pane-terminal .xterm-rows", { hasText: "|가나다라마바사|" }).waitFor();
    // When: the terminal has drawn its rows before the face arrived
    const opened = await page.evaluate(() => getComputedStyle(document.querySelector(".pane-terminal .xterm-rows")!).fontFamily);
    assert.ok(!opened.includes("JetBrains Mono Web"), `the terminal opens without the face it has not loaded: ${opened}`);
    // a slow face is let go only once the font effect gave up waiting for it and waits for its arrival instead
    if (slow) await page.waitForFunction(() => (window as unknown as { fontLoadsAsked: string[] }).fontLoadsAsked.includes("M"));
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
    // Ovis Hangul Mono's ink, 0.913em (lib/terminalLineHeight.ts, HANGUL_INK_EM)
    const hangulGap = drawn.rowHeight - 0.913 * drawn.size;
    console.log(JSON.stringify({ deviceScaleFactor, slow, typedFails, cell, row, hangulGap: +hangulGap.toFixed(2), ...drawn }));
    await page.screenshot({ path: join(evidence, `terminal-bundled-mono-${deviceScaleFactor}x${slow ? "-slow" : ""}${typedFails ? "-typed-fails" : ""}.png`) });
    assert.ok(drawn.loaded, "the face loaded");
    assert.ok(Math.abs(cell - drawn.glyph) < 0.05, `a cell is the face's advance: ${cell} against ${drawn.glyph}`);
    assert.ok(Math.abs(drawn.rowHeight - row) < 0.01, `a row is the face's: ${drawn.rowHeight}px against ${row}px`);
    assert.ok(hangulGap >= 4, `Korean rows keep their gap: ${hangulGap}px`);
    assert.ok(drawn.width <= drawn.hostWidth + 0.5 && drawn.hostWidth - drawn.width < cell + 16, `the grid fits its host again: ${drawn.width}px of ${drawn.hostWidth}px`);
    assert.ok(Math.abs(latin!.at(-1)! - korean!.at(-1)!) < 0.5, `the Korean row closes on the Latin row's column: ${latin!.at(-1)} / ${korean!.at(-1)}`);
    assert.deepEqual(errors, []);
    await context.close();
  }

  // the face arrives while two fingers pinch, first spread wider and then back at the saved size: the pinch keeps
  // its live size, and the shared pty is sized once, when the fingers lift, for the grid the face gave
  for (const grow of [true, false]) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: "block" });
    await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", defaultView: "terminal", alertsOn: false })));
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const held: Route[] = [];
    let release = false;
    await page.route(FACE, (route) => release ? route.continue() : void held.push(route));
    let ready = false;
    const resizes: { cols: number; rows: number }[] = [];
    page.on("websocket", (socket) => {
      socket.on("framereceived", ({ payload }) => {
        const message = JSON.parse(String(payload));
        if (message.type === "input-ready" && message.pane_id === pane) ready = message.ready !== false;
      });
      socket.on("framesent", ({ payload }) => {
        const message = JSON.parse(String(payload));
        if (message.type === "resize") resizes.push({ cols: message.cols, rows: message.rows });
      });
    });
    await page.goto(`http://127.0.0.1:${server!.port}/?pane=${encodeURIComponent(pane)}`);
    await page.locator(".pane-terminal .xterm-rows", { hasText: "|가나다라마바사|" }).waitFor();
    await page.waitForFunction(() => document.querySelector(".pane-terminal .xterm-rows") !== null);
    for (let i = 0; i < 200 && !ready; i += 1) await page.evaluate(() => new Promise(requestAnimationFrame));
    assert.ok(ready, "the phone owns the pane's input");
    const box = (await page.locator(".pane-terminal").boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const cdp = await context.newCDPSession(page);
    const pair = (distance: number) => [{ x: cx - distance / 2, y: cy, id: 1 }, { x: cx + distance / 2, y: cy, id: 2 }];
    const fontPx = () => page.evaluate(() => Number.parseFloat(getComputedStyle(document.querySelector(".pane-terminal .xterm-rows")!).fontSize));
    const startPx = await fontPx();
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pair(100) });
    const steps = grow ? [130, 160, 190, 220] : [130, 160, 130, 100];
    for (const distance of steps) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: pair(distance) });
    const pinchedPx = await fontPx();
    if (grow) assert.ok(pinchedPx > startPx, `the pinch grew the font: ${startPx} → ${pinchedPx}`);
    else assert.equal(pinchedPx, startPx, "the pinch came back to the saved size");
    const before = resizes.length;
    // When: the face arrives mid-pinch, inside the font effect's own wait
    release = true;
    for (const route of held.splice(0)) await route.continue();
    await page.waitForFunction(() => getComputedStyle(document.querySelector(".pane-terminal .xterm-rows")!).fontFamily.includes("JetBrains Mono Web"));
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    // Then: the pinch keeps its live size and sizes no pty while the fingers are down
    assert.equal(await fontPx(), pinchedPx, `the arriving face keeps the pinch's live size (grow=${grow})`);
    assert.equal(resizes.length, before, `no resize while the fingers are down (grow=${grow}): ${JSON.stringify(resizes.slice(before))}`);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    for (let i = 0; i < 200 && resizes.length === before; i += 1) await page.evaluate(() => new Promise(requestAnimationFrame));
    const grid = await page.evaluate(() => {
      const rows = document.querySelector(".pane-terminal .xterm-rows")!;
      return { rows: rows.children.length };
    });
    assert.equal(resizes.length - before, 1, `one resize when the fingers lift (grow=${grow}): ${JSON.stringify(resizes.slice(before))}`);
    assert.equal(resizes.at(-1)!.rows, grid.rows, "the resize is the grid the face gave");
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ grow, startPx, pinchedPx, resizesAfterRelease: resizes.slice(before) }));
    await context.close();
  }
  console.log("PASS the terminal sizes its grid from the bundled JetBrains Mono, though the face arrived after it opened, and after the font effect's wait, and mid-pinch");
} finally {
  await browser?.close();
  server?.stop();
  for (const workspace of workspaces) await workspaceClose(workspace);
  rmSync(state, { recursive: true, force: true });
}
