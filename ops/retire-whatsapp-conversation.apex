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
final String RETIRED   = LIVE_WAID + '-retired-' + Datetime.now().format('yyyyMMdd');

List<Conversation__c> found = [
    SELECT Id, Whatsapp_Wa_Id__c, Status__c, Channel__c, Lead__c, CreatedDate
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
System.debug('  Status        : ' + c.Status__c);
System.debug('  Channel       : ' + c.Channel__c);
System.debug('  Created       : ' + c.CreatedDate);
System.debug('  Message__c    : ' + msgCount + ' row(s) — retained, not deleted');
System.debug('=== WOULD APPLY ===');
System.debug('  Status__c        -> Closed');
System.debug('  Whatsapp_Wa_Id__c -> ' + RETIRED);

if (DRY_RUN) {
    System.debug('DRY RUN: nothing written. Set DRY_RUN = false to apply.');
    return;
}

c.Status__c = 'Closed';
c.Whatsapp_Wa_Id__c = RETIRED;
update c;

// -------------------------------------------------------------------------
// Verify: the live wa_id must now resolve to NOTHING, or the next inbound
// finds the old thread again and the whole exercise was pointless.
// -------------------------------------------------------------------------
List<Conversation__c> stillLive = [
    SELECT Id, Status__c FROM Conversation__c WHERE Whatsapp_Wa_Id__c = :LIVE_WAID
];

System.debug('=== AFTER ===');
System.debug('  retired record : ' + c.Id + ' status=' + c.Status__c +
             ' wa_id=' + c.Whatsapp_Wa_Id__c);
System.debug('  Message__c kept: ' +
             [SELECT COUNT() FROM Message__c WHERE Conversation__c = :CONV_ID]);

if (stillLive.isEmpty()) {
    System.debug('PASS: no conversation holds ' + LIVE_WAID +
                 ' any more. The next inbound from that phone starts a FRESH thread.');
} else {
    System.debug(LoggingLevel.ERROR,
        'FAIL: ' + stillLive.size() + ' conversation(s) still hold ' + LIVE_WAID +
        ' — the next inbound will land on one of them: ' + stillLive);
}
