/**
 * Tests for the handoff heuristics. Run with `npm test`.
 * Not bundled into the deployment zip (see the `build` script).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  detectHandoff,
  extractHandoffFields,
  isDeclineReply,
  shouldHandoff,
} from "./intent.js";

const user = (content) => ({ role: "user", content });
const bot = (content) => ({ role: "assistant", content });

const OFFER =
  "I can't quote amounts myself. Would you like me to have a funding specialist reach out to go over your options?";

test("explicit request for a human hands off", () => {
  assert.equal(detectHandoff([user("Can I talk to a real person?")]), true);
  assert.equal(
    detectHandoff([user("I'd like to speak with a funding specialist")]),
    true,
  );
  assert.equal(detectHandoff([user("just have someone call me")]), true);
  assert.equal(detectHandoff([user("How do I apply?")]), true);
});

test("general questions do not hand off", () => {
  assert.equal(detectHandoff([user("What kinds of loans do you offer?")]), false);
  assert.equal(
    detectHandoff([user("Do you work with restaurants in Ohio?")]),
    false,
  );
});

test("accepting an offer hands off", () => {
  assert.equal(detectHandoff([user("hi"), bot(OFFER), user("yes please")]), true);
  assert.equal(detectHandoff([user("hi"), bot(OFFER), user("Sure")]), true);
  assert.equal(
    detectHandoff([user("hi"), bot(OFFER), user("ok that works for me")]),
    true,
  );
});

test("declining an offer does not hand off", () => {
  assert.equal(
    detectHandoff([user("hi"), bot(OFFER), user("no thanks, just browsing")]),
    false,
  );
  assert.equal(
    detectHandoff([user("hi"), bot(OFFER), user("Not right now")]),
    false,
  );
});

test("an affirmative without a prior offer does not hand off", () => {
  assert.equal(
    detectHandoff([bot("Are you a business owner?"), user("yes")]),
    false,
  );
});

test("an affirmative that carries a follow-up question does not hand off", () => {
  assert.equal(
    detectHandoff([
      user("hi"),
      bot(OFFER),
      user(
        "ok but first, what are your rates and do you lend in California to newer businesses?",
      ),
    ]),
    false,
  );
});

const DECLINE_REPLY =
  "Unfortunately Spartan isn't able to fund cannabis or dispensary businesses, so I can't move this forward for you.";

test("excluded industry: explicit request for a specialist must NOT hand off", () => {
  const messages = [
    user("I own a cannabis dispensary doing $80k a month."),
    bot(DECLINE_REPLY),
    user("I want to talk to someone anyway"),
  ];

  // The visitor's words alone still read as a request — that's the trap.
  assert.equal(detectHandoff(messages), true);

  // ...but no lead may be created for a business Spartan just refused,
  // whether the signal comes from the model's tag or from the reply text.
  assert.equal(
    shouldHandoff({ messages, reply: DECLINE_REPLY, modelDeclined: true }),
    false,
  );
  assert.equal(shouldHandoff({ messages, reply: DECLINE_REPLY }), false);

  // Even if this turn's reply softens, the earlier decline still suppresses.
  assert.equal(
    shouldHandoff({ messages, reply: "I understand, but there's nothing I can set up here." }),
    false,
  );
});

test("a fundable visitor who accepts an offer still hands off", () => {
  const messages = [
    user("I run Ridgeline HVAC, 4 years in, about $50k/month. I need working capital."),
    bot("Would you like me to have a funding specialist reach out to go over your options?"),
    user("yes please"),
  ];
  assert.equal(
    shouldHandoff({
      messages,
      reply: "Great — what's the best email and phone for you?",
    }),
    true,
  );
});

test("declining to quote numbers is not a decline of the business", () => {
  const reply =
    "I can't give you a specific factor rate or payback figure — those depend on your actual business details.";
  assert.equal(isDeclineReply(reply), false);
  assert.equal(
    shouldHandoff({
      messages: [user("what rate would I get? can I talk to someone?")],
      reply,
    }),
    true,
  );
});

test("falling short of the guidelines is not a decline of the business", () => {
  const reply =
    "Right now that would be a stretch — Spartan typically looks for at least 12 months in business. A specialist may still see options.";
  assert.equal(isDeclineReply(reply), false);
  assert.equal(
    shouldHandoff({ messages: [user("can someone call me?")], reply }),
    true,
  );
});

test("isDeclineReply recognises the ways a decline gets phrased", () => {
  for (const reply of [
    "Spartan isn't able to fund pawn shops.",
    "We can't fund gambling businesses, unfortunately.",
    "Spartan doesn't fund non-profits.",
    "That's outside what we fund, I'm afraid.",
    "Vehicle dealerships fall into a category Spartan isn't able to support.",
  ]) {
    assert.equal(isDeclineReply(reply), true, reply);
  }
  assert.equal(isDeclineReply(""), false);
  assert.equal(isDeclineReply(undefined), false);
});

test("extracts contact and loan details from the visitor's own turns", () => {
  const fields = extractHandoffFields([
    user("Hi, my name is Dana Whitfield and I run a bakery."),
    bot("Nice to meet you. What are you looking to fund?"),
    user(
      "We need about $75,000 for new equipment and inventory. Email is dana@whitfieldbakery.com, phone 216-555-0142.",
    ),
  ]);

  assert.equal(fields.name, "Dana Whitfield");
  assert.equal(fields.email, "dana@whitfieldbakery.com");
  assert.equal(fields.phone, "(216) 555-0142");
  assert.equal(fields.loanAmount, "$75,000");
  assert.deepEqual(fields.loanPurpose, ["equipment", "inventory"]);
});

test("does not read a dollar figure as a phone number", () => {
  const fields = extractHandoffFields([
    user("We do about $1,250,000 a year in revenue and need $250,000."),
  ]);
  assert.equal(fields.phone, undefined);
  assert.equal(fields.loanAmount, "$250,000");
});

test("ignores figures that only the assistant mentioned", () => {
  const fields = extractHandoffFields([
    user("what can I get?"),
    bot("Some businesses look at $50,000 ranges, but I can't quote yours."),
  ]);
  assert.equal(fields.loanAmount, undefined);
});

test("returns an empty object when nothing was gathered", () => {
  assert.deepEqual(extractHandoffFields([user("do you fund trucking?")]), {
    loanPurpose: ["truck"],
  });
  assert.deepEqual(extractHandoffFields([user("hello there")]), {});
});

test("picks up a business name from \"I run <Name>\" but not from a generic noun", () => {
  assert.equal(
    extractHandoffFields([user("I run Whitfield Bakery in Cleveland.")]).businessName,
    "Whitfield Bakery",
  );
  assert.equal(
    extractHandoffFields([user("i own a small bakery")]).businessName,
    undefined,
  );
});

test("picks up a business name and a k-suffixed amount", () => {
  const fields = extractHandoffFields([
    user("My company is called Ridgeline HVAC, looking for 40k for payroll."),
  ]);
  assert.equal(fields.businessName, "Ridgeline HVAC");
  assert.equal(fields.loanAmount, "40k");
  assert.deepEqual(fields.loanPurpose, ["payroll"]);
});
