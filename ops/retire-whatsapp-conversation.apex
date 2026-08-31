/**
 * Retire the polluted WhatsApp test thread so the 848 number starts clean.
 *
 * RUN THIS IN SALESFORCE (Developer Console > Debug > Open Execute Anonymous
 * Window, or `sf apex run -f ops/retire-whatsapp-conversation.apex`).
 * It is deliberately NOT part of the Lambda: package.json's build copies an
 * explicit file list, so nothing in ops/ is ever bundled or deployed.
 *
 * ---------------------------------------------------------------------------
 * WHY CLOSING IS NOT ENOUGH — the reopen gotcha
 * ---------------------------------------------------------------------------
 * A WhatsApp conversation is keyed on the VISITOR's number, for ever:
 * Conversation__c.Whatsapp_Wa_Id__c is the external id the inbound path looks
 * up. And whatsappConversation.js ensureWhatsAppConversation REOPENS a Closed
 * thread on the next inbound rather than starting a new one:
 *
 *     if (isClosed(status)) { ...PATCH Status__c = 'New'... reopened = true }
 *
 * So setting Status__c = 'Closed' alone would achieve nothing: the next text
 * from this phone reopens this very record and replays all 19 mixed test, rep
 * and bot messages into the model exactly as before.
 *
 * The wa_id is therefore RELEASED as well as the thread closed. The lookup then
 * 404s, and the inbound path creates a genuinely fresh Conversation__c.
 *
 * ---------------------------------------------------------------------------
 * RELEASE BOTH KEYS — the 2026-08-31 near-miss
 * ---------------------------------------------------------------------------
 * Conversation__c has TWO unique keys that a WhatsApp thread occupies, and
 * releasing only one is worse than releasing neither:
 *
 *     Whatsapp_Wa_Id__c  '17323975063'      the inbound lookup key
 *     Session_Id__c      'wa:17323975063'   set on create by
 *                                           whatsappConversation.js
 *
 * The first run of this script released only the wa_id. The lookup duly 404'd,
 * so the inbound path tried to CREATE — and the create collided with the
 * retired record on Session_Id__c:
 *
 *     DUPLICATE_VALUE: Session_Id__c duplicates value on record with id: <retired>
 *
 * The bot still replied (from empty context), but no Conversation__c and no
 * Message__c were written. Every inbound from that phone was silently lost
 * until Session_Id__c was released too. Release both, and assert on both.
 *
 * ---------------------------------------------------------------------------
 * WHY RETIRE RATHER THAN DELETE
 * ---------------------------------------------------------------------------
 * Delete would cascade the 19 Message__c children and destroy the only record
 * of the cutover testing — including the two out-of-order replies that
 * diagnosed the burst race. Retiring keeps the audit trail, is reversible, and
 * costs nothing. The wa_id is suffixed rather than blanked so a required-field
 * or uniqueness rule cannot reject the update, and so it stays obvious what the
 * record used to be.
 */

// ---------------------------------------------------------------------------
// Set to false to actually write. Leave true to see what WOULD happen.
// ---------------------------------------------------------------------------
Boolean DRY_RUN = true;

final Id    CONV_ID    = 'a3IVr000002No9RMAS';
final String LIVE_WAID = '17323975063';
final String SUFFIX    = '-retired-' + Datetime.now().format('yyyyMMdd');
final String RETIRED   = LIVE_WAID + SUFFIX;

// BOTH unique keys must be released, not just the wa_id. See the header note.
final String LIVE_SESSION    = 'wa:' + LIVE_WAID;
final String RETIRED_SESSION = 'wa:' + LIVE_WAID + SUFFIX;

List<Conversation__c> found = [
    SELECT Id, Whatsapp_Wa_Id__c, Session_Id__c, Status__c, Channel__c, Lead__c, CreatedDate
    FROM Conversation__c
    WHERE Id = :CONV_ID
];

if (found.isEmpty()) {
    System.debug(LoggingLevel.ERROR, 'ABORT: ' + CONV_ID + ' not found. Nothing changed.');
    return;
}

Conversation__c c = found[0];

// Guard: refuse to touch a record that is not the thread we mean.
if (c.Whatsapp_Wa_Id__c != LIVE_WAID) {
    System.debug(LoggingLevel.ERROR,
        'ABORT: expected Whatsapp_Wa_Id__c=' + LIVE_WAID +
        ' but found "' + c.Whatsapp_Wa_Id__c + '". Nothing changed.');
    return;
}

Integer msgCount = [SELECT COUNT() FROM Message__c WHERE Conversation__c = :CONV_ID];

System.debug('=== BEFORE ===');
System.debug('  Id            : ' + c.Id);
System.debug('  Whatsapp_Wa_Id: ' + c.Whatsapp_Wa_Id__c);
System.debug('  Session_Id    : ' + c.Session_Id__c);
System.debug('  Status        : ' + c.Status__c);
System.debug('  Channel       : ' + c.Channel__c);
System.debug('  Created       : ' + c.CreatedDate);
System.debug('  Message__c    : ' + msgCount + ' row(s) — retained, not deleted');
System.debug('=== WOULD APPLY ===');
System.debug('  Status__c        -> Closed');
System.debug('  Whatsapp_Wa_Id__c -> ' + RETIRED);
System.debug('  Session_Id__c     -> ' + RETIRED_SESSION);

if (DRY_RUN) {
    System.debug('DRY RUN: nothing written. Set DRY_RUN = false to apply.');
    return;
}

c.Status__c = 'Closed';
c.Whatsapp_Wa_Id__c = RETIRED;
c.Session_Id__c = RETIRED_SESSION;
update c;

// -------------------------------------------------------------------------
// Verify: the live wa_id must now resolve to NOTHING, or the next inbound
// finds the old thread again and the whole exercise was pointless.
// -------------------------------------------------------------------------
List<Conversation__c> stillLive = [
    SELECT Id, Status__c FROM Conversation__c WHERE Whatsapp_Wa_Id__c = :LIVE_WAID
];
List<Conversation__c> stillSession = [
    SELECT Id, Status__c FROM Conversation__c WHERE Session_Id__c = :LIVE_SESSION
];

System.debug('=== AFTER ===');
System.debug('  retired record : ' + c.Id + ' status=' + c.Status__c +
             ' wa_id=' + c.Whatsapp_Wa_Id__c +
             ' session=' + c.Session_Id__c);
System.debug('  Message__c kept: ' +
             [SELECT COUNT() FROM Message__c WHERE Conversation__c = :CONV_ID]);

if (!stillLive.isEmpty()) {
    System.debug(LoggingLevel.ERROR,
        'FAIL: ' + stillLive.size() + ' conversation(s) still hold ' + LIVE_WAID +
        ' — the next inbound will land on one of them: ' + stillLive);
} else if (!stillSession.isEmpty()) {
    // The blind spot that made a half-done retirement report PASS on
    // 2026-08-31: the wa_id was released but Session_Id__c was not, so the
    // create collided with DUPLICATE_VALUE and every inbound was dropped.
    System.debug(LoggingLevel.ERROR,
        'FAIL: wa_id is free but ' + stillSession.size() + ' conversation(s) still hold ' +
        LIVE_SESSION + ' — the create will die with DUPLICATE_VALUE on Session_Id__c ' +
        'and inbound turns will be LOST: ' + stillSession);
} else {
    System.debug('PASS: no conversation holds ' + LIVE_WAID + ' or ' + LIVE_SESSION +
                 ' any more. The next inbound from that phone starts a FRESH thread.');
}
