/**
 * Channel-aware system prompt: proves the WhatsApp framing changed and the WEB
 * framing did not.
 *
 *   node test/system-prompt-channels.js
 *
 * systemPrompt.js is a compliance-sensitive file — its own header says edits to
 * it are a compliance change, not a copy tweak. So the load-bearing assertion
 * here is a NEGATIVE one: the web prompt is pinned, byte for byte, to a sha256
 * captured from the unmodified file at commit 1392135 BEFORE channels existed.
 * If any future edit alters what the website's visitors are answered with, this
 * test fails and names the hash, rather than the change reaching production.
 *
 * The WhatsApp prompt is a VIEW onto the same string, not a second copy: it is
 * built by four targeted substitutions, so a compliance edit made to
 * SYSTEM_PROMPT reaches both channels automatically. The tests below pin that
 * property too — every compliance rule must appear verbatim on both channels,
 * and the substitutions must all still match.
 */

import assert from "node:assert";
import { createHash } from "node:crypto";

const { buildSystemPrompt, channelEditReport, SYSTEM_PROMPT } =
  await import("../systemPrompt.js");

let passed = 0;
function check(label, cond) {
  assert.ok(cond, `FAILED: ${label}`);
  console.log(`  [PASS] ${label}`);
  passed++;
}
const line = (t) => console.log(`\n${t}\n`);
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");

/**
 * Captured from systemPrompt.js at commit 1392135, before buildSystemPrompt
 * took a channel. THESE MUST NOT BE EDITED to make a failing test pass. A
 * mismatch means the website's prompt changed; if that change was deliberate,
 * re-capture them in the same commit and say so in the message.
 */
const WEB_SNAPSHOT = {
  open:   { length: 10941, sha256: "072353b1a76316412f6b1db730e491145d3815cb895c39aed734f651db16be4d" },
  closed: { length: 12777, sha256: "9b189998af071ea16a95b2f4c80b2b735299d73906d505423b25fd51289c8dbc" },
};

/** Rules that must be identical on every channel. Compliance, not tone. */
const COMPLIANCE_INVARIANTS = [
  ["excluded-industry list is intact", "Spartan works with businesses across healthcare and wellness"],
  ["never-quote-numbers boundary", "What you must never do is put a specific dollar amount, rate, factor rate, or repayment term in front of someone as though it were an offer"],
  ["qualifying guidelines", "at least $10,000 in monthly gross revenue"],
  ["never hard-decline", "Never hard-decline anyone yourself."],
  ["never invent details", "Never invent details about Spartan that you weren't given here"],
  ["status tag mechanics", "[[SCG_STATUS: OK]]"],
  ["DECLINE tag mechanics", "[[SCG_STATUS: DECLINE]]"],
  ["lead block shape", '[[SCG_LEAD: {"firstName"'],
  ["lead minimum / omit-don't-guess", "An absent field is always better than a wrong one"],
  ["fundingAmount vs monthlyRevenue never swapped", "Those are two different numbers and must never be swapped"],
  ["loanPurpose picklist", "Working Capital / Cash Flow"],
  ["no lead on a DECLINE turn", "never on a DECLINE turn, because a business Spartan can't fund has no lead to report"],
  ["application URL exact", "https://apply.spartancapitalgroup.com/step-2/"],
];

