# Rivu

[简体中文](README.md)

Rivu is a local-first RSS reader for Windows. Your feeds, articles, and reading state stay on your device by default, and the core reading experience needs no account.

![Rivu main window](docs/images/rivu-timeline.png)

*The screenshots use synthetic local data and contain no personal information. The current app interface is shown in Simplified Chinese.*

![Rivu first launch](docs/images/rivu-empty-library.png)

## Download

[Download the portable Windows x64 build](https://github.com/rowanjove/Rivu/releases/latest/download/Rivu-0.1.0-portable-win-x64.zip) · [SHA-256 checksum](https://github.com/rowanjove/Rivu/releases/latest/download/SHA256SUMS.txt) · [All releases](https://github.com/rowanjove/Rivu/releases)

Extract the full ZIP and run `Rivu.exe` from the extracted directory. This is a portable app directory, not a single-file executable or installer; keep the other files beside the executable.

The current release is not code-signed. Compare its SHA-256 value with the checksum file before running it.

## Features

- Subscribe to RSS, Atom, JSON Feed, and public JSON APIs; import and export OPML.
- Search, organize, bookmark, and mark articles as read in a timeline, with local full-text search and smart folders.
- Save articles and images for offline reading, or create permanent archives that can be exported separately.
- Back up and restore your local library. Backups exclude AI API keys by default.
- Optionally configure an OpenAI-compatible service for summaries, translation, chat, and classification suggestions. Manual requests show what will be sent and require confirmation; automatic rules require separate authorization.
- Read local `.eml` newsletters and view image, audio, and video links in articles.

## Data and privacy

Rivu does not require an account. The database, settings, and logs are stored under `%APPDATA%\rivu`; the local API binds only to `127.0.0.1`. Rivu makes no AI requests until you configure a provider. When enabled, article content is sent only for requests you confirm. If you authorize an automatic rule, later matching articles may be sent to that provider automatically.

Rivu does not provide cloud sync for your feeds. API keys are omitted from backups unless you explicitly choose to include them.

## Run from source

Development and builds require Node.js 24 and npm. Creating the Windows release package requires Windows.

```powershell
npm ci
npm run dev
```

Run the test suite and build the portable directory package:

```powershell
npm test
npm run dist:win
```

`npm run dist:win` performs type checking, builds the app, verifies the ZIP contents, and runs a packaged desktop smoke flow. Run the full suite separately with `npm test`.

## License

Rivu is licensed under the [Apache License 2.0](LICENSE). Third-party dependencies remain under their respective licenses; see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) and the full [third-party license texts](THIRD-PARTY-LICENSES.txt).
