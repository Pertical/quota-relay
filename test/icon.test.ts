import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { findSvgIconProblem, PLUGIN_SVG_ICON_MAX_BYTES } from "@getpaseo/plugin";
import { RELAY_ICON } from "../client/icon";

test("the inline icon is the asset, minus whitespace between tags", () => {
  const asset = readFileSync(new URL("../assets/icon.svg", import.meta.url), "utf8");
  assert.equal(RELAY_ICON.svg, asset.replace(/>\s+</g, "><").trim());
});

test("Paseo accepts the inline icon", () => {
  assert.equal(findSvgIconProblem(RELAY_ICON.svg), null);
  assert.ok(Buffer.byteLength(RELAY_ICON.svg) <= PLUGIN_SVG_ICON_MAX_BYTES);
});
