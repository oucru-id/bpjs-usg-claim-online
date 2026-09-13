$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$sourceRoot = Join-Path $projectRoot 'src'
$requiredFiles = @(
  'appsscript.json', 'Main.gs', 'Config.gs', 'AuthService.gs',
  'SheetRepository.gs', 'UserService.gs', 'AuditService.gs',
  'SetupService.gs', 'SystemService.gs', 'TestService.gs', 'PasswordAuthService.gs',
  'ClaimService.gs', 'DocumentService.gs', 'PdfService.gs', 'TokenService.gs', 'DriveService.gs', 'OrthancBridgeService.gs',
  'Utils.gs', 'Index.html', 'AccessDenied.html', 'Styles.html', 'Scripts.html',
  'Components.html', 'VendorQrCode.html'
)

$failures = New-Object System.Collections.Generic.List[string]
foreach ($file in $requiredFiles) {
  if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot $file))) {
    $failures.Add("Missing required file: $file")
  }
}

$allSource = Get-ChildItem -LiteralPath $sourceRoot -File | Get-Content -Raw
$sourceText = $allSource -join "`n"
$functionMatches = [regex]::Matches($sourceText, '(?m)^function\s+([A-Za-z0-9_]+)\s*\(')
$duplicates = $functionMatches | ForEach-Object { $_.Groups[1].Value } | Group-Object | Where-Object Count -gt 1
foreach ($duplicate in $duplicates) {
  $failures.Add("Duplicate global Apps Script function: $($duplicate.Name)")
}
$prohibited = @('setSharing(', 'ANYONE_WITH_LINK', 'DriveApp.Access.ANYONE', 'tokeninfo')
foreach ($pattern in $prohibited) {
  if ($sourceText.Contains($pattern)) { $failures.Add("Prohibited source pattern: $pattern") }
}

if ($sourceText.Contains('Kata sandi awal wajib diisi.')) {
  $failures.Add('Obsolete required-initial-password validation is still present.')
}

$effectiveMatches = Select-String -Path (Join-Path $sourceRoot '*.gs') -SimpleMatch 'Session.getEffectiveUser()'
if ($effectiveMatches.Count -ne 1 -or $effectiveMatches[0].Path -notlike '*SetupService.gs') {
  $failures.Add('Session.getEffectiveUser() must appear exactly once, in SetupService.gs.')
}

$authSource = Get-Content -LiteralPath (Join-Path $sourceRoot 'AuthService.gs') -Raw
foreach ($required in @('Session.getActiveUser().getEmail()', 'requireAuthenticatedUser', 'requireRole', 'requirePermission', 'canAccessClaim')) {
  if (-not $authSource.Contains($required)) { $failures.Add("AuthService missing: $required") }
}

$htmlSource = Get-ChildItem -LiteralPath $sourceRoot -Filter '*.html' | Get-Content -Raw
$htmlText = $htmlSource -join "`n"
$clientSource = Get-Content -LiteralPath (Join-Path $sourceRoot 'Scripts.html') -Raw
if ($htmlText.Contains('PASSWORD_PEPPER')) {
  $failures.Add('Password pepper reference must not appear in HTML.')
}
$declaredIds = [regex]::Matches($htmlText, 'id="([A-Za-z0-9_-]+)"') | ForEach-Object { $_.Groups[1].Value }
$duplicateIds = $declaredIds | Group-Object | Where-Object Count -gt 1
foreach ($duplicateId in $duplicateIds) {
  $failures.Add("Duplicate HTML id: $($duplicateId.Name)")
}
$referencedIds = [regex]::Matches($htmlText, "getElementById\('([A-Za-z0-9_-]+)'\)") | ForEach-Object { $_.Groups[1].Value } | Select-Object -Unique
foreach ($referencedId in $referencedIds) {
  if ($declaredIds -notcontains $referencedId) {
    $failures.Add("Browser script references missing HTML id: $referencedId")
  }
}
$browserFunctions = [regex]::Matches($clientSource, '(?m)^\s*(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(') |
  ForEach-Object { $_.Groups[1].Value }
$directHandlers = [regex]::Matches($clientSource, 'addEventListener\s*\(\s*[''"][^''"]+[''"]\s*,\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\)') |
  ForEach-Object { $_.Groups[1].Value } | Select-Object -Unique
foreach ($handler in $directHandlers) {
  if ($browserFunctions -notcontains $handler) {
    $failures.Add("Browser event handler is not declared: $handler")
  }
}
if (-not $htmlText.Contains('<html lang="id">')) {
  $failures.Add('Main interface language must be Indonesian (lang=id).')
}

