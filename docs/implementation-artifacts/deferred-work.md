# Deferred Work

## Desktop lifecycle

- Add an explicit Electron single-instance policy. Multiple SeePal processes can
  currently contend for the existing SQLite database and, after the AI connector
  work, the global AI configuration file. This predates the connector and needs a
  focused lifecycle decision rather than a feature-local change.