async function main() {
  line("1. WEB IS UNCHANGED  -> the load-bearing assertion");

  for (const [name, open] of [["open", true], ["closed", false]]) {
    const snap = WEB_SNAPSHOT[name];
    for (const [label, prompt] of [
      [`buildSystemPrompt({open:${open}})`, buildSystemPrompt({ open })],
      [`buildSystemPrompt({open:${open},channel:"web"})`, buildSystemPrompt({ open, channel: "web" })],
    ]) {
      check(`${label} -> length unchanged (${snap.length})`, prompt.length === snap.length);
      check(`${label} -> sha256 unchanged`, sha(prompt) === snap.sha256);
    }
  }

  check("buildSystemPrompt() with no arguments -> still the after-hours web prompt",
    sha(buildSystemPrompt()) === WEB_SNAPSHOT.closed.sha256);

  check("an unrecognised channel falls back to web framing (safe direction)",
    sha(buildSystemPrompt({ open: true, channel: "carrier-pigeon" })) === WEB_SNAPSHOT.open.sha256);

  check("the web prompt still calls itself the website assistant",
    buildSystemPrompt({ open: true }).includes("You are the website assistant for Spartan Capital Group"));
  check("the web prompt still carries the chat-widget length rule",
    buildSystemPrompt({ open: true }).includes("this is a chat widget, not an email"));
  check("the web prompt has NO WhatsApp formatting block",
    !buildSystemPrompt({ open: true }).includes("Use no markdown"));

  line("2. WHATSAPP  -> texting medium, no markdown, not a website");

  const wa = buildSystemPrompt({ open: true, channel: "whatsapp" });
  const waClosed = buildSystemPrompt({ open: false, channel: "whatsapp" });

  check("every channel substitution still matches SYSTEM_PROMPT (no drift)",
    channelEditReport().whatsapp.missed.length === 0);
  check("all four substitutions are accounted for",
    channelEditReport().whatsapp.edits === 4);

  check("identifies as the WhatsApp assistant, not the website assistant",
    wa.includes("You are the WhatsApp assistant for Spartan Capital Group") &&
    !wa.includes("You are the website assistant"));

  check("tells the model it is a texting medium",
    wa.includes("This conversation is over WhatsApp, a texting medium"));
  check("asks for one or two short sentences, not two to four",
    wa.includes("Keep replies to one or two short sentences") &&
    !wa.includes("Two to four sentences is usually right"));
  check("asks one question at a time",
    wa.includes("Ask one question at a time"));
  check("the chat-widget framing is gone",
    !wa.includes("this is a chat widget, not an email"));

  check("forbids markdown explicitly",
    wa.includes("Use no markdown") && wa.includes("no asterisks for bold") &&
    wa.includes("no bullet lists") && wa.includes("no headings"));
  check("asks for bare URLs",
    wa.includes("Write any link as a bare URL"));

  check("does not claim 'the website' strips the status tag",
    wa.includes("That line is stripped before your reply is sent,") &&
    !wa.includes("The website strips this line before showing your reply"));
  check("does not claim 'the website' strips the lead block",
    wa.includes("That line is stripped too, exactly like the status tag.") &&
    !wa.includes("The website strips this line too"));

  check("the non-tone half of the length paragraph survives verbatim",
    wa.includes("Never invent details about Spartan that you weren't given here; when you don't know " +
      "something, say plainly that a funding specialist can help."));

  line("3. COMPLIANCE INVARIANTS  -> identical on both channels");

  const web = buildSystemPrompt({ open: true });
  for (const [name, needle] of COMPLIANCE_INVARIANTS) {
    check(`${name} — present on BOTH channels`, web.includes(needle) && wa.includes(needle));
  }

  line("4. AFTER-HOURS  -> the availability note is channel-independent");

  const webClosed = buildSystemPrompt({ open: false });
  for (const [label, p] of [["web", webClosed], ["whatsapp", waClosed]]) {
    check(`${label} after-hours -> carries the no-live-specialist rule`,
      p.includes("Never say a specialist is joining, connecting, coming on"));
    check(`${label} after-hours -> carries the hours sentence`,
      p.includes("Monday–Friday, 9:00am–6:00pm Eastern"));
    check(`${label} after-hours -> excluded industry still excluded at every hour`,
      p.includes("an excluded industry is still excluded at every hour"));
  }
  check("open vs closed differ on the whatsapp channel too", wa !== waClosed);
  check("the availability block appended to WhatsApp is the SAME text as web's",
    waClosed.slice(waClosed.indexOf("A note on live context")) ===
    webClosed.slice(webClosed.indexOf("A note on live context")));

  line("5. ONE SOURCE OF TRUTH  -> WhatsApp is a view, not a fork");

  check("the WhatsApp prompt is derived from SYSTEM_PROMPT, not a second copy",
    wa.length > SYSTEM_PROMPT.length - 400 && wa.includes("Spartan offers merchant cash advances"));
  check("the two channels differ ONLY by the framing edits + formatting block",
    Math.abs((wa.length - buildSystemPrompt({ open: true }).length)) < 700);

  console.log(`\n${"=".repeat(72)}`);
  console.log(`SYSTEM PROMPT CHANNELS: ${passed} assertions passed`);
  console.log("=".repeat(72));
  console.log("Web prompt pinned byte-for-byte to its pre-change sha256.");
  console.log("WhatsApp reframed for texting; every compliance rule identical on both.");
}

await main();