$configSource = Get-Content -LiteralPath (Join-Path $sourceRoot 'Config.gs') -Raw
$passwordSource = Get-Content -LiteralPath (Join-Path $sourceRoot 'PasswordAuthService.gs') -Raw
$mainSource = Get-Content -LiteralPath (Join-Path $sourceRoot 'Main.gs') -Raw
foreach ($requiredSessionFeature in @(
  "localStorage.getItem(SESSION_STORAGE_KEY)",
  "localStorage.setItem(SESSION_STORAGE_KEY, token)",
  "localStorage.removeItem(SESSION_STORAGE_KEY)",
  "sessionStorage.getItem(SESSION_STORAGE_KEY)"
)) {
  if (-not $clientSource.Contains($requiredSessionFeature)) {
    $failures.Add("Persistent browser session flow missing: $requiredSessionFeature")
  }
}
foreach ($requiredPasswordFeature in @(
  "MIN_LENGTH: 6",
  "DEFAULT_INITIAL_PASSWORD: 'admin123'",
  "'must_change_password'",
  'function changeOwnPassword',
  'must_change_password: true',
  'must_change_password: false',
  'PASSWORD_CHANGE_REQUIRED'
)) {
  if (-not $sourceText.Contains($requiredPasswordFeature)) {
    $failures.Add("Temporary-password flow missing: $requiredPasswordFeature")
  }
}
foreach ($requiredDocumentManagementFeature in @(
  'function updateDocumentSelection',
  'function reorderDocuments',
  'function rotateDocument',
  'batchUpdateDocumentOrder_',
  'DOCUMENT_SELECTION_UPDATED',
  'DOCUMENTS_REORDERED',
  'DOCUMENT_ROTATED',
  "callServer('updateDocumentSelection'",
  "callServer('reorderDocuments'",
  "serverPromise('rotateDocument'"
)) {
  if (-not $sourceText.Contains($requiredDocumentManagementFeature)) {
    $failures.Add("Document management flow missing: $requiredDocumentManagementFeature")
  }
}
foreach ($requiredPdfFeature in @(
  'function getPdfPreparation',
  'function generateClaimPdf',
  'function getFinalPdfForPreview',
  'function downloadFinalPdf',
  'function completeClaim',
  'function reopenClaim',
  'DocumentApp.create(',
  ".getAs(MimeType.PDF)",
  "getClaimSubfolder_(claim, 'OUTPUT')",
  'confirmed_same_patient',
  'PDF_GENERATED',
  'PDF_PREVIEWED',
  'PDF_DOWNLOADED',
  'CLAIM_COMPLETED',
  'CLAIM_REOPENED'
)) {
  if (-not $sourceText.Contains($requiredPdfFeature)) {
    $failures.Add("PDF workflow missing: $requiredPdfFeature")
  }
}
if (-not $mainSource.Contains('mustChangePassword: Boolean(user._mustChangePassword)')) {
  $failures.Add('Bootstrap does not expose the mandatory password-change state.')
}
if (-not $clientSource.Contains("callServer('changeOwnPassword'")) {
  $failures.Add('Browser does not call the mandatory password-change endpoint.')
}
foreach ($requiredDeleteFeature in @(
  'function deleteUserAdmin',
  'SELF_DELETE_BLOCKED',
  'USER_HAS_ACTIVITY',
  "callServer('deleteUserAdmin'"
)) {
  if (-not $sourceText.Contains($requiredDeleteFeature)) {
    $failures.Add("User-deletion flow missing: $requiredDeleteFeature")
  }
}
foreach ($requiredUploadFeature in @(
  'function uploadDocument',
  'function uploadMobileDocument',
  'function getDocumentThumbnail',
  'function getDocumentPreview',
  'function deleteDocument',
  'function createMobileUploadToken',
  'function getMobileUploadContext',
  'function finishMobileUpload',
  'DUPLICATE_DOCUMENT',
  'sha256Hex_',
  'mobile_upload_token_hash: tokenHash',
  'capture="environment"',
  'canvas.toBlob',
  "qrcode(0, 'M')"
)) {
  if (-not $sourceText.Contains($requiredUploadFeature)) {
    $failures.Add("Phase 3 upload flow missing: $requiredUploadFeature")
  }
}
foreach ($requiredSingleFacilityFeature in @(
  "['ENABLE_MOBILE_QR_UPLOAD', 'false'",
  'data-claim-document-type="KTP"',
  'data-claim-document-type="BUKU_KIA"',
  'data-claim-document-type="SPP_FKPP_BPJS"',
  'data-claim-document-type="OTHER"',
  "serverPromise('uploadDocument', [payload])",
  'mobile_qr_upload: getBooleanSetting_'
)) {
  if (-not $sourceText.Contains($requiredSingleFacilityFeature)) {
    $failures.Add("Single-Puskesmas upload flow missing: $requiredSingleFacilityFeature")
  }
}
foreach ($requiredHdAndNikFeature in @(
  'function mobileHdDimensions',
  'function assertMobileHdDimensions_',
  'MOBILE_IMAGE_DIMENSIONS_EXCEEDED',
  "maximumWidth = landscape ? 1280 : 720",
  "maximumHeight = landscape ? 720 : 1280",
  "document.getElementById('claim-detail-nik').textContent = claim.patient_nik;",
  "document.getElementById('pdf-confirm-nik').textContent = state.currentClaim.patient_nik;",
  'claim.patient_nik_masked,',
  "appendPdfCoverField_(body, 'NIK', normalizeString_(claim.patient_nik));"
)) {
  if (-not $sourceText.Contains($requiredHdAndNikFeature)) {
    $failures.Add("HD mobile upload or authorized full-NIK flow missing: $requiredHdAndNikFeature")
  }
}
foreach ($requiredOrthancFeature in @(
  'function doPost',
  'function receiveOrthancBridgeRequest_',
  'function authenticateOrthancBridge_',
  'ORTHANC_BRIDGE_SECRET_HASH',
  'ORTHANC_INBOX_FOLDER_ID',
  'ORTHANC_INBOX:',
  'ORTHANC_IMAGES:',
  "ORTHANC_IMPORT: 'ORTHANC_IMPORT'",
  'function listOrthancInbox',
  'function getOrthancInboxDetail',
  'function getOrthancInboxThumbnail',
  'function createClaimFromOrthanc',
  'function rejectOrthancInbox',
  'ORTHANC_PATIENT_CONFIRMATION_REQUIRED',
  "callServer('listOrthancInbox'",
  "callServer('createClaimFromOrthanc'",
  'data-orthanc-image-id',
  'Kotak Masuk Orthanc'
)) {
  if (-not $sourceText.Contains($requiredOrthancFeature)) {
    $failures.Add("OrthancBridge flow missing: $requiredOrthancFeature")
  }
}
if ($clientSource.Contains("document.getElementById('claim-detail-nik').textContent = claim.patient_nik_masked;")) {
  $failures.Add('Authorized claim detail still masks the NIK.')
}
$pdfSource = Get-Content -LiteralPath (Join-Path $sourceRoot 'PdfService.gs') -Raw
if ($pdfSource.Contains("appendPdfCoverField_(body, 'NIK', maskNik(claim.patient_nik));")) {
  $failures.Add('Generated PDF cover still masks the NIK.')
}
if ($sourceText.Contains('drive.google.com/file/d/')) {
  $failures.Add('Direct Drive file URLs must not be exposed to staff.')
}
if (-not $mainSource.Contains("'mobile'")) {
  $failures.Add('Main route does not allow the mobile upload view.')
}
foreach ($requiredMigrationFeature in @(
  'SCHEMA_UNKNOWN_COLUMN',
  'SCHEMA_DUPLICATE_COLUMN',
  'SCHEMA_BLANK_COLUMN_AMBIGUOUS',
  'migratedHeaders: true',
  'existingIndexes'
)) {
  if (-not $sourceText.Contains($requiredMigrationFeature)) {
    $failures.Add("Safe schema migration missing: $requiredMigrationFeature")
  }
}
foreach ($requiredClaimFeature in @(
  'function listClaims',
  'function getClaimDetail',
  'function createClaim',
  'function updateClaim',
  'function startClaimDocumentCollection',
  'function archiveClaim',
  'requireAccessibleClaim_',
  'maskPatientName(claim.patient_name)',
  'maskNik(claim.patient_nik)',
  "callServer('listClaims'",
  "'updateClaim' : 'createClaim'",
  "callServer('archiveClaim'"
)) {
  if (-not $sourceText.Contains($requiredClaimFeature)) {
    $failures.Add("Phase 2 claim flow missing: $requiredClaimFeature")
  }
}

$manifest = Get-Content -LiteralPath (Join-Path $sourceRoot 'appsscript.json') -Raw | ConvertFrom-Json
if ($manifest.timeZone -ne 'Asia/Makassar') { $failures.Add('Manifest timezone is not Asia/Makassar.') }
if ($manifest.runtimeVersion -ne 'V8') { $failures.Add('Manifest runtime is not V8.') }
if ($manifest.oauthScopes -contains 'https://www.googleapis.com/auth/script.external_request') {
  $failures.Add('Manifest still contains the unused external-request OAuth scope.')
}
if ($manifest.oauthScopes -notcontains 'https://www.googleapis.com/auth/documents') {
  $failures.Add('Manifest must include the Google Documents scope for PDF generation.')
}

if ($failures.Count -gt 0) {
  $failures | ForEach-Object { Write-Error $_ }
  exit 1
}

Write-Output "Static checks passed: $($requiredFiles.Count) required files, prohibited-sharing scan, identity boundary, auth helpers, and manifest."
