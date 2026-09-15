/**
 * The optional SharePoint relay: a Power Automate flow that files the packet
 * into the team's document library.
 *
 * Two rules govern this module, both of them about staying out of the way:
 *
 *   1. If SHAREPOINT_FLOW_URL is unset or empty the relay is SKIPPED SILENTLY.
 *      Not a warning, not an error -- the flow is genuinely optional, and an
 *      environment that has not configured it is not misconfigured. Logging it
 *      as a problem would train whoever reads CloudWatch to ignore this
 *      function's logs.
 *
 *   2. A failure here NEVER fails the request. The submission is already in S3
 *      and the reviewers have already been emailed by the time this runs; a
 *      flow that is down, slow, or returning 500 is a SharePoint problem, not
 *      a reason to hand the submitter an error. Logged and swallowed.
 *
 * Uses the global fetch of the Node 20 runtime, as spartan-chatbot's
 * whatsapp.js does for the Meta Graph API -- no HTTP dependency.
 */

/**
 * How long to wait on the flow before giving up. Power Automate HTTP triggers
 * usually answer immediately, but they are not on the critical path here, so
 * the timeout is short: a hanging flow must not push this function toward its
 * own Lambda timeout and turn a successful submission into a client error.
 */
const FLOW_TIMEOUT_MS = 5000;

/**
 * Relay the lead to the flow. Resolves true when the flow accepted it, false
 * when it was skipped or failed; never throws.
 */
export async function relayToSharePoint({ url, lead, id }) {
  // Rule 1: unset means "not configured", which is a valid state, not a fault.
  if (!url || String(url).trim() === "") return false;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FLOW_TIMEOUT_MS);

  try {
    const response = await fetch(String(url).trim(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(lead),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.error("spartan-partner-onboarding: SharePoint relay rejected the submission", {
        id,
        status: response.status,
        detail: detail.slice(0, 500),
      });
      return false;
    }

    return true;
  } catch (error) {
    // Rule 2: logged, swallowed, request unaffected.
    console.error("spartan-partner-onboarding: SharePoint relay failed", {
      id,
      name: error?.name,
      message: error?.message,
    });
    return false;
  } finally {
    clearTimeout(timer);
  }
}
