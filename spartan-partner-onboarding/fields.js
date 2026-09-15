/**
 * The field vocabulary for the partner onboarding form: which of the form's
 * flat keys belongs to which of the six sections, and what each is called in
 * the notification email.
 *
 * This lives in its own module, and is pure data plus one pure renderer, for
 * the same reason leadHandoff.js is separate in spartan-chatbot: it is the part
 * most likely to change (a label reworded, a field added to the form) and the
 * part worth testing without an AWS account.
 *
 * SECTIONS below is the REAL map, taken from the revised form -- it replaces
 * the reconstruction this module shipped with. Two things changed with that
 * revision and are worth stating so neither is reintroduced by accident:
 *
 *   - Six sections, not seven.
 *   - The Background section is GONE. Bankruptcies, liens, judgements,
 *     criminal history and RBF notes are no longer collected, so no key and no
 *     header for any of them exists here. They must not appear in the email.
 *
 * THE RENDERER STILL NEVER DROPS A FIELD.
 *
 * Any key the form sends that is missing from this map is collected into a
 * trailing "Additional Fields" section rather than skipped. The map is accurate
 * today, but the form has already been revised once; when a field is added and
 * this file has not caught up, the reader still sees the value instead of the
 * submission silently losing it. That is the failure this function exists to
 * eliminate, so the fallback stays.
 *
 * ESM, matching the rest of this function ("type": "module" in package.json).
 */

/**
 * The six sections, in the order the form presents them and the order the
 * email prints them. Each entry lists its field keys in display order; the
 * value is the label printed to the left of the colon.
 */
export const SECTIONS = [
  {
    title: "Your Information",
    fields: {
      iso_legal: "ISO Legal Name",
      dba: "DBA Name",
      ein: "EIN / Tax ID",
      company_type: "Company Type",
      state_inc: "State of Incorporation",
      owner_name: "Owner Name",
      owner_phone: "Owner Phone",
      owner_email: "Owner Email",
      biz_street: "Business Street",
      biz_city: "City",
      biz_state: "State",
      biz_zip: "ZIP",
      mpoc_name: "MPOC Name",
      mpoc_email: "MPOC Email",
      mpoc_phone: "MPOC Phone",
      // Section 1's website field. Distinct from Section 6's `web_site`, which
      // carries the same value -- see the note on printing both, below.
      website: "Website",
      has_owner2: "Second Owner?",
      owner2_name: "Second Owner Name",
      owner2_title: "Second Owner Title",
      owner2_phone: "Second Owner Phone",
      owner2_email: "Second Owner Email",
      owner2_pct: "Second Owner Ownership %",
      has_location2: "Additional Locations?",
      loc2_street: "Location 2 Street",
      loc2_city: "Location 2 City",
      loc2_state: "Location 2 State",
      loc2_zip: "Location 2 ZIP",
      loc2_phone: "Location 2 Phone",
      loc2_manager: "Location 2 Manager",
      loc_additional: "Further Locations",
    },
  },
  {
    title: "Your Business",
    fields: {
      time_in_business: "Time in Business",
      funders_count: "Funders Worked With",
      top_funders: "Top Funders",
      inhouse_funding: "In-House Funding on Balance Sheet",
      white_label: "White-Label Agreements",
      reps_in_office: "Reps in Office",
    },
  },
  {
    title: "Volume",
    fields: {
      spartan_monthly_target: "Monthly Target with Spartan",
      submissions_month: "Submissions per Month",
      avg_volume_month: "Average Monthly Volume",
      apps_month: "Applications per Month",
      paper_a: "Paper Mix A %",
      paper_b: "Paper Mix B %",
      paper_c: "Paper Mix C %",
    },
  },
  {
    // Every field in this section is a percentage.
    title: "Lead Sources",
    fields: {
      src_packages: "Complete Packages",
      src_press1: "Press-1 / Live Transfer",
      src_paid: "Paid Search & Social",
      src_ucc: "UCC / Aged",
      src_mailers: "Mailers",
      src_lender: "Lender-Supplied",
      src_sms_email: "SMS / Email",
      src_marketplace: "Marketplace",
    },
  },
  {
    title: "Strategy",
    fields: {
      want_from_funder: "Wants From a Funder",
      outreach_strategy: "Outreach Strategy",
      scrub_method: "Scrubbing Method",
      scrub_other: "Scrubbing — Other",
      outside_partners: "Receives Outside Submissions",
      outside_pct: "Outside Submissions %",
      files_influenced: "Files Influenced By",
    },
  },
  {
    title: "Online Presence",
    fields: {
      // `web_site` deliberately duplicates Section 1's `website`: they are
      // distinct keys carrying the same value, and BOTH are printed. Collapsing
      // them would be this module quietly deciding the form is redundant, which
      // is not its call to make.
      web_site: "Website",
      web_facebook: "Facebook",
      web_instagram: "Instagram",
      web_linkedin: "LinkedIn",
      web_other: "Other",
    },
  },
];

