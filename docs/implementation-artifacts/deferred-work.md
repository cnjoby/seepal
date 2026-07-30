# Deferred Work

## Desktop lifecycle

- Add an explicit Electron single-instance policy. Multiple SeePal processes can
  currently contend for the existing SQLite database and, after the AI connector
  work, the global AI configuration file. This predates the connector and needs a
  focused lifecycle decision rather than a feature-local change.

## SeePal key storage hardening

- Add an explicit integration/e2e case for legacy synchronous `safeStorage` ciphertext
  migration to async decryption path and ensure compatibility across pre-existing
  installer generations.
- Capture full packaged-app evidence artifacts for all acceptance steps in this spec
  (DMG hash, mount evidence, and config snapshots before/after save and clear).
