function writeAudit_(user, action, claimId, documentId, details) {
  try {
    appendRecord_('AUDIT_LOG', {
      audit_id: Utilities.getUuid(),
      timestamp: now_(),
      user_id: user ? user.user_id : '',
      user_email: user ? user.google_email : '',
      facility_id: user ? user.facility_id : '',
      claim_id: claimId || '',
      document_id: documentId || '',
      action: action,
      details_json: JSON.stringify(details || {})
    });
  } catch (auditError) {
    console.error(JSON.stringify({ code: 'AUDIT_WRITE_FAILED', message: auditError.message }));
  }
}
