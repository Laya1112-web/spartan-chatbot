/**
 * The field vocabulary for the partner onboarding form: which of the ~67 flat
 * keys belongs to which of the seven sections, and what each is called in the
 * notification email.
 *
 * This lives in its own module, and is pure data plus one pure renderer, for
 * the same reason leadHandoff.js is separate in spartan-chatbot: it is the part
 * most likely to change (a label reworded, a field added to the form) and the
 * part worth testing without an AWS account.
 *
 * THE RENDERER NEVER DROPS A FIELD.
 *
 * That is the whole design constraint here. This map was reconstructed from the
 * spec's three named keys (iso_legal, owner_name, owner_email) and the standard
 * shape of an ISO partner packet -- it has NOT been diffed against the live
 * form. So a key the form sends that is missing from this map must still reach
 * the reader, or a wrong guess in this file silently loses data, which is the
 * exact failure this project exists to eliminate. Unmapped keys are therefore
 * collected into a trailing "Additional Fields" section rather than skipped.
 *
 * Fixing a label or moving a field between sections is a one-line edit here and
 * changes nothing else. Confirm SECTIONS against the real form before go-live;
 * until then the email is correct but its grouping is a best guess.
 *
 * ESM, matching the rest of this function ("type": "module" in package.json).
 */

/**
 * The seven sections, in the order the form presents them and the order the
 * email prints them. Each entry lists its field keys in display order; the
 * value is the label printed to the left of the colon.
 */
export const SECTIONS = [
  {
    title: "ISO / Company Information",
    fields: {
      iso_legal: "Legal Business Name",
      iso_dba: "DBA / Trade Name",
      iso_entity_type: "Entity Type",
      iso_ein: "EIN / Tax ID",
      iso_date_established: "Date Established",
      iso_state_incorporated: "State of Incorporation",
      iso_website: "Website",
      iso_years_in_industry: "Years in Industry",
      iso_num_employees: "Number of Employees",
      iso_num_sales_reps: "Number of Sales Reps",
    },
  },
  {
    title: "Business Address",
    fields: {
      address_street: "Street Address",
      address_suite: "Suite / Unit",
      address_city: "City",
      address_state: "State",
      address_zip: "ZIP Code",
      address_country: "Country",
      mailing_same_as_physical: "Mailing Address Same as Physical",
      mailing_street: "Mailing Street",
      mailing_city: "Mailing City",
      mailing_state: "Mailing State",
      mailing_zip: "Mailing ZIP",
    },
  },
  {
    title: "Ownership & Principals",
    fields: {
      owner_name: "Owner / Principal Name",
      owner_title: "Title",
      owner_email: "Owner Email",
      owner_phone: "Owner Phone",
      owner_mobile: "Owner Mobile",
      owner_ownership_pct: "Ownership %",
      owner_dob: "Date of Birth",
      owner_ssn_last4: "SSN (Last 4)",
      owner_home_address: "Home Address",
      owner_home_city: "Home City",
      owner_home_state: "Home State",
      owner_home_zip: "Home ZIP",
      second_owner_name: "Second Owner Name",
      second_owner_email: "Second Owner Email",
      second_owner_phone: "Second Owner Phone",
      second_owner_ownership_pct: "Second Owner Ownership %",
    },
  },
  {
    title: "Primary Contact",
    fields: {
      contact_name: "Contact Name",
      contact_title: "Contact Title",
      contact_email: "Contact Email",
      contact_phone: "Contact Phone",
      contact_preferred_method: "Preferred Contact Method",
      accounting_contact_name: "Accounting Contact",
      accounting_contact_email: "Accounting Contact Email",
      accounting_contact_phone: "Accounting Contact Phone",
    },
  },
  {
    title: "Business Operations",
    fields: {
      products_offered: "Products Offered",
      monthly_submission_volume: "Monthly Submission Volume",
      monthly_funded_volume: "Monthly Funded Volume",
      average_deal_size: "Average Deal Size",
      primary_industries: "Primary Industries Served",
      lead_sources: "Lead Sources",
      current_funding_partners: "Current Funding Partners",
      states_operating: "States of Operation",
      how_heard: "How Did You Hear About Us",
      referred_by: "Referred By",
    },
  },
  {
    title: "Banking & Commission",
    fields: {
      bank_name: "Bank Name",
      bank_account_name: "Account Holder Name",
      bank_account_last4: "Account Number (Last 4)",
      bank_routing_last4: "Routing Number (Last 4)",
      bank_account_type: "Account Type",
      payment_method: "Commission Payment Method",
      w9_on_file: "W-9 on File",
      commission_notes: "Commission Notes",
    },
  },
  {
    title: "Compliance & Agreement",
    fields: {
      licensed: "Licensed",
      license_numbers: "License Numbers",
      bankruptcy_history: "Bankruptcy History",
      litigation_history: "Litigation History",
      criminal_history: "Criminal History",
      background_check_consent: "Background Check Consent",
      agreement_accepted: "Agreement Accepted",
      agreement_version: "Agreement Version",
      signature_name: "Electronic Signature",
      signature_date: "Signature Date",
      signature_ip: "Signature IP",
      additional_notes: "Additional Notes",
    },
  },
];

/** Section used for any submitted key this map does not know about. */
const OVERFLOW_TITLE = "Additional Fields";

/** Keys added by the handler itself; printed in the footer, not the body. */
const ENVELOPE_KEYS = new Set(["id", "received_at", "source_ip"]);

/**
 * Treat null/undefined/'' (and whitespace-only) as absent, matching the
 * `present` helper in spartan-chatbot's leadHandoff.js. An absent optional
 * field is omitted from the email rather than printed as an empty label.
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
 * Turn a label into a fallback for an unmapped key: `iso_dba_name` reads as
 * "Iso Dba Name". Deliberately crude -- it only ever applies to keys this map
 * has not caught up with yet, and being readable matters more than being
 * pretty.
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
