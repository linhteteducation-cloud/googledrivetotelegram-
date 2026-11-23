# TeleDrive Firestore Security Specification

## Data Invariants
1. Every document under `/users/{userId}/...` is strictly owned by `userId`, and `request.auth.uid == userId`, `request.auth.token.email_verified == true`, and Admin/Approved User status (`isApprovedUser()`) must hold for reads and writes.
2. Only the bootstrapped primary admin (`linhteteducation@gmail.com` with `email_verified == true`) can list, approve, revoke, or delete entries in `/allowedEmails` and `/userAccess`.
3. Non-admin users can read only their own `/userAccess/{uid}` and their own `/allowedEmails/{emailHash}` (verified by SHA-256 hash and `email == request.auth.token.email`), and can only self-activate `status: 'approved'` when a matching `approved` document exists in `/allowedEmails`.
4. All document IDs (`userId`, `settingId`, `pdfKey`, `activityId`) and reference IDs (`ownerId`, `targetFolderId`, `fileId`, `fileUniqueId`, `driveFileId`, `uploadedFolderId`) must match `^[a-zA-Z0-9_\-]+$` (or empty when optional) and respect strict `maxLength` bounds.
5. `ownerId`, `uid`, `email`, `emailHash`, and `createdAt` are immutable after document creation.
6. `createdAt` and `updatedAt` MUST equal `request.time` on creation/update; client-forged timestamps are rejected.
7. Every write enforces strict exact-key allowlists (`hasAll` + `hasOnly` on create, `affectedKeys().hasOnly(...)` on update) so shadow fields are always rejected.
8. `ActivityLogEntry` documents are immutable once created (`allow update: if false`).

## Dirty Dozen Adversarial Payloads (Expected: PERMISSION_DENIED)
1. **Unauthenticated read/list** on `/users/uid1/pdfs` without `request.auth`.
2. **Unverified email write** (`request.auth.token.email_verified == false`) creating `/users/uid1/settings/workspace`.
3. **Cross-tenant read/list** by `uid2` querying `/users/uid1/pdfs`.
4. **Cross-tenant create** by `uid2` writing `/users/uid1/pdfs/doc1` with `ownerId: "uid2"`.
5. **Identity spoofing** by `uid1` creating `/users/uid1/pdfs/doc1` with `ownerId: "uid2"`.
6. **Shadow field injection (Ghost field)** creating `/users/uid1/settings/workspace` with extra `{ isAdmin: true }`.
7. **ID poisoning** creating `/users/uid1/pdfs/bad$id` with invalid characters or 1KB document ID.
8. **Immutable field tampering** updating `ownerId` or `createdAt` on `/users/uid1/settings/workspace`.
9. **Client-forged timestamp** creating `/users/uid1/activities/act1` with a past `createdAt` timestamp instead of `request.time`.
10. **Activity log mutation** attempting `update` on `/users/uid1/activities/act1`.
11. **Oversized string DoS** setting `caption` > 1000 chars or `fileName` > 255 chars on `TelegramPdfRecord`.
12. **Invalid enum shortcut** setting `status: "deleted"` or `namingRule: "hack"` outside allowed enums.
