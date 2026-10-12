import { defineCase, hasObject, lintClean } from "../lib.ts";

export default defineCase({
  name: "pin-request",
  description: "\"Every session must know X\" becomes a pinned object.",
  fixture: "acme",
  steps: ["Make sure every future session always knows this without looking it up: production deploys are frozen from Dec 20 to Jan 5."],
  checks: [
    hasObject({ pinned: true, text: [/dec(ember)? ?20/i, /jan(uary)? ?5/i] }, "pinned object with the freeze dates"),
    lintClean(),
  ],
});