/** Section used for any submitted key this map does not know about. */
const OVERFLOW_TITLE = "Additional Fields";

/** Keys added by the handler itself; printed in the footer, not the body. */
const ENVELOPE_KEYS = new Set(["id", "received_at", "source_ip"]);

/**
 * Treat null/undefined/'' (and whitespace-only) as absent, matching the
 * `present` helper in spartan-chatbot's leadHandoff.js.
 *
 * This is what keeps the reveal fields clean. owner2_*, loc2_*, loc_additional,
 * scrub_other and outside_pct are conditional on a Yes/No answer earlier in the
 * form, and a partner who answered No still submits them -- as empty strings.
 * Skipping absent values means the email shows "Second Owner? No" and then
 * moves on, rather than six blank labels the reader has to scroll past.
 */
function present(value) {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  return String(value).trim() !== "";
}

/** Render one value as a single-line string. Arrays join, objects stringify. */
function formatValue(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value).trim();
}

/**
 * Turn a key into a fallback label for an unmapped field: `some_new_field`
 * reads as "Some New Field". Deliberately crude -- it only ever applies to keys
 * this map has not caught up with yet, and being readable matters more than
 * being pretty.
 */
function humanize(key) {
  return String(key)
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Group a submitted lead into printable sections.
 *
 * Returns [{ title, lines: ["Label: value", ...] }], omitting sections that
 * ended up empty. Any present key not in SECTIONS lands in "Additional Fields"
 * with a humanized label -- see the no-dropped-fields note at the top.
 */
export function groupLead(lead) {
  const source = lead && typeof lead === "object" ? lead : {};
  const claimed = new Set();
  const groups = [];

  for (const section of SECTIONS) {
    const lines = [];

    for (const [key, label] of Object.entries(section.fields)) {
      claimed.add(key);
      if (!present(source[key])) continue;
      lines.push(`${label}: ${formatValue(source[key])}`);
    }

    if (lines.length > 0) groups.push({ title: section.title, lines });
  }

  const overflow = [];
  for (const key of Object.keys(source)) {
    if (claimed.has(key) || ENVELOPE_KEYS.has(key)) continue;
    if (!present(source[key])) continue;
    overflow.push(`${humanize(key)}: ${formatValue(source[key])}`);
  }

  if (overflow.length > 0) groups.push({ title: OVERFLOW_TITLE, lines: overflow });

  return groups;
}

/**
 * The email subject: the ISO's legal name when we have it, the owner's name
 * otherwise. Both are optional on the form -- only owner_email is required --
 * so that is the last fallback, guaranteeing the subject never trails off
 * after the em dash.
 */
export function buildSubject(lead) {
  const source = lead && typeof lead === "object" ? lead : {};

  const name =
    (present(source.iso_legal) && formatValue(source.iso_legal)) ||
    (present(source.owner_name) && formatValue(source.owner_name)) ||
    (present(source.owner_email) && formatValue(source.owner_email)) ||
    "Unknown Partner";

  return `Partner Onboarding Completed — ${name}`;
}

/**
 * The full plain-text email body: every submitted field as `Label: value`,
 * grouped by section, with the envelope (id, timestamp, source IP) and the S3
 * key at the bottom so a reader who needs the raw JSON knows exactly where it
 * is.
 */
export function buildEmailBody({ lead, id, receivedAt, sourceIp, bucket, key }) {
  const parts = ["Partner onboarding submission received.", ""];

  for (const group of groupLead(lead)) {
    parts.push(group.title.toUpperCase());
    parts.push("-".repeat(group.title.length));
    parts.push(...group.lines);
    parts.push("");
  }

  parts.push("SUBMISSION RECORD");
  parts.push("-".repeat(17));
  parts.push(`Submission ID: ${id}`);
  parts.push(`Received: ${receivedAt}`);
  if (present(sourceIp)) parts.push(`Source IP: ${sourceIp}`);
  parts.push(`S3 Bucket: ${bucket}`);
  parts.push(`S3 Key: ${key}`);

  return parts.join("\n");
}
